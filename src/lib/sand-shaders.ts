/** GPU particle transport inspired by Chris Wellons' WebGL particle demo.
 * https://nullprogram.com/blog/2014/06/29/ (public domain)
 * Modern WebGL2 float MRT replaces the original byte-packed, two-pass encoding.
 */
export const QUAD_VERTEX = `#version 300 es
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position, 1.0); }
`;

/** Shared by grains and collision sparks: swept contact, friction and restitution. */
export const CURSOR_COLLISION = `
bool collideCursor(inout vec2 p, inout vec2 v, vec2 oldPosition, float diameter, float seed,
  out vec2 normal, out vec2 contact) {
  normal = vec2(0.0, -1.0); contact = p;
  if (uCursor.w < 0.5) return false;
  float radius = uCursor.z + diameter * 0.5;
  vec2 from = oldPosition - uPreviousCursor;
  vec2 to = p - uCursor.xy;
  vec2 delta = to - from;
  float a = dot(delta, delta);
  float b = 2.0 * dot(from, delta);
  float c = dot(from, from) - radius * radius;
  float hit = -1.0;
  if (c <= 0.0) hit = 0.0;
  else if (a > 0.000001) {
    float discriminant = b * b - 4.0 * a * c;
    if (discriminant >= 0.0) {
      float t = (-b - sqrt(discriminant)) / (2.0 * a);
      if (t >= 0.0 && t <= 1.0) hit = t;
    }
  }
  if (hit < 0.0 && dot(to, to) >= radius * radius) return false;
  vec2 normalVector = hit >= 0.0 ? from + delta * hit : to;
  if (length(normalVector) > 0.0001) normal = normalize(normalVector);
  if (abs(normal.x) < 0.012 && normal.y < 0.0) {
    normal.x = seed < 0.5 ? -0.035 : 0.035;
    normal = normalize(normal);
  }
  vec2 surfaceVelocity = clamp((uCursor.xy - uPreviousCursor) / uDt, vec2(-900.0), vec2(900.0));
  vec2 relativeVelocity = v - surfaceVelocity;
  if (dot(relativeVelocity, normal) < 0.0) relativeVelocity = reflect(relativeVelocity, normal) * uRestitution;
  if (length(relativeVelocity) < 9.0) relativeVelocity += normal * 9.0 + vec2((seed - 0.5) * 3.0, 0.0);
  v = clamp(relativeVelocity + surfaceVelocity, vec2(-1400.0), vec2(1400.0));
  contact = uCursor.xy + normal * (radius + 0.2);
  p = contact + v * uDt * (1.0 - max(hit, 0.0));
  vec2 separation = p - uCursor.xy;
  if (length(separation) < radius) p = uCursor.xy + normalize(separation + normal * 0.0001) * (radius + 0.2);
  return true;
}
`;

export const SIMULATION_FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uPositions;
uniform sampler2D uVelocities;
uniform sampler2D uSources;
uniform sampler2D uImpacts;
uniform sampler2D uRoutes;
uniform vec2 uViewport;
uniform vec4 uCursor;
uniform vec2 uPreviousCursor;
uniform float uDt;
uniform float uTime;
uniform float uGravity;
uniform float uRestitution;
in vec2 vUv;
layout(location = 0) out vec4 outPosition;
layout(location = 1) out vec4 outVelocity;
layout(location = 2) out vec4 outImpact;

float hash(float value) { return fract(sin(value * 127.1 + 311.7) * 43758.5453); }
${CURSOR_COLLISION}

// Nested lanes follow the alpha thickness of the supplied rectangular frame.
vec4 onRoute(float distance, vec4 lane, float speed) {
  float w = lane.z, h = lane.w;
  float d = mod(distance, 2.0 * (w + h));
  if (d < w) return vec4(lane.xy + vec2(d, 0.0), speed, 0.0);
  if (d < w + h) return vec4(lane.xy + vec2(w, d - w), 0.0, speed);
  if (d < 2.0 * w + h) return vec4(lane.xy + vec2(2.0 * w + h - d, h), -speed, 0.0);
  return vec4(lane.xy + vec2(0.0, 2.0 * (w + h) - d), 0.0, -speed);
}
float homeDistance(vec2 home, vec4 lane) {
  vec2 near = home - lane.xy, far = lane.zw - near;
  float nearest = min(min(near.x, near.y), min(far.x, far.y));
  if (near.y <= nearest + 0.001) return near.x;
  if (far.x <= nearest + 0.001) return lane.z + near.y;
  if (far.y <= nearest + 0.001) return lane.z + lane.w + far.x;
  return 2.0 * lane.z + lane.w + far.y;
}

