import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getParticleQuality } from '../src/lib/particle-quality';

test('mobile budgets fit high-DPI screens without multiplying particle render pixels', () => {
  const desktop = getParticleQuality(1440, 900, { cores: 8, memory: 8 });
  const mobile = getParticleQuality(390, 844, { cores: 8, memory: 4 });
  assert.equal(desktop.curtainCount, 65536);
  assert.equal(mobile.curtainCount, 16384);
  assert.equal(mobile.frameCount, 4096);
  assert.ok(mobile.bloomScale < desktop.bloomScale);
  assert.ok(mobile.pixelRatio <= 1);
  assert.equal(mobile.sparkCount, mobile.frameCount / 2);
});

test('low-memory, low-core and data-saving devices receive the economy budget', () => {
  for (const hints of [{ cores: 2 }, { memory: 2 }, { saveData: true }]) {
    const quality = getParticleQuality(1440, 900, hints);
    assert.equal(quality.level, 'economy');
    assert.equal(quality.curtainCount, 32768);
    assert.equal(quality.frameCount, 8192);
    assert.ok(quality.pixelRatio <= .85);
  }
  const wide = getParticleQuality(3840, 2160, { cores: 16, memory: 16 });
  assert.ok(3840 * wide.pixelRatio <= 1600);
  assert.ok(2160 * wide.pixelRatio <= 1000);
});
