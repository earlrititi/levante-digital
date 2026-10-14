import type { CurtainSeeds } from './curtain-seeds';
import { buildParticleSeeds } from './sand-seeds';
import type { ParticleSeedRequest, ParticleSeedResponse, PreparedParticleSeeds } from './particle-seed-messages';

type Raster = { pixels: Uint8ClampedArray; width: number; height: number };
// Use the DOM-compatible subset so this module also typechecks in Astro's DOM project.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<ParticleSeedRequest>) => void) | null;
  postMessage: (message: ParticleSeedResponse, transfer?: Transferable[]) => void;
};
let frame: Raster | undefined;
let curtain: Raster | undefined;

function decode(bitmap: ImageBitmap): Raster {
  try {
    const surface = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = surface.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Unable to read the particle artwork');
    context.drawImage(bitmap, 0, 0);
    return { pixels: context.getImageData(0, 0, bitmap.width, bitmap.height).data,
      width: bitmap.width, height: bitmap.height };
  } finally { bitmap.close(); }
}

function curtainBuffers(seeds: CurtainSeeds): Transferable[] {
  return [seeds.positions, seeds.velocities, seeds.sources, seeds.colors, seeds.indices, seeds.flows]
    .map(array => array.buffer as ArrayBuffer);
}

function seedBuffers(seeds: PreparedParticleSeeds): Transferable[] {
  const arrays = [seeds.frame.positions, seeds.frame.velocities, seeds.frame.sources,
    seeds.frame.routes, seeds.frame.colors, seeds.frame.indices];
  if (seeds.curtain) arrays.push(seeds.curtain.positions, seeds.curtain.velocities,
    seeds.curtain.sources, seeds.curtain.colors, seeds.curtain.indices, seeds.curtain.flows);
  return arrays.map(array => array.buffer as ArrayBuffer);
}

scope.onmessage = async ({ data }) => {
  try {
    if (data.kind === 'images') {
      frame = decode(data.frame);
      if (data.curtain) curtain = decode(data.curtain);
      scope.postMessage({ id: data.id, kind: 'ready' });
      return;
    }
    if (data.kind === 'curtain-image') {
      curtain = decode(data.curtain);
      scope.postMessage({ id: data.id, kind: 'ready' });
      return;
    }
    if (data.kind === 'curtain-prepare') {
      if (!curtain) throw new Error('Curtain artwork is not ready');
      const raster = curtain;
      const { buildCurtainSeeds } = await import('./curtain-seeds');
      const seeds = buildCurtainSeeds(raster.pixels, raster.width, raster.height,
        data.rect, data.quality.curtainCount, data.viewport);
      scope.postMessage({ id: data.id, kind: 'curtain-seeds', seeds }, curtainBuffers(seeds));
      return;
    }
    if (!frame) throw new Error('Particle artwork is not ready');
    const seeds: PreparedParticleSeeds = {
      frame: buildParticleSeeds(frame.pixels, frame.width, frame.height, data.frameRect, data.quality.frameCount),
    };
    if (curtain && data.curtainRect) {
      const { buildCurtainSeeds } = await import('./curtain-seeds');
      seeds.curtain = buildCurtainSeeds(curtain.pixels, curtain.width, curtain.height,
        data.curtainRect, data.quality.curtainCount, data.viewport);
    }
    scope.postMessage({ id: data.id, kind: 'seeds', seeds }, seedBuffers(seeds));
  } catch (error) {
    scope.postMessage({ id: data.id, kind: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
