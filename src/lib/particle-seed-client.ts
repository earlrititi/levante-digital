import type { FrameRect } from './sand-seeds';
import type { ParticleSeedCounts, ParticleSeedRequest, ParticleSeedResponse,
  ParticleViewport, PreparedParticleSeeds } from './particle-seed-messages';

type Raster = { pixels: Uint8ClampedArray; width: number; height: number };
type Pending = { resolve: (response: ParticleSeedResponse) => void; reject: (error: Error) => void };

/** Native pixels stay cached in the worker; only finished GPU buffers return to the page. */
export class ParticleSeedClient {
  mode: 'worker' | 'main-thread' = 'main-thread';
  private worker?: Worker;
  private initialisation?: Promise<void>;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private rasters = new WeakMap<HTMLImageElement, Raster>();
  private disposed = false;

  constructor() {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined'
      || typeof createImageBitmap === 'undefined') return;
    try {
      this.worker = new Worker(new URL('./particle-worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }: MessageEvent<ParticleSeedResponse>) => {
        const pending = this.pending.get(data.id);
        if (!pending) return;
        this.pending.delete(data.id);
        if (data.kind === 'error') pending.reject(new Error(data.message));
        else pending.resolve(data);
      };
      this.worker.onerror = () => this.disableWorker(new Error('Particle worker is unavailable'));
      this.worker.onmessageerror = () => this.disableWorker(new Error('Particle worker data could not be read'));
    } catch { this.worker = undefined; }
  }

  private request(request: ParticleSeedRequest, transfer: Transferable[] = []): Promise<ParticleSeedResponse> {
    return new Promise((resolve, reject) => {
      if (!this.worker || this.disposed) { reject(new Error('Particle worker is unavailable')); return; }
      this.pending.set(request.id, { resolve, reject });
      try { this.worker.postMessage(request, transfer); }
      catch (error) {
        this.pending.delete(request.id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private initialise(frame: HTMLImageElement, curtain?: HTMLImageElement): Promise<void> {
    this.initialisation ??= (async () => {
      const images = await Promise.allSettled([createImageBitmap(frame),
        curtain ? createImageBitmap(curtain) : Promise.resolve(undefined)]);
      if (this.disposed || images.some(image => image.status === 'rejected')) {
        for (const image of images) if (image.status === 'fulfilled') image.value?.close();
        throw new Error(this.disposed ? 'Particle preparation was cancelled' : 'Unable to decode the particle artwork');
      }
      const frameBitmap = (images[0] as PromiseFulfilledResult<ImageBitmap>).value;
      const curtainBitmap = (images[1] as PromiseFulfilledResult<ImageBitmap | undefined>).value;
      const transfer: Transferable[] = curtainBitmap ? [frameBitmap, curtainBitmap] : [frameBitmap];
      try {
        await this.request({ id: ++this.nextId, kind: 'images', frame: frameBitmap, curtain: curtainBitmap }, transfer);
      } catch (error) {
        // A failed postMessage may leave ownership in the page.
        frameBitmap.close(); curtainBitmap?.close(); throw error;
      }
      this.mode = 'worker';
    })();
    return this.initialisation;
  }

  private nativeRaster(image: HTMLImageElement): Raster {
    const cached = this.rasters.get(image);
    if (cached) return cached;
    const surface = document.createElement('canvas');
    surface.width = image.naturalWidth; surface.height = image.naturalHeight;
    const context = surface.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Unable to read the particle artwork');
    context.drawImage(image, 0, 0);
    const raster = { pixels: context.getImageData(0, 0, surface.width, surface.height).data,
      width: surface.width, height: surface.height };
    this.rasters.set(image, raster);
    return raster;
  }

  async prepare(frame: HTMLImageElement, curtain: HTMLImageElement | undefined,
    frameRect: FrameRect, curtainRect: FrameRect | undefined, quality: ParticleSeedCounts,
    viewport: ParticleViewport): Promise<PreparedParticleSeeds> {
    if (this.disposed) throw new Error('Particle preparation was cancelled');
    if (this.worker) {
      try {
        await this.initialise(frame, curtain);
        const response = await this.request({ id: ++this.nextId, kind: 'prepare', frameRect, curtainRect, quality, viewport });
        if (response.kind !== 'seeds') throw new Error('Unexpected particle worker response');
        return response.seeds;
      } catch (error) {
        if (this.disposed) throw error;
        this.disableWorker(error instanceof Error ? error : new Error(String(error)));
      }
    }
    // Older browsers keep the same visual fallback path, without decoding twice on resize.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    const [{ buildParticleSeeds }, { buildCurtainSeeds }] = await Promise.all([
      import('./sand-seeds'), import('./curtain-seeds'),
    ]);
    if (this.disposed) throw new Error('Particle preparation was cancelled');
    const frameRaster = this.nativeRaster(frame);
    const seeds: PreparedParticleSeeds = {
      frame: buildParticleSeeds(frameRaster.pixels, frameRaster.width, frameRaster.height, frameRect, quality.frameCount),
    };
    if (curtain && curtainRect) {
      const raster = this.nativeRaster(curtain);
      seeds.curtain = buildCurtainSeeds(raster.pixels, raster.width, raster.height, curtainRect, quality.curtainCount, viewport);
    }
    return seeds;
  }

  private disableWorker(error: Error) {
    this.worker?.terminate(); this.worker = undefined; this.mode = 'main-thread';
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.disableWorker(new Error('Particle preparation was cancelled'));
    this.rasters = new WeakMap(); this.initialisation = undefined;
  }
}
