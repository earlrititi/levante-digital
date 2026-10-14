import type { FrameRect } from './sand-seeds';
import type { CurtainSeeds } from './curtain-seeds';
import type { ParticleSeedCounts, ParticleSeedRequest, ParticleSeedResponse,
  ParticleViewport, PreparedParticleSeeds } from './particle-seed-messages';

type Raster = { pixels: Uint8ClampedArray; width: number; height: number };
type Pending = { resolve: (response: ParticleSeedResponse) => void; reject: (error: Error) => void };

/** Native pixels stay cached in the worker; only finished GPU buffers return to the page. */
export class ParticleSeedClient {
  mode: 'worker' | 'main-thread' = 'main-thread';
  curtainPreparations = 0;
  private worker?: Worker;
  private initialisation?: Promise<void>;
  private curtainInitialisation?: Promise<void>;
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

  private initialise(frame: HTMLImageElement): Promise<void> {
    this.initialisation ??= (async () => {
      const frameBitmap = await createImageBitmap(frame);
      if (this.disposed) { frameBitmap.close(); throw new Error('Particle preparation was cancelled'); }
      try {
        await this.request({ id: ++this.nextId, kind: 'images', frame: frameBitmap }, [frameBitmap]);
      } catch (error) {
        // A failed postMessage may leave ownership in the page.
        frameBitmap.close(); throw error;
      }
      this.mode = 'worker';
    })();
    return this.initialisation;
  }

  private initialiseCurtain(image: HTMLImageElement): Promise<void> {
    this.curtainInitialisation ??= (async () => {
      const bitmap = await createImageBitmap(image);
      if (this.disposed) { bitmap.close(); throw new Error('Particle preparation was cancelled'); }
      try {
        await this.request({ id: ++this.nextId, kind: 'curtain-image', curtain: bitmap }, [bitmap]);
      } catch (error) { bitmap.close(); throw error; }
      this.mode = 'worker';
    })();
    return this.curtainInitialisation;
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
        await this.initialise(frame);
        if (curtain && curtainRect) await this.initialiseCurtain(curtain);
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
    const { buildParticleSeeds } = await import('./sand-seeds');
    if (this.disposed) throw new Error('Particle preparation was cancelled');
    const frameRaster = this.nativeRaster(frame);
    const seeds: PreparedParticleSeeds = {
      frame: buildParticleSeeds(frameRaster.pixels, frameRaster.width, frameRaster.height, frameRect, quality.frameCount),
    };
    if (curtain && curtainRect) {
      seeds.curtain = await this.prepareCurtain(curtain, curtainRect, quality, viewport);
    }
    return seeds;
  }

  /** Called only after the user asks to play; frame preparation never touches this mask. */
  async prepareCurtain(image: HTMLImageElement, rect: FrameRect, quality: ParticleSeedCounts,
    viewport: ParticleViewport): Promise<CurtainSeeds> {
    if (this.disposed) throw new Error('Particle preparation was cancelled');
    this.curtainPreparations++;
    if (this.worker) {
      try {
        await this.initialiseCurtain(image);
        const response = await this.request({ id: ++this.nextId, kind: 'curtain-prepare', rect, quality, viewport });
        if (response.kind !== 'curtain-seeds') throw new Error('Unexpected particle worker response');
        return response.seeds;
      } catch (error) {
        if (this.disposed) throw error;
        this.disableWorker(error instanceof Error ? error : new Error(String(error)));
      }
    }
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    const { buildCurtainSeeds } = await import('./curtain-seeds');
    if (this.disposed) throw new Error('Particle preparation was cancelled');
    const raster = this.nativeRaster(image);
    return buildCurtainSeeds(raster.pixels, raster.width, raster.height, rect, quality.curtainCount, viewport);
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
    this.rasters = new WeakMap(); this.initialisation = undefined; this.curtainInitialisation = undefined;
  }
}
