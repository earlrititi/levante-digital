export type ParticleQuality = {
  level: 'desktop' | 'mobile' | 'economy';
  frameCount: number;
  sparkCount: number;
  curtainCount: number;
  pixelRatio: number;
  bloomScale: number;
  curtainDiameter: number;
};

type DeviceHints = { cores?: number; memory?: number; saveData?: boolean };

/** Keep GPU allocations bounded; spend the budget on grains that are on screen. */
export function getParticleQuality(width: number, height: number, hints?: DeviceHints): ParticleQuality {
  const device = typeof navigator === 'undefined' ? undefined : navigator as Navigator & {
    deviceMemory?: number; connection?: { saveData?: boolean };
  };
  const cores = hints?.cores ?? device?.hardwareConcurrency;
  const memory = hints?.memory ?? device?.deviceMemory;
  const saveData = hints?.saveData ?? device?.connection?.saveData ?? false;
  const mobile = width < 600;
  const economy = saveData || (cores !== undefined && cores <= 2) || (memory !== undefined && memory <= 2);
  const divisor = economy ? 2 : 1;
  const frameCount = (mobile ? 4096 : 16384) / divisor;
  return {
    level: economy ? 'economy' : mobile ? 'mobile' : 'desktop',
    frameCount, sparkCount: frameCount / 2,
    curtainCount: (mobile ? 16384 : 65536) / divisor,
    pixelRatio: Math.min(economy ? .85 : 1, 1600 / width, 1000 / height),
    bloomScale: mobile || economy ? .35 : .5,
    curtainDiameter: (mobile ? 4.8 : 5.1) * Math.sqrt(divisor),
  };
}