void main() {
  vec4 positionState = texture(uPositions, vUv);
  vec4 velocityState = texture(uVelocities, vUv);
  vec4 source = texture(uSources, vUv);
  vec4 impact = texture(uImpacts, vUv);
  vec4 lane = texture(uRoutes, vUv);
  vec2 p = positionState.xy;
  vec2 v = velocityState.xy;
  float contacts = positionState.z;
  float seed = source.z;
  float distance = velocityState.z;
  bool falling = velocityState.w >= 0.0;
  float age = falling ? velocityState.w + uDt : -1.0;
  vec2 oldPosition = p;
  float speed = 48.0 + seed * 32.0;
  if (falling) {
    v *= exp(-0.04 * uDt);
    v.y += uGravity * uDt;
    p += v * uDt;
  } else {
    distance = mod(distance + speed * uDt, 2.0 * (lane.z + lane.w));
    vec4 routed = onRoute(distance, lane, speed);
    p = routed.xy; v = routed.zw;
  }

  vec2 normal, contact;
  if (collideCursor(p, v, oldPosition, source.w, seed, normal, contact)) {
    contacts += 1.0;
    if (!falling) { falling = true; age = 0.0; }
    // A real GPU contact launches the secondary emitter once per impact.
    impact = vec4(contact, uTime, atan(normal.y, normal.x));
  }

  if (falling && (p.y > uViewport.y + 20.0 || p.y < -35.0 ||
    p.x < -35.0 || p.x > uViewport.x + 35.0 || age > 3.2)) {
    // Rejoin the same lane only after a detached grain has left the scene.
    distance = homeDistance(source.xy, lane);
    p = source.xy; v = onRoute(distance, lane, speed).zw;
    age = -1.0; falling = false;
  }
  outPosition = vec4(p, contacts, falling ? 1.0 : 0.0);
  outVelocity = vec4(v, distance, age);
  outImpact = impact;
}
`;

// Pastel palette for the circulating frame grains and collision sparks.
export const PARTICLE_PALETTE = `
float hash(float value) { return fract(sin(value * 127.1 + 311.7) * 43758.5453); }
vec3 particleColor(float seed) {
  return 0.5 + 0.5 * vec3(hash(seed + 1.0), hash(seed + 2.0), hash(seed + 3.0));
}
`;

export const PARTICLE_VERTEX = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 particleIndex;
uniform sampler2D uPositions;
uniform sampler2D uVelocities;
uniform sampler2D uSources;
uniform sampler2D uColors;
uniform sampler2D uImpacts;
uniform vec2 uViewport;
uniform float uDpr;
uniform float uGravity;
uniform float uTime;
out vec4 vColor;
${PARTICLE_PALETTE}
void main() {
  vec4 state = texture(uPositions, particleIndex);
  vec4 velocity = texture(uVelocities, particleIndex);
  vec4 source = texture(uSources, particleIndex);
  vec4 color = texture(uColors, particleIndex);
  vec4 impact = texture(uImpacts, particleIndex);
  float lifetime = max(0.1, sqrt(2.0 * max(1.0, uViewport.y + 20.0 - source.y) / uGravity));
  float phase = clamp(velocity.w / lifetime, 0.0, 1.0);
  float fadeEnd = 0.58 + hash(source.z + 8.0) * 0.38;
  float envelope = velocity.w < 0.0 ? 0.78 + 0.18 * sin(source.z * 13.0 + uTime * 0.8) :
    1.0 - smoothstep(0.2, fadeEnd, phase);
  float flash = impact.z >= 0.0 ? exp(-max(0.0, uTime - impact.z) * 9.0) : 0.0;
  vec3 tint = particleColor(source.z) * color.rgb;
  vColor = vec4(tint * (1.15 + flash * 0.55), color.a * (0.36 * envelope + 0.2 * flash));
  gl_Position = vec4(state.x / uViewport.x * 2.0 - 1.0, 1.0 - state.y / uViewport.y * 2.0, 0.0, 1.0);
  gl_PointSize = source.w * (2.8 + flash) * uDpr;
}
`;

