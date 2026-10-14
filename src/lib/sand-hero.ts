import { Renderer } from 'ogl';
import { GpuSand, type GpuCursor } from './gpu-sand';

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
  const background = document.querySelector<HTMLImageElement>('.hero__background');
  const status = document.querySelector<HTMLElement>('[data-sand-status]');
  const resetButton = document.querySelector<HTMLButtonElement>('[data-sand-reset]');
  const toggleButton = document.querySelector<HTMLButtonElement>('[data-sand-toggle]');
  if (!hero || !canvas || !emitter) return;
  const frame = new Image();
  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const setStatus = (message: string) => { if (status) status.textContent = message; };
  const disableControls = () => {
    if (resetButton) resetButton.disabled = true;
    if (toggleButton) toggleButton.disabled = true;
  };
  if (motionQuery.matches) {
    disableControls(); setStatus('Versión estática: tienes activada la preferencia de movimiento reducido.'); return;
  }
  let renderer: Renderer;
  try {
    renderer = new Renderer({ canvas, alpha: true, premultipliedAlpha: true, antialias: false, depth: false, dpr: Math.min(devicePixelRatio, 2), webgl: 2 });
    if (!renderer.isWebgl2) throw new Error('WebGL2 unavailable');
    frame.src = emitter.dataset.sandMask!;
    await Promise.all([frame.decode(), curtain?.decode().catch(() => undefined), background?.decode().catch(() => undefined)]);
  } catch {
    disableControls(); setStatus('Tu navegador muestra la composición estática. WebGL2 no está disponible.'); return;
  }
  renderer.gl.clearColor(0, 0, 0, 0);
  let engine: GpuSand | undefined;
  let paused = false, visible = true, disposed = false, animation = 0, lastTime = 0, accumulator = 0;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const cursor: GpuCursor = { x: -1000, y: -1000, previousX: -1000, previousY: -1000, radius: 10, active: false };
  const fixedStep = 1 / 120;
  const simulationSpeed = .8;
  const debug = new URLSearchParams(location.search).get('sand-debug') === '1';

  function stop() { cancelAnimationFrame(animation); animation = 0; lastTime = 0; accumulator = 0; }
  function metrics() {
    hero!.dataset.sandEngine = 'gpu';
    hero!.dataset.sandParticles = String(engine?.count ?? 0);
    hero!.dataset.sandSparks = String(engine?.sparkCount ?? 0);
    hero!.dataset.sandStyle = 'luminous';
    hero!.dataset.sandSpeed = String(simulationSpeed);
    hero!.dataset.sandCursorRadius = String(cursor.radius);
    hero!.dataset.sandTime = (engine?.time ?? 0).toFixed(3);
    hero!.dataset.sandSteps = String(engine?.steps ?? 0);
    hero!.dataset.sandPaused = String(paused);
    hero!.dataset.logoEffect = 'none';
    hero!.dataset.logoRendering = 'vector';
    hero!.dataset.curtainEffect = 'particle-waterfall';
    hero!.dataset.curtainParticles = String(engine?.curtainCount ?? 0);
    hero!.dataset.curtainGravity = '981';
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
    if (steps > 0) { cursor.previousX = cursor.x; cursor.previousY = cursor.y; }
    engine.draw(cursor); metrics();
    animation = requestAnimationFrame(animate);
  }
  function start() {
    if (!animation && !paused && visible && !document.hidden && !disposed) animation = requestAnimationFrame(animate);
  }
  function rebuild() {
    stop(); engine?.dispose();
    hero!.dataset.curtainReady = 'false';
    const bounds = hero!.getBoundingClientRect(), artwork = emitter!.getBoundingClientRect();
    const width = Math.round(bounds.width), height = Math.round(bounds.height);
    renderer.setSize(width, height);
    engine = new GpuSand(renderer, frame!, { x: artwork.left - bounds.left, y: artwork.top - bounds.top,
      width: artwork.width, height: artwork.height }, width, height);
    if (curtain?.naturalWidth) {
      // Both definitive assets share the full 1672x941 canvas and cover transform.
      const nativeWidth = background?.naturalWidth || 1672, nativeHeight = background?.naturalHeight || 941;
      const scale = Math.max(width / nativeWidth, height / nativeHeight);
      try {
        engine.attachCurtain(curtain, { x: (width - nativeWidth * scale) / 2, y: (height - nativeHeight * scale) / 2,
          width: curtain.naturalWidth * scale, height: curtain.naturalHeight * scale });
        hero!.dataset.curtainReady = 'true';
      } catch { hero!.dataset.curtainReady = 'false'; }
    }
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
    setStatus(paused ? 'Animación pausada.' : 'La cortina cae en partículas. Interrumpe la cascada con el cursor.');
    start();
  }
  function onPointerMove(event: PointerEvent) {
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
    setStatus(paused ? 'Animación pausada.' : 'La cortina cae en partículas. Interrumpe la cascada con el cursor.');
  }
  function onReset() { cursor.active = false; engine?.reset(); engine?.draw(cursor); metrics(); }
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (disposed) return;
      try { rebuild(); } catch { fail(); }
    }, 180);
  }
  function onVisibility() { cursor.active = false; if (document.hidden) stop(); else start(); }
  function onContextLost(event: Event) {
    event.preventDefault(); dispose(); disableControls();
    setStatus('Se ha interrumpido WebGL. La composición estática sigue disponible; recarga para reactivar la animación.');
  }
  function onMotionChange() {
    if (motionQuery.matches) { dispose(); disableControls(); setStatus('Versión estática: preferencia de movimiento reducido activada.'); }
  }
  const visibilityObserver = new IntersectionObserver(([entry]) => {
    visible = !!entry?.isIntersecting;
    if (!visible) { cursor.active = false; stop(); } else start();
  }, { threshold: 0 });
  const resizeObserver = new ResizeObserver(onResize);
  function fail() {
    dispose(); disableControls();
    setStatus('La composición estática está disponible. Este dispositivo no admite la simulación GPU.');
  }
  function dispose() {
    if (disposed) return;
    disposed = true; stop(); clearTimeout(resizeTimer); engine?.dispose();
    hero!.dataset.sandReady = 'false'; delete window.__sandGpu;
    hero!.dataset.curtainReady = 'false';
    visibilityObserver.disconnect(); resizeObserver.disconnect();
    hero!.removeEventListener('pointermove', onPointerMove); hero!.removeEventListener('pointerdown', onPointerMove);
    hero!.removeEventListener('pointerleave', onPointerLeave); hero!.removeEventListener('pointerup', onPointerUp);
    hero!.removeEventListener('pointercancel', onPointerLeave);
    toggleButton?.removeEventListener('click', onToggle); resetButton?.removeEventListener('click', onReset);
    document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('pagehide', dispose);
    motionQuery.removeEventListener('change', onMotionChange); canvas!.removeEventListener('webglcontextlost', onContextLost);
  }
  try { rebuild(); } catch { fail(); return; }
  hero.addEventListener('pointermove', onPointerMove, { passive: true }); hero.addEventListener('pointerdown', onPointerMove, { passive: true });
  hero.addEventListener('pointerleave', onPointerLeave); hero.addEventListener('pointerup', onPointerUp);
  hero.addEventListener('pointercancel', onPointerLeave);
  toggleButton?.addEventListener('click', onToggle); resetButton?.addEventListener('click', onReset);
  document.addEventListener('visibilitychange', onVisibility); window.addEventListener('pagehide', dispose);
  motionQuery.addEventListener('change', onMotionChange); canvas.addEventListener('webglcontextlost', onContextLost);
  visibilityObserver.observe(hero); resizeObserver.observe(hero);
  return dispose;
}
