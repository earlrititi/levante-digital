import { Mesh, Program, RenderTarget, Renderer, type Geometry, type Texture } from 'ogl';
import { QUAD_VERTEX } from './sand-shaders';
import { getParticleQuality, type ParticleQuality } from './particle-quality';

// The example's bloom settings, applied to the transparent particle layer.
const BLOOM_THRESHOLD = .01, BLOOM_WEIGHT = 2, CONTRAST = 2;

const BLUR_FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uInput;
uniform vec2 uDirection;
uniform float uThreshold;
in vec2 vUv;
out vec4 outColor;
vec4 tap(vec2 uv) {
  vec4 color = texture(uInput, uv);
  float light = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
  return color * max(0.0, light - uThreshold) / max(light, 0.00001);
}
void main() {
  vec4 color = tap(vUv) * 0.227027;
  color += (tap(vUv + uDirection * 1.384615) + tap(vUv - uDirection * 1.384615)) * 0.316216;
  color += (tap(vUv + uDirection * 3.230769) + tap(vUv - uDirection * 3.230769)) * 0.070270;
  outColor = color;
}
`;

const COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uParticles;
uniform sampler2D uBloom;
uniform float uWeight;
uniform float uContrast;
in vec2 vUv;
out vec4 outColor;
void main() {
  vec4 particles = texture(uParticles, vUv), bloom = texture(uBloom, vUv);
  float energy = particles.a + bloom.a * uWeight;
  float alpha = clamp(particles.a + bloom.a * 0.75, 0.0, 1.0);
  vec3 hdr = (particles.rgb + bloom.rgb * uWeight) / max(energy, 0.00001);
  vec3 mapped = 1.0 - exp(-hdr * 1.2);
  mapped = clamp((mapped - 0.5) * uContrast + 0.5, 0.0, 1.0);
  outColor = vec4(mapped * alpha, alpha);
}
`;

/** HDR, separable bloom and premultiplied compositing; no full hero image processing. */
export class ParticleGlow {
  readonly pixelRatio: number;
  readonly particles: RenderTarget;
  private horizontal: RenderTarget;
  private vertical: RenderTarget;
  private blur: Mesh;
  private composite: Mesh;
  private input!: { value: Texture };
  private direction = { value: new Float32Array(2) };
  private threshold = { value: BLOOM_THRESHOLD };
  private targets: RenderTarget[] = [];
  private programs: Program[] = [];

  constructor(private renderer: Renderer, quad: Geometry, width: number, height: number,
    quality: ParticleQuality = getParticleQuality(width, height)) {
    // Bound pixel cost on high-DPI displays while retaining soft, antialiased sprites.
    this.pixelRatio = Math.min(renderer.dpr, quality.pixelRatio);
    const w = Math.max(1, Math.round(width * this.pixelRatio)), h = Math.max(1, Math.round(height * this.pixelRatio));
    try {
      this.particles = this.target(w, h);
      this.horizontal = this.target(Math.max(1, Math.round(w * quality.bloomScale)), Math.max(1, Math.round(h * quality.bloomScale)));
      this.vertical = this.target(this.horizontal.width, this.horizontal.height);
      this.input = { value: this.particles.texture };
      const blur = this.program({ vertex: QUAD_VERTEX, fragment: BLUR_FRAGMENT,
        depthTest: false, depthWrite: false, cullFace: false,
        uniforms: { uInput: this.input, uDirection: this.direction, uThreshold: this.threshold } });
      this.blur = new Mesh(renderer.gl, { geometry: quad, program: blur });
      const composite = this.program({ vertex: QUAD_VERTEX, fragment: COMPOSITE_FRAGMENT,
        transparent: true, depthTest: false, depthWrite: false, cullFace: false,
        uniforms: { uParticles: { value: this.particles.texture }, uBloom: { value: this.vertical.texture },
          uWeight: { value: BLOOM_WEIGHT }, uContrast: { value: CONTRAST } } });
      composite.setBlendFunc(renderer.gl.ONE, renderer.gl.ONE_MINUS_SRC_ALPHA);
      this.composite = new Mesh(renderer.gl, { geometry: quad, program: composite });
    } catch (error) { this.dispose(); throw error; }
  }

  private program(options: ConstructorParameters<typeof Program>[1]) {
    const result = new Program(this.renderer.gl, options); this.programs.push(result);
    if (!this.renderer.gl.getProgramParameter(result.program, this.renderer.gl.LINK_STATUS)) throw new Error('Bloom shader compilation failed');
    return result;
  }

  private target(width: number, height: number) {
    const gl = this.renderer.gl as WebGL2RenderingContext;
    const target = new RenderTarget(this.renderer.gl, { width, height, depth: false,
      type: gl.HALF_FLOAT, format: gl.RGBA, internalFormat: gl.RGBA16F, minFilter: gl.LINEAR, magFilter: gl.LINEAR });
    this.targets.push(target);
    this.renderer.bindFramebuffer({ buffer: target.buffer });
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Incomplete bloom framebuffer');
    this.renderer.bindFramebuffer();
    return target;
  }

  draw() {
    this.input.value = this.particles.texture; this.threshold.value = BLOOM_THRESHOLD;
    this.direction.value.set([2 / this.horizontal.width, 0]);
    this.renderer.render({ scene: this.blur, target: this.horizontal, clear: true, sort: false, frustumCull: false });
    this.input.value = this.horizontal.texture; this.threshold.value = 0;
    this.direction.value.set([0, 2 / this.horizontal.height]);
    this.renderer.render({ scene: this.blur, target: this.vertical, clear: true, sort: false, frustumCull: false });
    this.renderer.render({ scene: this.composite, clear: true, sort: false, frustumCull: false });
  }

  /** Only called by opt-in browser verification; the regular draw loop never reads back. */
  sampleForVerification(x: number, y: number, viewportWidth: number, viewportHeight: number) {
    const gl = this.renderer.gl as WebGL2RenderingContext, previous = this.renderer.state.framebuffer;
    const result: Record<string, number[]> = {};
    for (const [name, target] of [['particles', this.particles], ['bloom', this.vertical]] as const) {
      const pixel = new Float32Array(4);
      this.renderer.bindFramebuffer({ buffer: target.buffer });
      gl.readPixels(Math.min(target.width - 1, Math.max(0, Math.floor(x / viewportWidth * target.width))),
        Math.min(target.height - 1, Math.max(0, Math.floor((1 - y / viewportHeight) * target.height))),
        1, 1, gl.RGBA, gl.FLOAT, pixel);
      result[name] = Array.from(pixel);
    }
    this.renderer.bindFramebuffer({ buffer: previous });
    return result;
  }

  dispose() {
    if (this.renderer.gl.isContextLost()) return;
    this.renderer.bindFramebuffer();
    for (const program of this.programs) {
      program.remove(); this.renderer.gl.deleteShader(program.vertexShader); this.renderer.gl.deleteShader(program.fragmentShader);
    }
    for (const target of this.targets) {
      for (const texture of target.textures) this.renderer.gl.deleteTexture(texture.texture);
      this.renderer.gl.deleteFramebuffer(target.buffer);
    }
    this.programs = []; this.targets = [];
  }
}
