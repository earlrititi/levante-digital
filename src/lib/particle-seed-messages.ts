import type { CurtainSeeds } from './curtain-seeds';
import type { ParticleQuality } from './particle-quality';
import type { FrameRect, ParticleSeeds } from './sand-seeds';

export type ParticleSeedCounts = Pick<ParticleQuality, 'frameCount' | 'curtainCount'>;
export type ParticleViewport = { width: number; height: number };
export type PreparedParticleSeeds = { frame: ParticleSeeds; curtain?: CurtainSeeds };

export type ParticleSeedRequest = {
  id: number;
  kind: 'images';
  frame: ImageBitmap;
  curtain?: ImageBitmap;
} | {
  id: number;
  kind: 'curtain-image';
  curtain: ImageBitmap;
} | {
  id: number;
  kind: 'prepare';
  frameRect: FrameRect;
  curtainRect?: FrameRect;
  quality: ParticleSeedCounts;
  viewport: ParticleViewport;
} | {
  id: number;
  kind: 'curtain-prepare';
  rect: FrameRect;
  quality: ParticleSeedCounts;
  viewport: ParticleViewport;
};

export type ParticleSeedResponse = {
  id: number;
  kind: 'ready';
} | {
  id: number;
  kind: 'seeds';
  seeds: PreparedParticleSeeds;
} | {
  id: number;
  kind: 'curtain-seeds';
  seeds: CurtainSeeds;
} | {
  id: number;
  kind: 'error';
  message: string;
};
