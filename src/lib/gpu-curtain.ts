import { Geometry, Mesh, Program, RenderTarget, Renderer, Texture, Triangle } from 'ogl';
import { buildCurtainSeeds, type CurtainSeeds } from './curtain-seeds';
import type { FrameRect } from './sand-seeds';
import type { GpuCursor } from './gpu-sand';
import { CURTAIN_SIMULATION, CURTAIN_PARTICLE_VERTEX } from './curtain-particle-shaders';
import { PARTICLE_FRAGMENT, QUAD_VERTEX } from './sand-shaders';

/** Colored waterfall grains own their positions and velocities in float GPU textures. */
export class GpuCurtain {
  readonly count: number;
  readonly gravity = 981;
  private seeds!: CurtainSeeds;
  private imageWidth: number;
  private imageHeight: number;
  private read!: RenderTarget;
  private write!: RenderTarget;
  private compute!: Mesh;
  private points!: Mesh;
  private position!: { value: Texture };
  private velocity!: { value: Texture };
  private cursor = { value: new Float32Array([-1000, -1000, 10, 0]) };
  private previousCursor = { value: new Float32Array([-1000, -1000]) };
  private dt = { value: 1 / 120 };
  private dpr = { value: 1 };
  private time = { value: 0 };
  private targets: RenderTarget[] = [];
  private textures: Texture[] = [];
  private programs: Program[] = [];
  private geometries: Geometry[] = [];
  private disposed = false;

  constructor(private renderer: Renderer, image: HTMLImageElement, private rect: FrameRect,
    private width: number, private height: number) {
    this.count = width < 600 ? 32768 : 131072;
    this.imageWidth = image.naturalWidth; this.imageHeight = image.naturalHeight;
    try { this.initialise(image); this.reset(); } catch (error) { this.dispose(); throw error; }
  }

  private program(options: ConstructorParameters<typeof Program>[1]) {
    const program = new Program(this.renderer.gl, options); this.programs.push(program);
    if (!this.renderer.gl.getProgramParameter(program.program, this.renderer.gl.LINK_STATUS)) {
      throw new Error('Waterfall shader compilation failed');
    }
    return program;
  }

  private texture(data: Float32Array | Uint8Array, float: boolean) {
    const gl = this.renderer.gl as WebGL2RenderingContext;
    const texture = new Texture(this.renderer.gl, { image: data,
      width: this.seeds.textureWidth, height: this.seeds.textureHeight,
      format: gl.RGBA, internalFormat: float ? gl.RGBA32F : gl.RGBA8,
      type: float ? gl.FLOAT : gl.UNSIGNED_BYTE, minFilter: gl.NEAREST, magFilter: gl.NEAREST,
      generateMipmaps: false, flipY: false, unpackAlignment: 1 });
    this.textures.push(texture); return texture;
  }

  private initialise(image: HTMLImageElement) {
    const gl = this.renderer.gl as WebGL2RenderingContext;
    const sample = document.createElement('canvas'); sample.width = this.imageWidth; sample.height = this.imageHeight;
    const context = sample.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Unable to decode waterfall artwork');
    context.drawImage(image, 0, 0);
    this.seeds = buildCurtainSeeds(context.getImageData(0, 0, sample.width, sample.height).data,
      sample.width, sample.height, this.rect, this.count);
    const sources = this.texture(this.seeds.sources, true), flows = this.texture(this.seeds.flows, true);
    const colors = this.texture(this.seeds.colors, false);
    const artwork = new Texture(this.renderer.gl, { image, generateMipmaps: false, minFilter: gl.NEAREST, magFilter: gl.NEAREST });
    this.textures.push(artwork);
    for (let i = 0; i < 2; i++) {
      const target = new RenderTarget(this.renderer.gl, { width: this.seeds.textureWidth, height: this.seeds.textureHeight,
        color: 2, depth: false, stencil: false, type: gl.FLOAT, format: gl.RGBA, internalFormat: gl.RGBA32F,
        minFilter: gl.NEAREST, magFilter: gl.NEAREST });
      this.targets.push(target); this.renderer.bindFramebuffer({ buffer: target.buffer });
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Incomplete waterfall framebuffer');
    }
    this.renderer.bindFramebuffer(); this.read = this.targets[0]!; this.write = this.targets[1]!;
    this.position = { value: this.read.textures[0]! }; this.velocity = { value: this.read.textures[1]! };
    const quad = new Triangle(this.renderer.gl); this.geometries.push(quad);
    const viewport = { value: new Float32Array([this.width, this.height]) };
    const rect = { value: new Float32Array([this.rect.x, this.rect.y, this.rect.width, this.rect.height]) };
    this.compute = new Mesh(this.renderer.gl, { geometry: quad, program: this.program({
      vertex: QUAD_VERTEX, fragment: CURTAIN_SIMULATION, depthTest: false, depthWrite: false, cullFace: false,
      uniforms: { uPositions: this.position, uVelocities: this.velocity, uSources: { value: sources }, uFlows: { value: flows },
        uViewport: viewport, uRect: rect, uCursor: this.cursor, uPreviousCursor: this.previousCursor, uDt: this.dt,
        uGravity: { value: this.gravity }, uRestitution: { value: .76 } } }) });
    const geometry = new Geometry(this.renderer.gl, { particleIndex: { size: 2, data: this.seeds.indices } });
    geometry.setDrawRange(0, this.count); this.geometries.push(geometry);
    const program = this.program({ vertex: CURTAIN_PARTICLE_VERTEX, fragment: PARTICLE_FRAGMENT,
      transparent: true, depthTest: false, depthWrite: false, cullFace: false,
      uniforms: { uPositions: this.position, uVelocities: this.velocity, uSources: { value: sources }, uColors: { value: colors },
        uArtwork: { value: artwork }, uViewport: viewport, uDpr: this.dpr, uTime: this.time,
        uDiameterScale: { value: this.width < 600 ? 4.5 : 3.6 },
        uRect: rect } });
    // Preserve the source hues when grains overlap instead of adding them to white.
    program.setBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.points = new Mesh(this.renderer.gl, { geometry, program, mode: gl.POINTS });
  }

