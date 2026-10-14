import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCurtainSeeds } from '../src/lib/curtain-seeds';

const rect = { x: 40, y: 30, width: 60, height: 100 };

function fixture() {
  const pixels = new Uint8ClampedArray(3 * 5 * 4);
  for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
    if (x === 1 || (x === 0 && y === 2)) continue;
    pixels.set([180 + x * 20, 90 + y * 20, y * 15, y === 1 ? 128 : 255], (y * 3 + x) * 4);
  }
  // Below the visibility cutoff; it must not join either adjacent stream.
  pixels.set([200, 150, 50, 127], (2 * 3) * 4);
  return pixels;
}

test('curtain grains sample the silhouette and preserve its literal RGB and alpha', () => {
  const pixels = fixture();
  const result = buildCurtainSeeds(pixels, 3, 5, rect, 512);
  const columns = new Set<number>(), rows = new Set<number>(), alphas = new Set<number>();
  for (let i = 0; i < result.count; i++) {
    const offset = i * 4;
    const x = Math.floor((result.sources[offset]! - rect.x) / rect.width * 3);
    const y = Math.floor((result.sources[offset + 1]! - rect.y) / rect.height * 5);
    const pixel = (y * 3 + x) * 4;
    assert.ok(pixels[pixel + 3]! >= 128);
    assert.deepEqual([...result.colors.slice(offset, offset + 4)], [...pixels.slice(pixel, pixel + 4)]);
    assert.equal(result.positions[offset], result.sources[offset]);
    assert.equal(result.positions[offset + 1], result.sources[offset + 1]);
    assert.equal(result.positions[offset + 2], 0);
    assert.equal(result.positions[offset + 3], 0);
    assert.equal(result.velocities[offset], 0);
    assert.ok(result.velocities[offset + 1]! >= 80 && result.velocities[offset + 1]! < 170);
    assert.equal(result.velocities[offset + 3], -1);
    assert.ok(result.sources[offset + 2]! >= 0 && result.sources[offset + 2]! < 1);
    assert.ok(result.sources[offset + 3]! >= .8 - 1e-7 && result.sources[offset + 3]! <= 1.4);
    columns.add(x); rows.add(y); alphas.add(result.colors[offset + 3]!);
  }
  assert.deepEqual([...columns].sort(), [0, 2]);
  assert.equal(rows.size, 5);
  assert.deepEqual([...alphas].sort(), [128, 255]);
});

test('vertical flow bounds split transparent gaps and stay inside their own column', () => {
  const pixels = fixture();
  const result = buildCurtainSeeds(pixels, 3, 5, rect, 128);
  const seen = new Set<string>();
  for (let i = 0; i < result.count; i++) {
    const offset = i * 4;
    const x = Math.floor((result.sources[offset]! - rect.x) / rect.width * 3);
    const y = Math.floor((result.sources[offset + 1]! - rect.y) / rect.height * 5);
    const top = (result.flows[offset]! - rect.y) / rect.height * 5;
    const bottom = (result.flows[offset + 1]! - rect.y) / rect.height * 5;
    assert.equal(result.flows[offset + 2], result.sources[offset]);
    assert.equal(result.flows[offset + 3], 1);
    assert.ok(result.positions[offset + 1]! >= result.flows[offset]!);
    assert.ok(result.positions[offset + 1]! < result.flows[offset + 1]!);
    assert.ok(y >= top && y < bottom);
    for (let row = top; row < bottom; row++) assert.ok(pixels[(row * 3 + x) * 4 + 3]! >= 128);
    if (top > 0) assert.ok(pixels[((top - 1) * 3 + x) * 4 + 3]! < 128);
    if (bottom < 5) assert.ok(pixels[(bottom * 3 + x) * 4 + 3]! < 128);
    seen.add(`${x}:${top}:${bottom}`);
  }
  assert.deepEqual([...seen].sort(), ['0:0:2', '0:3:5', '2:0:5']);
});

test('stratified curtain sampling covers a large silhouette with a small budget', () => {
  const pixels = new Uint8ClampedArray(100 * 4);
  for (let x = 0; x < 100; x++) pixels.set([x, 200, 10, 255], x * 4);
  const result = buildCurtainSeeds(pixels, 100, 1, { x: 0, y: 0, width: 100, height: 10 }, 5);
  for (let i = 0; i < 5; i++) {
    const sourceX = result.sources[i * 4]!;
    assert.ok(sourceX >= i * 20 && sourceX < (i + 1) * 20);
  }
  assert.deepEqual(result, buildCurtainSeeds(pixels, 100, 1, { x: 0, y: 0, width: 100, height: 10 }, 5));
});

test('GPU texture padding is invalid and every live index addresses its own texel', () => {
  const result = buildCurtainSeeds(fixture(), 3, 5, rect, 17);
  const capacity = result.textureWidth * result.textureHeight;
  assert.equal(result.count, 17);
  assert.equal(result.indices.length, 34);
  for (const values of [result.positions, result.velocities, result.sources, result.colors, result.flows]) {
    assert.equal(values.length, capacity * 4);
    assert.ok(values.every(Number.isFinite));
  }
  for (let i = 0; i < 17; i++) {
    assert.ok(Math.abs(result.indices[i * 2]! - (i % result.textureWidth + .5) / result.textureWidth) < 1e-7);
    assert.ok(Math.abs(result.indices[i * 2 + 1]! - (Math.floor(i / result.textureWidth) + .5) / result.textureHeight) < 1e-7);
  }
  for (let i = 17; i < capacity; i++) {
    assert.equal(result.flows[i * 4 + 3], 0);
    assert.equal(result.colors[i * 4 + 3], 0);
  }
});

test('empty or malformed curtain inputs fail so the static fallback can remain visible', () => {
  assert.throws(() => buildCurtainSeeds(new Uint8ClampedArray(60), 3, 5, rect, 8), /no visible pixels/);
  assert.throws(() => buildCurtainSeeds(new Uint8ClampedArray(4), 3, 5, rect, 8), /dimensions/);
  assert.throws(() => buildCurtainSeeds(fixture(), 3, 5, rect, 0), /positive integer/);
  assert.throws(() => buildCurtainSeeds(fixture(), 3, 5, rect, 1.5), /positive integer/);
  assert.throws(() => buildCurtainSeeds(fixture(), 3, 5, { ...rect, width: 0 }, 8), /positive finite/);
});
