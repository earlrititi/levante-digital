import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildParticleSeeds, buildSparkSeeds } from '../src/lib/sand-seeds';

function fixture() {
  const pixels = new Uint8ClampedArray(10 * 8 * 4);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 10; x++) {
    if (x > 0 && x < 9 && y > 0 && y < 7) continue;
    pixels.set([220, 195, 160, 255], (y * 10 + x) * 4);
  }
  let seed = 29;
  const random = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  return { pixels, random };
}
const rect = { x: 40, y: 30, width: 100, height: 80 };

test('every emission source belongs to a visible frame pixel', () => {
  const { pixels, random } = fixture();
  const result = buildParticleSeeds(pixels, 10, 8, rect, 8192, random);
  for (let i = 0; i < result.count; i++) {
    const x = Math.floor((result.sources[i * 4]! - rect.x) / rect.width * 10);
    const y = Math.floor((result.sources[i * 4 + 1]! - rect.y) / rect.height * 8);
    assert.equal(pixels[(y * 10 + x) * 4 + 3], 255);
  }
});
test('circulation starts on all four frame edges with no falling grains', () => {
  const { pixels, random } = fixture();
  const result = buildParticleSeeds(pixels, 10, 8, rect, 32768, random);
  assert.ok(result.positions.every(Number.isFinite));
  assert.ok(result.velocities.every(Number.isFinite));
  assert.ok(result.routes.every(Number.isFinite));
  const edges = [0, 0, 0, 0];
  for (let i = 0; i < result.count; i++) {
    const offset = i * 4;
    assert.equal(result.positions[offset], result.sources[offset]);
    assert.equal(result.positions[offset + 1], result.sources[offset + 1]);
    assert.equal(result.positions[offset + 3], 0);
    assert.equal(result.velocities[offset + 3], -1);
    const vx = result.velocities[offset]!, vy = result.velocities[offset + 1]!;
    const edge = vx > 0 ? 0 : vy > 0 ? 1 : vx < 0 ? 2 : 3;
    edges[edge]!++;
  }
  assert.ok(edges.every(count => count > 100));
  assert.equal(result.textureWidth * result.textureHeight, 32768);
});
test('a transparent image cannot become an emitter', () => {
  assert.throws(() => buildParticleSeeds(new Uint8ClampedArray(10 * 8 * 4), 10, 8, rect, 32), /no visible pixels/);
});

test('secondary particles have an integer count and valid parents for small odd emitters', () => {
  const indices = new Float32Array([.1, .5, .3, .5, .5, .5]);
  const sparks = buildSparkSeeds({ count: 3, indices }, () => .5);
  assert.equal(sparks.count, 1);
  assert.equal(sparks.indices.length, 2);
  assert.ok(sparks.sources.every(Number.isFinite));
  assert.equal(sparks.sources[0], indices[0]);
  assert.equal(sparks.positions[3], -1);
});
