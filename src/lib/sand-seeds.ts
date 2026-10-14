export type FrameRect = { x: number; y: number; width: number; height: number };
export type ParticleSeeds = {
  positions: Float32Array; velocities: Float32Array;
  sources: Float32Array; routes: Float32Array; colors: Uint8Array; indices: Float32Array;
  textureWidth: number; textureHeight: number; count: number;
};

export type SparkSeeds = Omit<ParticleSeeds, 'colors' | 'routes'>;

/** Eight secondary grains for every sixteenth parent; dormant until a GPU contact. */
export function buildSparkSeeds(parent: Pick<ParticleSeeds, 'count' | 'indices'>, random = Math.random): SparkSeeds {
  const count = Math.max(1, Math.floor(parent.count / 2));
  const textureWidth = 2 ** Math.ceil(Math.log2(Math.sqrt(count)));
  const textureHeight = Math.ceil(count / textureWidth);
  const capacity = textureWidth * textureHeight;
  const positions = new Float32Array(capacity * 4), velocities = new Float32Array(capacity * 4);
  const sources = new Float32Array(capacity * 4), indices = new Float32Array(count * 2);
  for (let index = 0; index < count; index++) {
    const parentIndex = Math.min(parent.count - 1, Math.floor(index / 8) * 16), offset = index * 4;
    positions.set([-10000, -10000, 0, -1], offset);
    velocities.set([0, 0, 1, 2], offset);
    sources.set([parent.indices[parentIndex * 2]!, parent.indices[parentIndex * 2 + 1]!,
      random(), .8 + random() * .55], offset);
    indices[index * 2] = (index % textureWidth + .5) / textureWidth;
    indices[index * 2 + 1] = (Math.floor(index / textureWidth) + .5) / textureHeight;
  }
  return { positions, velocities, sources, indices, textureWidth, textureHeight, count };
}

/** CPU work is restricted to initialising/rebuilding the GPU textures. */
export function buildParticleSeeds(pixels: Uint8ClampedArray, imageWidth: number, imageHeight: number,
  rect: FrameRect, count: number, random = Math.random): ParticleSeeds {
  const opaque: number[] = [];
  for (let cell = 0; cell < imageWidth * imageHeight; cell++) if (pixels[cell * 4 + 3]! >= 128) opaque.push(cell);
  if (!opaque.length) throw new Error('Frame has no visible pixels');
  const textureWidth = 2 ** Math.ceil(Math.log2(Math.sqrt(count)));
  const textureHeight = Math.ceil(count / textureWidth);
  const capacity = textureWidth * textureHeight;
  const positions = new Float32Array(capacity * 4), velocities = new Float32Array(capacity * 4);
  const sources = new Float32Array(capacity * 4), colors = new Uint8Array(capacity * 4);
  const routes = new Float32Array(capacity * 4);
  const indices = new Float32Array(count * 2);
  for (let index = 0; index < count; index++) {
    const cell = opaque[Math.floor(random() * opaque.length)]!;
    const pixel = cell * 4, offset = index * 4;
    // Jitter stays inside the selected opaque source pixel.
    const pixelX = cell % imageWidth + .1 + random() * .8;
    const pixelY = Math.floor(cell / imageWidth) + .1 + random() * .8;
    const x = rect.x + pixelX / imageWidth * rect.width;
    const y = rect.y + pixelY / imageHeight * rect.height;
    const seed = random(), diameter = .8 + random() * .55;
    sources.set([x, y, seed, diameter], offset);
    // Each visible source pixel defines a nested rectangular lane. This preserves
    // the original alpha thickness across all four sides, including the corners.
    const inset = Math.min(pixelX, pixelY, imageWidth - pixelX, imageHeight - pixelY);
    const left = rect.x + inset / imageWidth * rect.width;
    const top = rect.y + inset / imageHeight * rect.height;
    const width = rect.width * (1 - 2 * inset / imageWidth);
    const height = rect.height * (1 - 2 * inset / imageHeight);
    const speed = 48 + seed * 32;
    let distance: number, vx = 0, vy = 0;
    if (inset === pixelY) { distance = x - left; vx = speed; }
    else if (inset === imageWidth - pixelX) { distance = width + y - top; vy = speed; }
    else if (inset === imageHeight - pixelY) { distance = width + height + left + width - x; vx = -speed; }
    else { distance = 2 * width + height + top + height - y; vy = -speed; }
    routes.set([left, top, width, height], offset);
    positions.set([x, y, 0, 0], offset);
    // z = distance around the lane; w < 0 means attached, w >= 0 is falling age.
    velocities.set([vx, vy, distance, -1], offset);
    colors.set([pixels[pixel]!, pixels[pixel + 1]!, pixels[pixel + 2]!, pixels[pixel + 3]!], offset);
    indices[index * 2] = (index % textureWidth + .5) / textureWidth;
    indices[index * 2 + 1] = (Math.floor(index / textureWidth) + .5) / textureHeight;
  }
  return { positions, velocities, sources, routes, colors, indices, textureWidth, textureHeight, count };
}
