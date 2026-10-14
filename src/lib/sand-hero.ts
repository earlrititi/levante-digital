import type { Renderer } from 'ogl';
import type { GpuSand, GpuCursor } from './gpu-sand';
import { getParticleQuality, type ParticleQuality } from './particle-quality';
import type { ParticleSeedClient } from './particle-seed-client';
import type { FrameRect } from './sand-seeds';

declare global {
  interface Window { __sandGpu?: {
    snapshot: () => ReturnType<GpuSand['snapshot']>;
    sources: () => Float32Array;
    routes: () => Float32Array;
    setParticle: (index: number, position: number[], velocity: number[]) => void;
    step: (dt: number, cursor: GpuCursor) => void;
    reset: () => void;
    redraw: () => void;
    glow: (x: number, y: number) => ReturnType<GpuSand['glowForVerification']>;
    curtain: () => ReturnType<GpuSand['curtainForVerification']>;
    setCurtainParticle: (index: number, position: number[], velocity: number[]) => void;
  } }
}

export async function initSandHero(): Promise<(() => void) | undefined> {
  const hero = document.querySelector<HTMLElement>('[data-sand-hero]');
  const canvas = document.querySelector<HTMLCanvasElement>('[data-sand-canvas]');
  const emitter = document.querySelector<HTMLElement>('[data-sand-frame]');
  const curtain = document.querySelector<HTMLImageElement>('[data-curtain-image]');
  const status = document.querySelector<HTMLElement>('[data-sand-status]');
  const resetButton = document.querySelector<HTMLButtonElement>('[data-sand-reset]');
  const toggleButton = document.querySelector<HTMLButtonElement>('[data-sand-toggle]');
  const playButton = document.querySelector<HTMLButtonElement>('[data-curtain-play]');
  const playLabel = playButton?.querySelector<HTMLElement>('[data-curtain-play-label]');
  if (!hero || !canvas || !emitter) return;
  type CurtainState = 'idle' | 'loading' | 'playing' | 'paused' | 'unavailable';
  let curtainState: CurtainState = 'idle';
  function setCurtainState(state: CurtainState) {
    curtainState = state; hero!.dataset.curtainState = state;
    if (!playButton) return;
    playButton.hidden = state === 'playing' || state === 'paused' || state === 'unavailable';
    playButton.disabled = state === 'loading' || state === 'unavailable';
    playButton.setAttribute('aria-busy', String(state === 'loading'));
    const label = state === 'loading' ? 'Preparando cascada…' : 'Reproducir cascada';
    playButton.setAttribute('aria-label', label);
    if (playLabel) playLabel.textContent = label;
  }
  setCurtainState('idle');
  hero.dataset.curtainReady = 'false'; hero.dataset.curtainParticles = '0';
  hero.dataset.curtainPreparations = '0';
  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const setStatus = (message: string) => { if (status) status.textContent = message; };
  const disableControls = () => {
    if (resetButton) resetButton.disabled = true;
    if (toggleButton) toggleButton.disabled = true;
    setCurtainState('unavailable');
  };
  if (motionQuery.matches) {
    disableControls(); setStatus('Versión estática: tienes activada la preferencia de movimiento reducido.'); return;
  }

  const frame = new Image();
  let renderer: Renderer | undefined;
  let SandEngine: typeof GpuSand | undefined;
  let SeedClient: typeof ParticleSeedClient | undefined;
  let engine: GpuSand | undefined;
  let seedClient: ParticleSeedClient | undefined;
  let quality: ParticleQuality | undefined;
  let paused = false, disposed = false, imagesReady = false, curtainStarted = false;
  let curtainVersion = 0;
  let animation = 0, lastTime = 0, accumulator = 0, buildVersion = 0;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const initialBounds = hero.getBoundingClientRect();
  let visible = initialBounds.bottom > 0 && initialBounds.top < innerHeight
    && initialBounds.right > 0 && initialBounds.left < innerWidth;
  const visibilityWaiters = new Set<() => void>();
  const cursor: GpuCursor = { x: -1000, y: -1000, previousX: -1000, previousY: -1000, radius: 10, active: false };
  const fixedStep = 1 / 120;
  const simulationSpeed = .8;
  const debug = new URLSearchParams(location.search).get('sand-debug') === '1';
  let initTime = 0;

  function stop() { cancelAnimationFrame(animation); animation = 0; lastTime = 0; accumulator = 0; }
  function metric(name: string, value: string) {
    if (hero!.dataset[name] !== value) hero!.dataset[name] = value;
  }
  function metrics() {
    metric('sandEngine', 'gpu');
    metric('sandParticles', String(engine?.count ?? 0));
    metric('sandSparks', String(engine?.sparkCount ?? 0));
    metric('sandStyle', 'luminous');
    metric('sandSpeed', String(simulationSpeed));
    metric('sandCursorRadius', String(cursor.radius));
    metric('sandTime', (engine?.time ?? 0).toFixed(3));
    metric('sandSteps', String(engine?.steps ?? 0));
    metric('sandPaused', String(paused));
    metric('sandQuality', quality?.level ?? 'desktop');
    metric('sandSeedPreparation', seedClient?.mode ?? 'main-thread');
    metric('logoEffect', 'none');
    metric('logoRendering', 'vector');
    metric('curtainEffect', 'particle-waterfall');
    metric('curtainParticles', String(engine?.curtainCount ?? 0));
    metric('curtainPreparations', String(seedClient?.curtainPreparations ?? 0));
    metric('curtainGravity', '981');
  }
  function animate(time: number) {
    animation = 0;
    if (disposed || paused || !visible || document.hidden || !engine) { lastTime = 0; return; }
    const elapsed = lastTime ? Math.min((time - lastTime) / 1000, .05) : fixedStep;
    lastTime = time; accumulator += elapsed * simulationSpeed;
    const steps = Math.floor(accumulator / fixedStep), oldX = cursor.previousX, oldY = cursor.previousY;
    for (let step = 0; step < steps; step++) {
      engine.step(fixedStep, { ...cursor,
        previousX: oldX + (cursor.x - oldX) * step / steps,
        previousY: oldY + (cursor.y - oldY) * step / steps,
        x: oldX + (cursor.x - oldX) * (step + 1) / steps,
        y: oldY + (cursor.y - oldY) * (step + 1) / steps });
      accumulator -= fixedStep;
    }
    if (steps > 0) {
      cursor.previousX = cursor.x; cursor.previousY = cursor.y;
      engine.draw(cursor); metrics();
    }
    animation = requestAnimationFrame(animate);
  }
  function start() {
    if (engine && !animation && !paused && visible && !document.hidden && !disposed) animation = requestAnimationFrame(animate);
  }
  function releaseVisibilityWaiters() {
    if (!disposed && (!visible || document.hidden)) return;
    for (const resolve of visibilityWaiters) resolve();
    visibilityWaiters.clear();
  }
  async function waitUntilVisible(): Promise<boolean> {
    while (!disposed && (!visible || document.hidden)) {
      await new Promise<void>(resolve => visibilityWaiters.add(resolve));
    }
    return !disposed;
  }
  function updateStatus() {
    if (curtainState === 'loading') setStatus('Preparando la cascada…');
    else if (paused) setStatus('Animación pausada.');
    else if (curtainState === 'playing') setStatus('La cortina cae en partículas. Interrumpe la cascada con el cursor.');
    else setStatus('Pulsa reproducir para iniciar la cascada. El marco ya responde al cursor.');
  }
  async function startCurtain() {
    const target = engine;
    if (!curtainStarted || !target || !curtain || !quality || !seedClient || disposed) return;
    const version = ++curtainVersion, frameVersion = buildVersion;
    const isCurrent = () => !disposed && version === curtainVersion && frameVersion === buildVersion && engine === target;
    setCurtainState('loading'); updateStatus();
    try {
      await curtain.decode();
      if (!isCurrent() || !await waitUntilVisible() || !isCurrent()) return;
      const bounds = hero!.getBoundingClientRect();
      const width = Math.round(bounds.width), height = Math.round(bounds.height);
      const scale = Math.max(width / 1672, height / 941);
      const rect = { x: (width - 1672 * scale) / 2, y: (height - 941 * scale) / 2,
        width: curtain.naturalWidth * scale, height: curtain.naturalHeight * scale };
      const seedsPromise = seedClient.prepareCurtain(curtain, rect, quality, { width, height });
      metrics();
      const seeds = await seedsPromise;
      if (!isCurrent() || !await waitUntilVisible() || !isCurrent()) return;
      await target.attachCurtain(curtain, rect, seeds);
      if (!isCurrent()) return;
      target.draw(cursor); hero!.dataset.curtainReady = 'true';
      setCurtainState(paused ? 'paused' : 'playing'); metrics(); updateStatus(); start();
    } catch {
      if (!isCurrent()) return;
      hero!.dataset.curtainReady = 'false'; setCurtainState('idle'); metrics();
      setStatus('No se ha podido iniciar la cascada. Puedes volver a pulsar reproducir.');
    }
  }
  function onPlay() {
    if (disposed || curtainState === 'loading' || engine?.curtainCount) return;
    curtainStarted = true; cursor.active = false;
    setCurtainState('loading'); updateStatus();
    // Early clicks retain the user's intent while the frame finishes loading.
    if (engine) void startCurtain();
  }
  async function rebuild() {
    const version = ++buildVersion;
    ++curtainVersion;
    stop(); engine?.dispose(); engine = undefined;
    hero!.dataset.sandReady = 'false'; hero!.dataset.curtainReady = 'false'; delete window.__sandGpu;
    if (curtainStarted) { setCurtainState('loading'); updateStatus(); }
    if (!renderer || !SandEngine || !SeedClient || !imagesReady || !await waitUntilVisible() || version !== buildVersion) return;
    const bounds = hero!.getBoundingClientRect(), artwork = emitter!.getBoundingClientRect();
    const width = Math.round(bounds.width), height = Math.round(bounds.height);
    if (width < 1 || height < 1) return;
    const frameRect: FrameRect = { x: artwork.left - bounds.left, y: artwork.top - bounds.top,
      width: artwork.width, height: artwork.height };
    const nextQuality = getParticleQuality(width, height);
    seedClient ??= new SeedClient();
    try {
      const seeds = await seedClient.prepare(frame, undefined, frameRect, undefined, nextQuality, { width, height });
      if (disposed || version !== buildVersion || !await waitUntilVisible() || version !== buildVersion) return;
      renderer.dpr = nextQuality.pixelRatio; renderer.setSize(width, height);
      quality = nextQuality;
      engine = new SandEngine(renderer, frame, frameRect, width, height, nextQuality, seeds.frame);
      if (debug) window.__sandGpu = {
        snapshot: () => engine!.snapshot(), sources: () => engine!.sourcesForVerification(), routes: () => engine!.routesForVerification(),
        setParticle: (index, position, velocity) => engine!.setParticleForVerification(index, position, velocity),
        step: (dt, collider) => { engine!.step(dt, collider); engine!.draw(collider); metrics(); },
        reset: () => { engine!.reset(); engine!.draw(cursor); metrics(); },
        redraw: () => engine!.draw(cursor),
        glow: (x, y) => engine!.glowForVerification(x, y),
        curtain: () => engine!.curtainForVerification(),
        setCurtainParticle: (index, position, velocity) => engine!.setCurtainParticleForVerification(index, position, velocity),
      };
      engine.draw(cursor); metrics(); hero!.dataset.sandReady = 'true';
      if (!hero!.dataset.sandInitMs) {
        hero!.dataset.sandInitMs = (performance.now() - initTime).toFixed(1);
        performance.mark('particle-ready');
        performance.measure('particle-startup', 'particle-init', 'particle-ready');
      }
      updateStatus();
      start();
      if (curtainStarted) void startCurtain();
    } catch { if (!disposed && version === buildVersion) fail(); }
  }
  function onPointerMove(event: PointerEvent) {
    if (event.target instanceof Element && event.target.closest('[data-curtain-play]')) {
      cursor.active = false; return;
    }
    if (event.pointerType !== 'mouse' && event.buttons === 0) return;
    const bounds = hero!.getBoundingClientRect();
    const x = event.clientX - bounds.left, y = event.clientY - bounds.top;
    if (!cursor.active) { cursor.previousX = x; cursor.previousY = y; }
    cursor.x = x; cursor.y = y; cursor.active = true;
    if (!paused && visible && !document.hidden && engine && event.type === 'pointerdown') {
      // A tap must affect the GPU state even when pointerup precedes the next RAF.
      engine.step(fixedStep, cursor);
      engine.draw(cursor); metrics();
      cursor.previousX = cursor.x; cursor.previousY = cursor.y;
    }
    start();
  }
  function onPointerLeave() { cursor.active = false; }
  function onPointerUp(event: PointerEvent) { if (event.pointerType !== 'mouse') cursor.active = false; }
  function onToggle() {
    paused = !paused; metrics();
    toggleButton!.setAttribute('aria-pressed', String(paused));
    toggleButton!.textContent = paused ? 'Reanudar animación' : 'Pausar animación';
    if (paused) stop(); else start();
    if (engine?.curtainCount) setCurtainState(paused ? 'paused' : 'playing');
    updateStatus();
  }
  function onReset() { cursor.active = false; engine?.reset(); engine?.draw(cursor); metrics(); }
  function onResize() {
    if (!imagesReady || disposed) return;
    // Invalidate an in-flight result immediately; debounce the next preparation job.
    ++buildVersion;
    ++curtainVersion;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (!disposed) void rebuild(); }, 180);
  }
  function onVisibility() {
    cursor.active = false;
    if (document.hidden) stop(); else { releaseVisibilityWaiters(); start(); }
  }
  function onContextLost(event: Event) {
    event.preventDefault(); dispose(); disableControls();
    setStatus('Se ha interrumpido WebGL. La composición estática sigue disponible; recarga para reactivar la animación.');
  }
  function onMotionChange() {
    if (motionQuery.matches) { dispose(); disableControls(); setStatus('Versión estática: preferencia de movimiento reducido activada.'); }
  }
  const visibilityObserver = new IntersectionObserver(([entry]) => {
    visible = !!entry?.isIntersecting;
    if (!visible) { cursor.active = false; stop(); }
    else { releaseVisibilityWaiters(); start(); }
  }, { threshold: 0 });
  const resizeObserver = new ResizeObserver(onResize);
  function fail() {
    dispose(); disableControls();
    setStatus('La composición estática está disponible. Este dispositivo no admite la simulación GPU.');
  }
  function dispose() {
    if (disposed) return;
    disposed = true; ++buildVersion; ++curtainVersion; stop(); clearTimeout(resizeTimer); engine?.dispose(); engine = undefined;
    seedClient?.dispose(); releaseVisibilityWaiters();
    hero!.dataset.sandReady = 'false'; delete window.__sandGpu;
    hero!.dataset.curtainReady = 'false';
    hero!.dataset.curtainParticles = '0'; setCurtainState('unavailable');
    visibilityObserver.disconnect(); resizeObserver.disconnect();
    hero!.removeEventListener('pointermove', onPointerMove); hero!.removeEventListener('pointerdown', onPointerMove);
    hero!.removeEventListener('pointerleave', onPointerLeave); hero!.removeEventListener('pointerup', onPointerUp);
    hero!.removeEventListener('pointercancel', onPointerLeave);
    toggleButton?.removeEventListener('click', onToggle); resetButton?.removeEventListener('click', onReset);
    playButton?.removeEventListener('click', onPlay);
    document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('pagehide', dispose);
    motionQuery.removeEventListener('change', onMotionChange); canvas!.removeEventListener('webglcontextlost', onContextLost);
  }
  hero.addEventListener('pointermove', onPointerMove, { passive: true }); hero.addEventListener('pointerdown', onPointerMove, { passive: true });
  hero.addEventListener('pointerleave', onPointerLeave); hero.addEventListener('pointerup', onPointerUp);
  hero.addEventListener('pointercancel', onPointerLeave);
  toggleButton?.addEventListener('click', onToggle); resetButton?.addEventListener('click', onReset);
  playButton?.addEventListener('click', onPlay);
  document.addEventListener('visibilitychange', onVisibility); window.addEventListener('pagehide', dispose);
  motionQuery.addEventListener('change', onMotionChange); canvas.addEventListener('webglcontextlost', onContextLost);
  visibilityObserver.observe(hero); resizeObserver.observe(hero);

  try {
    if (!await waitUntilVisible()) return dispose;
    // Two frames let the static hero paint before decoding masks or allocating GPU buffers.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (!await waitUntilVisible()) return dispose;
    initTime = performance.now(); performance.mark('particle-init');
    const { Renderer: GpuRenderer } = await import('ogl');
    if (!await waitUntilVisible()) return dispose;
    renderer = new GpuRenderer({ canvas, alpha: true, premultipliedAlpha: true, antialias: false, depth: false, dpr: 1, webgl: 2 });
    const gl = renderer.gl as WebGL2RenderingContext;
    if (!renderer.isWebgl2 || !gl.getExtension('EXT_color_buffer_float')
      || gl.getParameter(gl.MAX_DRAW_BUFFERS) < 3 || gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS) < 5) {
      throw new Error('Floating-point WebGL2 simulation is not supported');
    }
    renderer.gl.clearColor(0, 0, 0, 0);
    frame.src = emitter.dataset.sandMask!;
    const [gpuModule, seedModule] = await Promise.all([import('./gpu-sand'), import('./particle-seed-client'), frame.decode()]);
    if (disposed) return dispose;
    SandEngine = gpuModule.GpuSand; SeedClient = seedModule.ParticleSeedClient;
    imagesReady = true;
    await rebuild();
  } catch { if (!disposed) fail(); }
  return dispose;
}
