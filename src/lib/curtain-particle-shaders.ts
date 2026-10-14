import { CURSOR_COLLISION } from './sand-shaders';

export const CURTAIN_SIMULATION = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uPositions;
uniform sampler2D uVelocities;
uniform sampler2D uSources;
uniform sampler2D uFlows;
uniform vec2 uViewport;
uniform vec4 uRect;
uniform vec4 uCursor;
uniform vec2 uPreviousCursor;
uniform float uDt;
uniform float uGravity;
uniform float uRestitution;
in vec2 vUv;
layout(location = 0) out vec4 outPosition;
layout(location = 1) out vec4 outVelocity;
${CURSOR_COLLISION}
void main() {
  vec4 state = texture(uPositions, vUv), velocity = texture(uVelocities, vUv);
  vec4 source = texture(uSources, vUv), flow = texture(uFlows, vUv);
  if (flow.w < 0.5) {
    outPosition = vec4(-10000.0, -10000.0, 0.0, 0.0);
    outVelocity = vec4(0.0, 0.0, 0.0, -1.0); return;
  }
  bool detached = state.w > 0.5;
  float paint = detached ? velocity.z : source.z;
  float age = detached ? velocity.w + uDt : -1.0;
  vec2 p = state.xy, oldPosition = p, v = velocity.xy;
  v *= exp(-(detached ? 0.45 : 2.6) * uDt);
  v.y += uGravity * uDt;
  p += v * uDt;
  if (!detached) {
    p.x = flow.z;
    if (p.y >= flow.y) {
      p.y = flow.x + mod(p.y - flow.x, max(0.002, flow.y - flow.x));
      v = vec2(0.0, 80.0 + source.z * 90.0);
      // Recycling must not sweep a fictitious collision through the entire column.
      oldPosition = vec2(flow.z, flow.x);
    }
    p.y = clamp(p.y, flow.x + 0.001, flow.y - 0.001);
  }
  vec2 normal, contact;
  float contactColorY = (p.y - uRect.y) / uRect.w;
  if (collideCursor(p, v, oldPosition, source.w, source.z, normal, contact)) {
    state.z += 1.0;
    if (!detached) { age = 0.0; paint = 2.0 + contactColorY; }
    detached = true;
  }
  if (detached && (age > 3.2 || p.y > uViewport.y + 20.0 || p.y < -35.0 ||
    p.x < -35.0 || p.x > uViewport.x + 35.0)) {
    p = source.xy; v = vec2(0.0, 80.0 + source.z * 90.0);
    detached = false; age = -1.0; paint = source.z;
  }
  outPosition = vec4(p, state.z, detached ? 1.0 : 0.0);
  outVelocity = vec4(v, paint, age);
}
`;

export const CURTAIN_PARTICLE_VERTEX = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 particleIndex;
uniform sampler2D uPositions;
uniform sampler2D uVelocities;
uniform sampler2D uSources;
uniform sampler2D uColors;
uniform sampler2D uArtwork;
uniform vec4 uRect;
uniform vec2 uViewport;
uniform float uDpr;
uniform float uDiameterScale;
uniform float uTime;
out vec4 vColor;
void main() {
  vec4 state = texture(uPositions, particleIndex), source = texture(uSources, particleIndex);
  vec2 local = (state.xy - uRect.xy) / uRect.zw;
  vec4 color = texture(uArtwork, vec2(local.x, 1.0 - local.y));
  if (state.w > 0.5) {
    float contactColor = texture(uVelocities, particleIndex).z;
    color = contactColor >= 2.0 ? texture(uArtwork,
      vec2((source.x - uRect.x) / uRect.z, 1.0 - (contactColor - 2.0))) : texture(uColors, particleIndex);
  }
  // Sample the actual gold/cream/white folds, rather than randomizing the palette.
  float shimmer = 0.91 + 0.09 * sin(source.z * 19.0 + uTime * 1.3);
  vColor = vec4(color.rgb, color.a * 0.84 * shimmer);
  gl_Position = vec4(state.x / uViewport.x * 2.0 - 1.0, 1.0 - state.y / uViewport.y * 2.0, 0.0, 1.0);
  gl_PointSize = source.w * uDiameterScale * uDpr;
  if (color.a < 0.002) gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
}
`;