export const PARTICLE_FRAGMENT = `#version 300 es
precision mediump float;
in vec4 vColor;
out vec4 outColor;
void main() {
  float radius = length(gl_PointCoord - vec2(0.5)) * 2.0;
  // Analytic equivalent of the example's white radial DynamicTexture.
  float radial = mix(1.0, 0.2, smoothstep(0.0, 0.8, radius)) * (1.0 - smoothstep(0.8, 1.0, radius));
  float alpha = vColor.a * radial;
  outColor = vec4(vColor.rgb * alpha, alpha);
}
`;

export const SPARK_SIMULATION_FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D uPositions;
uniform sampler2D uVelocities;
uniform sampler2D uSources;
uniform sampler2D uImpacts;
uniform vec4 uCursor;
uniform vec2 uPreviousCursor;
uniform float uDt;
uniform float uGravity;
uniform float uRestitution;
in vec2 vUv;
layout(location = 0) out vec4 outPosition;
layout(location = 1) out vec4 outVelocity;
float hash(float value) { return fract(sin(value * 127.1 + 311.7) * 43758.5453); }
${CURSOR_COLLISION}
void main() {
  vec4 state = texture(uPositions, vUv);
  vec4 velocity = texture(uVelocities, vUv);
  vec4 source = texture(uSources, vUv);
  vec4 impact = texture(uImpacts, source.xy);
  float seed = source.z;
  if (impact.z >= 0.0 && impact.z > state.w + 0.00001) {
    float angle = impact.w + (hash(seed + impact.z) - 0.5) * 2.6;
    vec2 normal = vec2(cos(impact.w), sin(impact.w));
    vec2 direction = vec2(cos(angle), sin(angle));
    state = vec4(impact.xy + normal * 1.5, 0.0, impact.z);
    velocity = vec4(direction * (150.0 + hash(seed + 5.0) * 210.0), 0.45 + hash(seed + 2.0) * 1.2, 0.0);
  }
  float age = velocity.w + uDt;
  if (state.w >= 0.0 && age < velocity.z) {
    vec2 p = state.xy, oldPosition = p, v = velocity.xy;
    // Air resistance gives the velocity attenuation of the reference's sub-emitter.
    v *= exp(-1.65 * uDt);
    v.y += uGravity * uDt;
    p += v * uDt;
    vec2 normal, contact;
    if (collideCursor(p, v, oldPosition, source.w, seed, normal, contact)) state.z += 1.0;
    state.xy = p; velocity.xy = v;
  } else state.xy = vec2(-10000.0);
  velocity.w = age;
  outPosition = state; outVelocity = velocity;
}
`;

export const SPARK_VERTEX = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 particleIndex;
uniform sampler2D uPositions;
uniform sampler2D uVelocities;
uniform sampler2D uSources;
uniform vec2 uViewport;
uniform float uDpr;
out vec4 vColor;
float hash(float value) { return fract(sin(value * 127.1 + 311.7) * 43758.5453); }
void main() {
  vec4 state = texture(uPositions, particleIndex);
  vec4 velocity = texture(uVelocities, particleIndex);
  vec4 source = texture(uSources, particleIndex);
  float phase = clamp(velocity.w / max(velocity.z, 0.001), 0.0, 1.0);
  float fadeEnd = 0.25 + hash(source.z + 6.0) * 0.75;
  float envelope = smoothstep(0.0, 0.2, phase) * (1.0 - smoothstep(0.2, fadeEnd, phase));
  vec3 tint = 0.5 + 0.5 * vec3(hash(source.z + 1.0), hash(source.z + 2.0), hash(source.z + 3.0));
  vColor = vec4(tint * 1.7, envelope * 0.65);
  gl_Position = vec4(state.x / uViewport.x * 2.0 - 1.0, 1.0 - state.y / uViewport.y * 2.0, 0.0, 1.0);
  gl_PointSize = source.w * (3.1 - phase * 0.8) * uDpr;
}
`;

