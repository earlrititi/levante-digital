import type { FrameRect } from './sand-seeds';

export type CurtainSeeds = {
  positions: Float32Array;
  velocities: Float32Array;
  sources: Float32Array;
  colors: Uint8Array;
  indices: Float32Array;
  /** Each grain's contiguous opaque vertical segment: top, bottom, x, valid. */
  flows: Float32Array;
  textureWidth: number;
  textureHeight: number;
  count: number;
};

function randomFor(index: number, salt: number): number {
  let value = Math.imul(index + 1, 0x9e3779b1) ^ salt;
  value = Math.imul(value ^ value >>> 16, 0x85ebca6b);
  value = Math.imul(value ^ value >>> 13, 0xc2b2ae35);
  return ((value ^ value >>> 16) >>> 0) / 4294967296;
}

/** Initialise GPU textures once; the animation never needs to scan source pixels. */
export function buildCurtainSeeds(pixels: Uint8ClampedArray, imageWidth: number,
  imageHeight: number, rect: FrameRect, count: number): CurtainSeeds {
  if (!Number.isSafeInteger(imageWidth) || !Number.isSafeInteger(imageHeight)
    || imageWidth < 1 || imageHeight < 1 || pixels.length < imageWidth * imageHeight * 4) {
    throw new Error('Curtain image dimensions do not match its pixels');
  }
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('Curtain particle count must be a positive integer');
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    || rect.width <= 0 || rect.height <= 0) throw new Error('Curtain rectangle must have positive finite dimensions');

  const pixelCount = imageWidth * imageHeight;
  const opaque = new Uint32Array(pixelCount);
  let visibleCount = 0;
  for (let cell = 0; cell < pixelCount; cell++) {
    if (pixels[cell * 4 + 3]! >= 128) opaque[visibleCount++] = cell;
  }
  if (!visibleCount) throw new Error('Curtain has no visible pixels');

  // Transparent gaps split a column into independent streams. Both scans are
  // linear in image size, including the assignment of boundaries to visible cells.
  const segmentTop = new Uint32Array(pixelCount);
  const segmentBottom = new Uint32Array(pixelCount);
  for (let x = 0; x < imageWidth; x++) {
    let y = 0;
    while (y < imageHeight) {
      if (pixels[(y * imageWidth + x) * 4 + 3]! < 128) { y++; continue; }
      const top = y;
      do { y++; } while (y < imageHeight && pixels[(y * imageWidth + x) * 4 + 3]! >= 128);
      for (let row = top; row < y; row++) {
        const cell = row * imageWidth + x;
        segmentTop[cell] = top;
        segmentBottom[cell] = y;
      }
    }
  }

  const textureWidth = 2 ** Math.ceil(Math.log2(Math.sqrt(count)));
  const textureHeight = Math.ceil(count / textureWidth);
  const capacity = textureWidth * textureHeight;
  const positions = new Float32Array(capacity * 4);
  const velocities = new Float32Array(capacity * 4);
  const sources = new Float32Array(capacity * 4);
  const colors = new Uint8Array(capacity * 4);
  const flows = new Float32Array(capacity * 4);
  const indices = new Float32Array(count * 2);

  for (let index = 0; index < count; index++) {
    // A jittered sample from every stratum covers the whole silhouette without
    // periodic row patterns. When grains outnumber pixels, strata may repeat.
    const start = Math.floor(index * visibleCount / count);
    const end = Math.floor((index + 1) * visibleCount / count);
    const cell = opaque[start + Math.floor(randomFor(index, 0x1234abcd) * Math.max(1, end - start))]!;
    const pixel = cell * 4, offset = index * 4;
    const pixelX = cell % imageWidth + .15 + randomFor(index, 0xdeadbeef) * .7;
    const pixelY = Math.floor(cell / imageWidth) + .15 + randomFor(index, 0x456789ab) * .7;
    const x = rect.x + pixelX / imageWidth * rect.width;
    const y = rect.y + pixelY / imageHeight * rect.height;
    const seed = randomFor(index, 0x13579bdf);
    positions.set([x, y, 0, 0], offset);
    velocities.set([0, 80 + seed * 90, seed, -1], offset);
    sources.set([x, y, seed, .8 + randomFor(index, 0x2468ace0) * .6], offset);
    colors.set(pixels.subarray(pixel, pixel + 4), offset);
    flows.set([
      rect.y + segmentTop[cell]! / imageHeight * rect.height,
      rect.y + segmentBottom[cell]! / imageHeight * rect.height,
      x, 1,
    ], offset);
    indices[index * 2] = (index % textureWidth + .5) / textureWidth;
    indices[index * 2 + 1] = (Math.floor(index / textureWidth) + .5) / textureHeight;
  }

  return { positions, velocities, sources, colors, indices, flows, textureWidth, textureHeight, count };
}
