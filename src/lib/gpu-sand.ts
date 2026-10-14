import { Geometry, Mesh, Program, RenderTarget, Renderer, Texture, Triangle } from 'ogl';
import { buildParticleSeeds, buildSparkSeeds, type FrameRect, type ParticleSeeds, type SparkSeeds } from './sand-seeds';
import { PARTICLE_FRAGMENT, PARTICLE_VERTEX, QUAD_VERTEX, SIMULATION_FRAGMENT,
  SPARK_SIMULATION_FRAGMENT, SPARK_VERTEX } from './sand-shaders';
import { ParticleGlow } from './particle-glow';
import type { GpuCurtain } from './gpu-curtain';
import { getParticleQuality, type ParticleQuality } from './particle-quality';
import type { CurtainSeeds } from './curtain-seeds';

export type GpuCursor = { x: number; y: number; previousX: number; previousY: number; radius: number; active: boolean };
export type GpuSnapshot = { positions: Float32Array; velocities: Float32Array; impacts: Float32Array; count: number;
  sparks: { positions: Float32Array; velocities: Float32Array; count: number } };
type Uniform<T> = { value: T };

/** The GPU owns all evolving particle state. No per-frame particle loop or readback. */
export class GpuSand {
  readonly count: number;
  readonly sparkCount: number;
  readonly gravity = 981;
  readonly restitution = .76;
  time = 0;
  steps = 0;
  private gl: WebGL2RenderingContext;
  private seeds!: ParticleSeeds;
  private sparkSeeds!: SparkSeeds;
  private initialImpacts!: Float32Array;
  private read!: RenderTarget;
  private write!: RenderTarget;
  private compute!: Mesh;
  private particles!: Mesh;
  private sparkRead!: RenderTarget;
  private sparkWrite!: RenderTarget;
  private sparkCompute!: Mesh;
  private sparks!: Mesh;
  private glow?: ParticleGlow;
  private curtain?: GpuCurtain;
  private curtainPaused = false;
  private positionUniform!: Uniform<Texture>;
  private velocityUniform!: Uniform<Texture>;
  private computePosition!: Uniform<Texture>;
  private computeVelocity!: Uniform<Texture>;
  private computeImpact!: Uniform<Texture>;
  private impactUniform!: Uniform<Texture>;
  private sparkPosition!: Uniform<Texture>;
  private sparkVelocity!: Uniform<Texture>;
  private cursorUniform = { value: new Float32Array([-1000, -1000, 10, 0]) };
  private previousCursor = { value: new Float32Array([-1000, -1000]) };
  private deltaUniform = { value: 1 / 120 };
  private timeUniform = { value: 0 };
  private targets: RenderTarget[] = [];
  private sparkTargets: RenderTarget[] = [];
  private textures: Texture[] = [];
  private geometries: Geometry[] = [];
  private programs: Program[] = [];
  private disposed = false;
  private sparksActiveUntil = 0;