  reset() {
    if (this.disposed) return;
    this.time.value = 0; this.cursor.value[3] = 0;
    for (const target of this.targets) {
      target.textures[0]!.image = this.seeds.positions; target.textures[1]!.image = this.seeds.velocities;
      for (const texture of target.textures) { texture.needsUpdate = true; texture.update(); }
    }
  }

  step(dt: number, cursor: GpuCursor) {
    if (this.disposed || this.renderer.gl.isContextLost()) return;
    this.time.value += dt; this.dt.value = dt;
    this.cursor.value.set([cursor.x, cursor.y, cursor.radius, cursor.active ? 1 : 0]);
    this.previousCursor.value.set([cursor.previousX, cursor.previousY]);
    this.position.value = this.read.textures[0]!; this.velocity.value = this.read.textures[1]!;
    this.renderer.render({ scene: this.compute, target: this.write, clear: false, sort: false, frustumCull: false });
    const previous = this.read; this.read = this.write; this.write = previous;
  }

  drawParticles(target: RenderTarget, pixelRatio: number) {
    if (this.disposed || this.renderer.gl.isContextLost()) return;
    this.position.value = this.read.textures[0]!; this.velocity.value = this.read.textures[1]!;
    this.dpr.value = pixelRatio;
    this.renderer.render({ scene: this.points, target, clear: true, sort: false, frustumCull: false });
  }

  snapshotForVerification() {
    const gl = this.renderer.gl as WebGL2RenderingContext, previous = this.renderer.state.framebuffer;
    const positions = new Float32Array(this.seeds.positions.length), velocities = new Float32Array(this.seeds.velocities.length);
    this.renderer.bindFramebuffer({ buffer: this.read.buffer });
    gl.readBuffer(gl.COLOR_ATTACHMENT0); gl.readPixels(0, 0, this.seeds.textureWidth, this.seeds.textureHeight, gl.RGBA, gl.FLOAT, positions);
    gl.readBuffer(gl.COLOR_ATTACHMENT1); gl.readPixels(0, 0, this.seeds.textureWidth, this.seeds.textureHeight, gl.RGBA, gl.FLOAT, velocities);
    gl.readBuffer(gl.COLOR_ATTACHMENT0); this.renderer.bindFramebuffer({ buffer: previous });
    return { positions, velocities, sources: this.seeds.sources.slice(), colors: this.seeds.colors.slice(),
      flows: this.seeds.flows.slice(), count: this.count, rect: { ...this.rect },
      imageWidth: this.imageWidth, imageHeight: this.imageHeight, gravity: this.gravity };
  }

  setParticleForVerification(index: number, position: number[], velocity: number[]) {
    if (index < 0 || index >= this.count) throw new Error('Invalid waterfall particle index');
    const gl = this.renderer.gl as WebGL2RenderingContext;
    const x = index % this.seeds.textureWidth, y = Math.floor(index / this.seeds.textureWidth);
    for (const [attachment, data] of [position, velocity].entries()) {
      const texture = this.read.textures[attachment]!;
      this.renderer.activeTexture(0); texture.update(0); texture.bind();
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, 1, 1, gl.RGBA, gl.FLOAT, new Float32Array(data));
    }
  }

  dispose() {
    if (this.disposed) return; this.disposed = true;
    if (this.renderer.gl.isContextLost()) return;
    this.renderer.bindFramebuffer();
    for (const geometry of this.geometries) geometry.remove();
    for (const program of this.programs) {
      program.remove(); this.renderer.gl.deleteShader(program.vertexShader); this.renderer.gl.deleteShader(program.fragmentShader);
    }
    for (const texture of this.textures) this.renderer.gl.deleteTexture(texture.texture);
    for (const target of this.targets) {
      for (const texture of target.textures) this.renderer.gl.deleteTexture(texture.texture);
      this.renderer.gl.deleteFramebuffer(target.buffer);
    }
  }
}