  constructor(private renderer: Renderer, image: HTMLImageElement, rect: FrameRect,
    private width: number, private height: number,
    private quality: ParticleQuality = getParticleQuality(width, height), prepared?: ParticleSeeds) {
    this.gl = renderer.gl as WebGL2RenderingContext;
    const gl = this.gl;
    if (!renderer.isWebgl2 || !gl.getExtension('EXT_color_buffer_float') ||
      gl.getParameter(gl.MAX_DRAW_BUFFERS) < 3 || gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) < 5) {
      throw new Error('Floating-point WebGL2 simulation is not supported');
    }
    this.count = quality.frameCount;
    this.sparkCount = quality.sparkCount;
    try { this.initialise(image, rect, prepared); }
    catch (error) { this.dispose(); throw error; }
  }

  private makeProgram(options: ConstructorParameters<typeof Program>[1]): Program {
    const program = new Program(this.renderer.gl, options);
    this.programs.push(program);
    if (!this.gl.getProgramParameter(program.program, this.gl.LINK_STATUS)) throw new Error('Particle shader compilation failed');
    return program;
  }

  private makeTexture(data: Float32Array | Uint8Array, isFloat: boolean,
    dimensions: Pick<ParticleSeeds, 'textureWidth' | 'textureHeight'> = this.seeds): Texture {
    const gl = this.gl;
    const texture = new Texture(this.renderer.gl, {
      image: data, width: dimensions.textureWidth, height: dimensions.textureHeight,
      format: gl.RGBA, internalFormat: isFloat ? gl.RGBA32F : gl.RGBA8,
      type: isFloat ? gl.FLOAT : gl.UNSIGNED_BYTE, minFilter: gl.NEAREST, magFilter: gl.NEAREST,
      generateMipmaps: false, flipY: false, unpackAlignment: 1,
    });
    this.textures.push(texture);
    return texture;
  }

  private makeStateTarget(dimensions: Pick<ParticleSeeds, 'textureWidth' | 'textureHeight'>, color: number, list: RenderTarget[]) {
    const gl = this.gl;
    const target = new RenderTarget(this.renderer.gl, {
      width: dimensions.textureWidth, height: dimensions.textureHeight,
      color, depth: false, stencil: false, type: gl.FLOAT, format: gl.RGBA,
      internalFormat: gl.RGBA32F, minFilter: gl.NEAREST, magFilter: gl.NEAREST,
    });
    list.push(target); this.renderer.bindFramebuffer({ buffer: target.buffer });
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Incomplete particle framebuffer');
    this.renderer.bindFramebuffer();
    return target;
  }

  private initialise(image: HTMLImageElement, rect: FrameRect, prepared?: ParticleSeeds) {
    const gl = this.gl;
    if (prepared) {
      this.seeds = prepared;
    } else {
    const sample = document.createElement('canvas');
    sample.width = image.naturalWidth; sample.height = image.naturalHeight;
    const context = sample.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Unable to decode the frame mask');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
    this.seeds = buildParticleSeeds(pixels, sample.width, sample.height, rect, this.count);
    }
    this.sparkSeeds = buildSparkSeeds(this.seeds);
    this.initialImpacts = new Float32Array(this.seeds.positions.length);
    for (let i = 2; i < this.initialImpacts.length; i += 4) this.initialImpacts[i] = -1;
    const sources = this.makeTexture(this.seeds.sources, true);
    const routes = this.makeTexture(this.seeds.routes, true);
    const colors = this.makeTexture(this.seeds.colors, false);
    const sparkSources = this.makeTexture(this.sparkSeeds.sources, true, this.sparkSeeds);
    for (let index = 0; index < 2; index++) {
      this.makeStateTarget(this.seeds, 3, this.targets);
      this.makeStateTarget(this.sparkSeeds, 2, this.sparkTargets);
    }
    this.renderer.bindFramebuffer();
    this.read = this.targets[0]!; this.write = this.targets[1]!;
    this.sparkRead = this.sparkTargets[0]!; this.sparkWrite = this.sparkTargets[1]!;
    this.reset();
    this.computePosition = { value: this.read.textures[0]! };
    this.computeVelocity = { value: this.read.textures[1]! };
    this.computeImpact = { value: this.read.textures[2]! };
    const viewport = { value: new Float32Array([this.width, this.height]) };
    const quad = new Triangle(this.renderer.gl); this.geometries.push(quad);
    const simulation = this.makeProgram({
      vertex: QUAD_VERTEX, fragment: SIMULATION_FRAGMENT, depthTest: false, depthWrite: false, cullFace: false,
      uniforms: {
        uPositions: this.computePosition, uVelocities: this.computeVelocity, uSources: { value: sources },
        uRoutes: { value: routes }, uImpacts: this.computeImpact,
        uViewport: viewport, uCursor: this.cursorUniform, uPreviousCursor: this.previousCursor,
        uDt: this.deltaUniform, uTime: this.timeUniform,
        uGravity: { value: this.gravity }, uRestitution: { value: this.restitution },
      },
    });
    this.compute = new Mesh(this.renderer.gl, { geometry: quad, program: simulation });
    this.positionUniform = { value: this.read.textures[0]! };
    this.velocityUniform = { value: this.read.textures[1]! };
    this.impactUniform = { value: this.read.textures[2]! };
    this.glow = new ParticleGlow(this.renderer, quad, this.width, this.height, this.quality);
    const pointProgram = this.makeProgram({
      vertex: PARTICLE_VERTEX, fragment: PARTICLE_FRAGMENT, transparent: true,
      depthTest: false, depthWrite: false, cullFace: false,
      uniforms: { uPositions: this.positionUniform, uVelocities: this.velocityUniform,
        uSources: { value: sources }, uColors: { value: colors }, uImpacts: this.impactUniform, uViewport: viewport,
        uDpr: { value: this.glow.pixelRatio }, uGravity: { value: this.gravity }, uTime: this.timeUniform,
      },
    });
    pointProgram.setBlendFunc(gl.ONE, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const pointGeometry = new Geometry(this.renderer.gl, { particleIndex: { size: 2, data: this.seeds.indices } });
    pointGeometry.setDrawRange(0, this.count); this.geometries.push(pointGeometry);
    this.particles = new Mesh(this.renderer.gl, { geometry: pointGeometry, program: pointProgram, mode: gl.POINTS });
    this.sparkPosition = { value: this.sparkRead.textures[0]! };
    this.sparkVelocity = { value: this.sparkRead.textures[1]! };
    const sparkSimulation = this.makeProgram({
      vertex: QUAD_VERTEX, fragment: SPARK_SIMULATION_FRAGMENT, depthTest: false, depthWrite: false, cullFace: false,
      uniforms: { uPositions: this.sparkPosition, uVelocities: this.sparkVelocity, uSources: { value: sparkSources },
        uImpacts: this.impactUniform, uCursor: this.cursorUniform, uPreviousCursor: this.previousCursor,
        uDt: this.deltaUniform, uGravity: { value: this.gravity }, uRestitution: { value: .55 } },
    });
    this.sparkCompute = new Mesh(this.renderer.gl, { geometry: quad, program: sparkSimulation });
    const sparkProgram = this.makeProgram({ vertex: SPARK_VERTEX, fragment: PARTICLE_FRAGMENT, transparent: true,
      depthTest: false, depthWrite: false, cullFace: false,
      uniforms: { uPositions: this.sparkPosition, uVelocities: this.sparkVelocity, uSources: { value: sparkSources },
        uViewport: viewport, uDpr: { value: this.glow.pixelRatio } } });
    sparkProgram.setBlendFunc(gl.ONE, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const sparkGeometry = new Geometry(this.renderer.gl, { particleIndex: { size: 2, data: this.sparkSeeds.indices } });
    sparkGeometry.setDrawRange(0, this.sparkCount); this.geometries.push(sparkGeometry);
    this.sparks = new Mesh(this.renderer.gl, { geometry: sparkGeometry, program: sparkProgram, mode: gl.POINTS });
  }

  get curtainCount() { return this.curtain?.count ?? 0; }

  setCurtainPaused(paused: boolean) { this.curtainPaused = paused; }

  async attachCurtain(image: HTMLImageElement, rect: FrameRect, prepared?: CurtainSeeds) {
    const { GpuCurtain: CurtainEngine } = await import('./gpu-curtain');
    if (this.disposed || this.gl.isContextLost()) throw new Error('Particle engine is no longer available');
    this.curtain?.dispose(); this.curtain = undefined;
    this.curtain = new CurtainEngine(this.renderer, image, rect, this.width, this.height, this.quality, prepared);
  }

  reset() {
    if (this.disposed) return;
    this.time = 0; this.steps = 0;
    this.sparksActiveUntil = 0;
    this.timeUniform.value = 0;
    this.curtain?.reset();
    for (const target of this.targets) {
      target.textures[0]!.image = this.seeds.positions;
      target.textures[1]!.image = this.seeds.velocities;
      target.textures[2]!.image = this.initialImpacts;
      for (const texture of target.textures) { texture.needsUpdate = true; texture.update(); }
    }
    for (const target of this.sparkTargets) {
      target.textures[0]!.image = this.sparkSeeds.positions;
      target.textures[1]!.image = this.sparkSeeds.velocities;
      for (const texture of target.textures) { texture.needsUpdate = true; texture.update(); }
    }
  }

  step(dt: number, cursor: GpuCursor) {
    if (this.disposed || this.gl.isContextLost()) return;
    this.time += dt; this.steps++;
    this.computePosition.value = this.read.textures[0]!;
    this.computeVelocity.value = this.read.textures[1]!;
    this.computeImpact.value = this.read.textures[2]!;
    this.cursorUniform.value[0] = cursor.x; this.cursorUniform.value[1] = cursor.y;
    this.cursorUniform.value[2] = cursor.radius; this.cursorUniform.value[3] = cursor.active ? 1 : 0;
    this.previousCursor.value[0] = cursor.previousX; this.previousCursor.value[1] = cursor.previousY;
    this.deltaUniform.value = dt; this.timeUniform.value = this.time;
    this.renderer.render({ scene: this.compute, target: this.write, clear: false, sort: false, frustumCull: false });
    const previous = this.read; this.read = this.write; this.write = previous;
    this.impactUniform.value = this.read.textures[2]!;
    this.sparkPosition.value = this.sparkRead.textures[0]!;
    this.sparkVelocity.value = this.sparkRead.textures[1]!;
    if (cursor.active) this.sparksActiveUntil = this.time + 2;
    if (this.time < this.sparksActiveUntil) {
      this.renderer.render({ scene: this.sparkCompute, target: this.sparkWrite, clear: false, sort: false, frustumCull: false });
      const previousSpark = this.sparkRead; this.sparkRead = this.sparkWrite; this.sparkWrite = previousSpark;
    }
    if (!this.curtainPaused) this.curtain?.step(dt, cursor);
  }

  draw(cursor: GpuCursor) {
    if (this.disposed || this.gl.isContextLost()) return;
    this.positionUniform.value = this.read.textures[0]!;
    this.velocityUniform.value = this.read.textures[1]!;
    this.impactUniform.value = this.read.textures[2]!;
    this.sparkPosition.value = this.sparkRead.textures[0]!;
    this.sparkVelocity.value = this.sparkRead.textures[1]!;
    this.cursorUniform.value[0] = cursor.x; this.cursorUniform.value[1] = cursor.y;
    this.cursorUniform.value[2] = cursor.radius; this.cursorUniform.value[3] = cursor.active ? 1 : 0;
    this.curtain?.drawParticles(this.glow!.particles, this.glow!.pixelRatio);
    this.renderer.render({ scene: this.particles, target: this.glow!.particles, clear: !this.curtain, sort: false, frustumCull: false });
    if (this.time < this.sparksActiveUntil) {
      this.renderer.render({ scene: this.sparks, target: this.glow!.particles, clear: false, sort: false, frustumCull: false });
    }
    this.glow!.draw();
  }

  /** GPU readback is explicitly opt-in, only exposed for ?sand-debug=1 verification. */
  snapshot(): GpuSnapshot {
    const gl = this.gl, previous = this.renderer.state.framebuffer;
    const positions = new Float32Array(this.seeds.positions.length), velocities = new Float32Array(this.seeds.velocities.length);
    const impacts = new Float32Array(this.initialImpacts.length);
    const sparkPositions = new Float32Array(this.sparkSeeds.positions.length), sparkVelocities = new Float32Array(this.sparkSeeds.velocities.length);
    this.renderer.bindFramebuffer({ buffer: this.read.buffer });
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, this.seeds.textureWidth, this.seeds.textureHeight, gl.RGBA, gl.FLOAT, positions);
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    gl.readPixels(0, 0, this.seeds.textureWidth, this.seeds.textureHeight, gl.RGBA, gl.FLOAT, velocities);
    gl.readBuffer(gl.COLOR_ATTACHMENT2);
    gl.readPixels(0, 0, this.seeds.textureWidth, this.seeds.textureHeight, gl.RGBA, gl.FLOAT, impacts);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    this.renderer.bindFramebuffer({ buffer: this.sparkRead.buffer });
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, this.sparkSeeds.textureWidth, this.sparkSeeds.textureHeight, gl.RGBA, gl.FLOAT, sparkPositions);
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    gl.readPixels(0, 0, this.sparkSeeds.textureWidth, this.sparkSeeds.textureHeight, gl.RGBA, gl.FLOAT, sparkVelocities);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    this.renderer.bindFramebuffer({ buffer: previous });
    return { positions, velocities, impacts, count: this.count,
      sparks: { positions: sparkPositions, velocities: sparkVelocities, count: this.sparkCount } };
  }

  sourcesForVerification() { return this.seeds.sources.slice(); }
  routesForVerification() { return this.seeds.routes.slice(); }
  glowForVerification(x: number, y: number) { return this.glow!.sampleForVerification(x, y, this.width, this.height); }
  curtainForVerification() { return this.curtain?.snapshotForVerification(); }
  setCurtainParticleForVerification(index: number, position: number[], velocity: number[]) {
    this.curtain?.setParticleForVerification(index, position, velocity);
  }

  setParticleForVerification(index: number, position: number[], velocity: number[]) {
    if (index < 0 || index >= this.count) throw new Error('Invalid particle index');
    const gl = this.gl, x = index % this.seeds.textureWidth, y = Math.floor(index / this.seeds.textureWidth);
    const arrays = [new Float32Array(position), new Float32Array(velocity)];
    for (let attachment = 0; attachment < 2; attachment++) {
      const texture = this.read.textures[attachment]!;
      this.renderer.activeTexture(0);
      texture.update(0);
      texture.bind();
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, 1, 1, gl.RGBA, gl.FLOAT, arrays[attachment]!);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.gl.isContextLost()) return;
    this.renderer.bindFramebuffer();
    this.glow?.dispose();
    this.curtain?.dispose();
    for (const geometry of this.geometries) geometry.remove();
    for (const program of this.programs) {
      program.remove(); this.gl.deleteShader(program.vertexShader); this.gl.deleteShader(program.fragmentShader);
    }
    for (const texture of this.textures) this.gl.deleteTexture(texture.texture);
    for (const target of [...this.targets, ...this.sparkTargets]) {
      for (const texture of target.textures) this.gl.deleteTexture(texture.texture);
      this.gl.deleteFramebuffer(target.buffer);
    }
  }
}
