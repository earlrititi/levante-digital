import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const baseURL = new URL(process.env.PREVIEW_URL || 'http://127.0.0.1:4321/');
baseURL.searchParams.set('sand-debug', '1');
await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.BROWSER_EXECUTABLE,
  args: ['--enable-unsafe-swiftshader'] });
const errors = [], failedRequests = [], results = {};
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(12000);
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {
  if (message.type() === 'error' || (message.type() === 'warning' && /shader|framebuffer/i.test(message.text()))) errors.push(message.text());
});
page.on('requestfailed', request => failedRequests.push(request.url()));
const metrics = () => page.locator('[data-sand-hero]').evaluate(el => ({ ...el.dataset }));
function assertParticleBudget(metadata, width, curtainStarted = true) {
  const mobile = width < 600, economy = metadata.sandQuality === 'economy';
  assert.ok(['desktop', 'mobile', 'economy'].includes(metadata.sandQuality));
  if (!economy) assert.equal(metadata.sandQuality, mobile ? 'mobile' : 'desktop');
  const divisor = economy ? 2 : 1, frame = (mobile ? 4096 : 16384) / divisor;
  assert.equal(Number(metadata.sandParticles), frame, 'The frame must use the bounded shared device budget');
  assert.equal(Number(metadata.sandSparks), frame / 2);
  assert.equal(Number(metadata.curtainParticles), curtainStarted ? (mobile ? 16384 : 65536) / divisor : 0);
}
function observeCurtainWorkers() {
  const NativeWorker = window.Worker;
  window.__curtainWorkerJobs = 0;
  window.__curtainImageJobs = 0;
  window.Worker = class extends NativeWorker {
    postMessage(...args) {
      if (args[0]?.kind === 'curtain-prepare') window.__curtainWorkerJobs++;
      if (args[0]?.kind === 'curtain-image') window.__curtainImageJobs++;
      return super.postMessage(...args);
    }
  };
}
async function assertIdleCurtain(target) {
  const idle = await target.evaluate(() => {
    const hero = document.querySelector('[data-sand-hero]'), image = document.querySelector('[data-curtain-image]');
    const style = getComputedStyle(image), button = document.querySelector('[data-curtain-play]');
    return { ...hero.dataset, gpuCurtainAbsent: window.__sandGpu.curtain() === undefined,
      fallbackVisible: style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0,
      playVisible: button.checkVisibility(), playEnabled: !button.disabled,
      workerJobs: window.__curtainWorkerJobs ?? 0, imageJobs: window.__curtainImageJobs ?? 0 };
  });
  assert.equal(idle.curtainReady, 'false');
  assert.equal(idle.curtainState, 'idle');
  assert.equal(Number(idle.curtainParticles), 0);
  assert.equal(Number(idle.curtainPreparations), 0, 'No curtain seed preparation may run before Play');
  assert.equal(idle.gpuCurtainAbsent, true, 'No waterfall GPU buffers may exist before Play');
  assert.equal(idle.fallbackVisible, true);
  assert.equal(idle.playVisible, true);
  assert.equal(idle.playEnabled, true);
  assert.equal(idle.workerJobs, 0);
  assert.equal(idle.imageJobs, 0, 'The curtain bitmap must not be transferred to the worker before Play');
  await assertCurtainControl(target, false);
  return idle;
}
async function assertCurtainControl(target, playing) {
  const button = target.locator('[data-curtain-play]');
  assert.equal(await button.isVisible(), true, 'The cascade control must remain visible in both playback states');
  assert.equal((await button.textContent()).trim(), '', 'The cascade control must contain icons only');
  assert.equal(await button.locator('[data-curtain-play-icon]').isVisible(), !playing);
  assert.equal(await button.locator('[data-curtain-pause-icon]').isVisible(), playing);
  assert.match(await button.getAttribute('aria-label'), playing ? /Pausar cascada/i : /(?:Reproducir|Reanudar) cascada/i);
  const heroBounds = await target.locator('[data-sand-hero]').boundingBox(), buttonBounds = await button.boundingBox();
  assert.ok(buttonBounds.x - heroBounds.x < heroBounds.width * .25, 'The persistent control must stay in the left quarter of the hero');
  assert.ok(buttonBounds.y - heroBounds.y + buttonBounds.height > heroBounds.height * .75,
    'The persistent control must stay in the bottom quarter of the hero');
}
async function activateCurtainControl(target, input = 'click', key = 'Enter') {
  const button = target.locator('[data-curtain-play]');
  if (input === 'keyboard') { await button.focus(); await target.keyboard.press(key); }
  else if (input === 'touch') await button.tap();
  else await button.click();
}
async function playCurtain(target, input = 'click') {
  await activateCurtainControl(target, input);
  await target.waitForSelector('[data-sand-ready="true"][data-curtain-ready="true"]');
  await assertCurtainControl(target, true);
}
async function assertCurtainPoster(target) {
  const poster = await target.evaluate(() => {
    const image = document.querySelector('[data-curtain-image]'), hero = document.querySelector('[data-sand-hero]');
    const style = getComputedStyle(image);
    return { source: new URL(image.src).pathname, state: hero.dataset.curtainState,
      visible: style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) === 1,
      interiorParticles: window.__sandGpu.glow(hero.clientWidth * .5, hero.clientHeight * .72).particles };
  });
  assert.equal(poster.state, 'paused');
  assert.equal(poster.source, '/assets/images/cortina-def.webp');
  assert.equal(poster.visible, true, 'Pause must display the original curtain image');
  assert.equal(poster.interiorParticles[3], 0, 'The shared HDR target must contain no frozen curtain grains after Pause');
  const actual = await target.screenshot();
  const previousDisplay = await target.locator('[data-sand-canvas]').evaluate(canvas => {
    const value = canvas.style.display; canvas.style.display = 'none'; return value;
  });
  let expected;
  try { expected = await target.screenshot(); }
  finally { await target.locator('[data-sand-canvas]').evaluate((canvas, value) => canvas.style.display = value, previousDisplay); }
  const pixels = await target.evaluate(async ({ actual, expected }) => {
    const decode = async bytes => {
      const image = new Image(); image.src = 'data:image/png;base64,' + bytes; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d', { willReadFrequently: true }); context.drawImage(image, 0, 0);
      return { width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data };
    };
    const a = await decode(actual), b = await decode(expected), ratio = a.width / innerWidth;
    const hero = document.querySelector('[data-sand-hero]').getBoundingClientRect();
    const logo = document.querySelector('[data-logo-image]').getBoundingClientRect();
    const button = document.querySelector('[data-curtain-play]').getBoundingClientRect();
    const image = document.querySelector('[data-curtain-image]'), scale = Math.max(hero.width / image.naturalWidth, hero.height / image.naturalHeight);
    const maskCanvas = document.createElement('canvas'); maskCanvas.width = a.width; maskCanvas.height = a.height;
    const context = maskCanvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(image, (hero.left + (hero.width - image.naturalWidth * scale) / 2) * ratio,
      (hero.top + (hero.height - image.naturalHeight * scale) / 2) * ratio,
      image.naturalWidth * scale * ratio, image.naturalHeight * scale * ratio);
    const mask = context.getImageData(0, 0, a.width, a.height).data;
    const within = (x, y, bounds) => x >= bounds.left - 8 && x <= bounds.right + 8 && y >= bounds.top - 8 && y <= bounds.bottom + 8;
    let tested = 0, changed = 0, maxDifference = 0;
    for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
      const px = x / ratio, py = y / ratio, offset = (y * a.width + x) * 4;
      if (mask[offset + 3] < 240 || px < hero.left + 100 || px > hero.right - 100
        || py < hero.top + 100 || py > hero.bottom - 100 || within(px, py, logo) || within(px, py, button)) continue;
      tested++;
      const difference = Math.max(...[0, 1, 2].map(channel => Math.abs(a.data[offset + channel] - b.data[offset + channel])));
      maxDifference = Math.max(maxDifference, difference);
      if (difference > 3) changed++;
    }
    return { tested, changed, maxDifference };
  }, { actual: actual.toString('base64'), expected: expected.toString('base64') });
  assert.ok(pixels.tested > 1000, 'The original poster must be compared across a substantial opaque curtain region');
  assert.equal(pixels.changed, 0, 'Paused curtain pixels must match the original image composition, without a frozen particle overlay');
  return { ...poster, pixels };
}
async function verifyCurtainToggle(target, input = 'click') {
  const before = await target.locator('[data-sand-hero]').evaluate(el => ({ ...el.dataset }));
  const seeds = await target.evaluate(() => Array.from(window.__sandGpu.curtain().sources));
  const jobs = await target.evaluate(() => window.__curtainWorkerJobs ?? 0);
  await activateCurtainControl(target, input, 'Space');
  await target.waitForSelector('[data-curtain-state="paused"]');
  await assertCurtainControl(target, false);
  const frozen = await target.evaluate(() => Array.from(window.__sandGpu.curtain().positions));
  const frameTime = Number(await target.locator('[data-sand-hero]').getAttribute('data-sand-time'));
  await target.waitForTimeout(220);
  assert.deepEqual(await target.evaluate(() => Array.from(window.__sandGpu.curtain().positions)), frozen,
    'Pausing the cascade must freeze its actual GPU positions');
  assert.ok(Number(await target.locator('[data-sand-hero]').getAttribute('data-sand-time')) > frameTime,
    'The frame must keep moving while only the cascade is paused');
  const poster = await assertCurtainPoster(target);
  await target.screenshot({ path: `artifacts/curtain-persistent-control-paused-${input === 'touch' ? 'mobile' : 'desktop'}.png` });
  await activateCurtainControl(target, input);
  await target.waitForSelector('[data-curtain-state="playing"]');
  await assertCurtainControl(target, true);
  await target.waitForTimeout(220);
  assert.notDeepEqual(await target.evaluate(() => Array.from(window.__sandGpu.curtain().positions)), frozen,
    'Play must resume the same waterfall simulation');
  assert.deepEqual(await target.evaluate(() => Array.from(window.__sandGpu.curtain().sources)), seeds);
  const after = await target.locator('[data-sand-hero]').evaluate(el => ({ ...el.dataset }));
  assert.equal(after.curtainPreparations, before.curtainPreparations, 'Resuming must not prepare new seeds');
  assert.equal(await target.evaluate(() => window.__curtainWorkerJobs ?? 0), jobs, 'Playback toggles must reuse the worker result');
  assert.equal(after.curtainParticles, before.curtainParticles);
  return { input, frameTimeBefore: frameTime, frameTimeAfter: Number(after.sandTime),
    preparations: Number(after.curtainPreparations), workerJobs: jobs, particles: Number(after.curtainParticles), poster };
}
async function logoContainment(target) {
  return target.evaluate(async () => {
    const logo = document.querySelector('[data-logo-image]'), curtain = document.querySelector('[data-curtain-image]');
    const hero = document.querySelector('[data-sand-hero]');
    await Promise.all([logo.decode(), curtain.decode()]);
    const logoCanvas = document.createElement('canvas'); logoCanvas.width = 1200; logoCanvas.height = 443;
    const logoContext = logoCanvas.getContext('2d', { willReadFrequently: true }); logoContext.drawImage(logo, 0, 0, 1200, 443);
    const ink = logoContext.getImageData(0, 0, 1200, 443).data;
    const maskCanvas = document.createElement('canvas'); maskCanvas.width = curtain.naturalWidth; maskCanvas.height = curtain.naturalHeight;
    const maskContext = maskCanvas.getContext('2d', { willReadFrequently: true }); maskContext.drawImage(curtain, 0, 0);
    const mask = maskContext.getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
    const h = hero.getBoundingClientRect(), l = logo.getBoundingClientRect();
    const scale = Math.max(h.width / maskCanvas.width, h.height / maskCanvas.height);
    const originX = (h.width - maskCanvas.width * scale) / 2, originY = (h.height - maskCanvas.height * scale) / 2;
    let inside = 0, total = 0, outsideViewport = 0, minX = Infinity, maxX = -Infinity;
    // Desktop containment includes the full painted symbol and both rows of lettering.
    const desktop = h.width >= 900, firstX = desktop ? 0 : 548;
    for (let y = 0; y < 443; y++) for (let x = firstX; x < 1200; x++) {
      if (ink[(y * 1200 + x) * 4 + 3] < 128) continue;
      total++;
      const px = l.left - h.left + (x + .5) / 1200 * l.width;
      const py = l.top - h.top + (y + .5) / 443 * l.height;
      const mx = Math.floor((px - originX) / scale), my = Math.floor((py - originY) / scale);
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      if (px < 0 || py < 0 || px >= h.width || py >= h.height) outsideViewport++;
      if (mx >= 0 && my >= 0 && mx < maskCanvas.width && my < maskCanvas.height
        && mask[(my * maskCanvas.width + mx) * 4 + 3] >= 128) inside++;
    }
    const centerY = l.top - h.top + l.height * .5, row = Math.floor((centerY - originY) / scale);
    let curtainLeft = Infinity, curtainRight = -Infinity;
    for (let x = 0; x < maskCanvas.width; x++) if (mask[(row * maskCanvas.width + x) * 4 + 3] >= 128) {
      const px = originX + (x + .5) * scale;
      if (px >= 0 && px < h.width) { curtainLeft = Math.min(curtainLeft, px); curtainRight = Math.max(curtainRight, px); }
    }
    return { viewport: { width: h.width, height: h.height }, logo: { x: l.left - h.left, y: l.top - h.top, width: l.width, height: l.height },
      scope: desktop ? 'full-logo' : 'lettering', paintedPixels: total, inside, outsideViewport, containment: inside / total,
      paintedCenterX: (minX + maxX) / 2, curtainCenterX: (curtainLeft + curtainRight) / 2,
      centerOffset: Math.abs((minX + maxX - curtainLeft - curtainRight) / 2) };
  });
}
function curtainViewportCoverage() {
  const state = window.__sandGpu.curtain(), hero = document.querySelector('[data-sand-hero]');
  let offscreenSources = 0, offscreenFlows = 0;
  for (let index = 0; index < state.count; index++) {
    const i = index * 4, x = state.sources[i], y = state.sources[i + 1];
    if (x < 0 || x >= hero.clientWidth || y < 0 || y >= hero.clientHeight) offscreenSources++;
    if (state.flows[i] < -.001 || state.flows[i + 1] > hero.clientHeight + .001
      || state.flows[i + 2] < 0 || state.flows[i + 2] >= hero.clientWidth) offscreenFlows++;
  }
  return { count: state.count, offscreenSources, offscreenFlows };
}
const stateSummary = () => page.evaluate(() => {
  const state = window.__sandGpu.snapshot();
  let contacts = 0, falling = 0, activeSparks = 0, finite = true;
  for (let i = 0; i < state.count; i++) {
    contacts += state.positions[i * 4 + 2]; falling += state.positions[i * 4 + 3];
    for (let j = 0; j < 4; j++) finite &&= Number.isFinite(state.positions[i * 4 + j]) && Number.isFinite(state.velocities[i * 4 + j]);
  }
  for (let i = 0; i < state.sparks.count; i++) {
    const offset = i * 4;
    if (state.sparks.positions[offset + 3] >= 0 && state.sparks.velocities[offset + 3] < state.sparks.velocities[offset + 2]) activeSparks++;
    for (let j = 0; j < 4; j++) finite &&= Number.isFinite(state.sparks.positions[offset + j]) && Number.isFinite(state.sparks.velocities[offset + j]);
  }
  return { count: state.count, contacts, falling, activeSparks, finite };
});
try {
  await page.addInitScript(observeCurtainWorkers);
  assert.equal((await page.goto(baseURL.href)).status(), 200);
  await page.waitForSelector('[data-sand-ready="true"]');
  await page.waitForTimeout(300);
  results.initial = await metrics();
  assert.equal(results.initial.sandEngine, 'gpu');
  assertParticleBudget(results.initial, 1440, false);
  assert.ok(['worker', 'main-thread'].includes(results.initial.sandSeedPreparation));
  assert.ok(Number(results.initial.sandInitMs) > 0);
  assert.equal(results.initial.sandStyle, 'luminous');
  assert.equal(Number(results.initial.sandSpeed), .8);
  assert.equal(Number(results.initial.sandCursorRadius), 10);
  assert.equal(results.initial.logoRendering, 'vector');
  assert.equal(results.initial.logoEffect, 'none');
  assert.equal(results.initial.logoParticles, undefined);
  results.idleCurtain = await assertIdleCurtain(page);
  results.initialLogoContainment = await logoContainment(page);
  assert.equal(results.initialLogoContainment.containment, 1, 'Every painted symbol and letter pixel must lie inside the desktop curtain');
  assert.ok(results.initialLogoContainment.centerOffset < 12, 'The complete desktop logo must be centered in the curtain body');
  assert.equal(results.initialLogoContainment.outsideViewport, 0);
  await page.screenshot({ path: 'artifacts/curtain-play-idle-desktop.png' });
  const idleLogo = await page.locator('[data-logo-image]').boundingBox();
  await page.mouse.move(idleLogo.x + idleLogo.width * .6, idleLogo.y + idleLogo.height * .5);
  await page.waitForTimeout(100);
  await page.locator('[data-sand-reset]').click();
  await page.locator('[data-sand-toggle]').click();
  await assertIdleCurtain(page);
  await page.locator('[data-sand-toggle]').click();
  await page.waitForTimeout(100);
  await assertIdleCurtain(page);
  const frameTimeBeforePlay = Number((await metrics()).sandTime);
  await playCurtain(page, 'keyboard');
  results.keyboardPlay = await metrics();
  assert.equal(Number(results.keyboardPlay.curtainPreparations), 1, 'One activation must prepare one waterfall');
  assert.ok(Number(results.keyboardPlay.sandTime) >= frameTimeBeforePlay, 'Starting the curtain must preserve the running frame clock');
  assertParticleBudget(results.keyboardPlay, 1440);
  assert.equal(results.keyboardPlay.curtainReady, 'true');
  const activationContacts = await page.evaluate(() => {
    const state = window.__sandGpu.curtain(); let contacts = 0;
    for (let i = 2; i < state.count * 4; i += 4) contacts += state.positions[i];
    return contacts;
  });
  assert.equal(activationContacts, 0, 'Activating Play must not create cursor collisions in the newborn waterfall');
  results.desktopCurtainToggle = await verifyCurtainToggle(page, 'keyboard');
  await page.locator('[data-sand-toggle]').click();
  await page.waitForSelector('[data-sand-paused="true"][data-curtain-state="paused"]');
  await assertCurtainControl(page, false);
  results.globalPausePoster = await assertCurtainPoster(page);
  await activateCurtainControl(page);
  await page.waitForSelector('[data-sand-paused="false"][data-curtain-state="playing"]');
  await assertCurtainControl(page, true);
  assert.equal(Number((await metrics()).curtainPreparations), 1);
  results.curtainPlayResumesGlobalPause = true;
  await activateCurtainControl(page);
  await page.waitForSelector('[data-curtain-state="paused"]');
  await page.locator('[data-sand-toggle]').click();
  await page.locator('[data-sand-toggle]').click();
  await page.evaluate(() => scrollTo(0, 0));
  await page.waitForSelector('[data-sand-paused="false"][data-curtain-state="paused"]');
  const locallyPaused = await page.evaluate(() => Array.from(window.__sandGpu.curtain().positions));
  const locallyPausedFrameTime = Number((await metrics()).sandTime);
  await page.waitForTimeout(220);
  assert.deepEqual(await page.evaluate(() => Array.from(window.__sandGpu.curtain().positions)), locallyPaused,
    'Global resume must preserve an explicit cascade pause');
  assert.ok(Number((await metrics()).sandTime) > locallyPausedFrameTime);
  await assertCurtainControl(page, false);
  results.localPausePosterAfterGlobalToggle = await assertCurtainPoster(page);
  await activateCurtainControl(page);
  await page.waitForSelector('[data-curtain-state="playing"]');
  results.localCurtainPauseSurvivesGlobalToggle = true;
  await page.screenshot({ path: 'artifacts/curtain-play-playing-desktop.png' });
  assert.equal(results.initial.curtainEffect, 'particle-waterfall');
  assert.equal(Number(results.initial.curtainGravity), 981);
  assert.equal(results.initial.curtainPoints, undefined);
  assert.equal(results.initial.curtainLines, undefined);
  assert.equal(await page.locator('[data-curtain-canvas]').count(), 0);
  assert.equal(await page.locator('[data-logo-image]').getAttribute('src'), '/assets/images/logo-hero-vector.svg');
  results.logoVectorAsset = await page.evaluate(async () => {
    const image = document.querySelector('[data-logo-image]');
    const xml = new DOMParser().parseFromString(await (await fetch(image.src)).text(), 'image/svg+xml');
    const original = new Image(); original.src = '/assets/images/logo-hero.webp'; await original.decode();
    const canvas = document.createElement('canvas'); canvas.width = original.naturalWidth; canvas.height = original.naturalHeight;
    const context = canvas.getContext('2d'); context.drawImage(original, 0, 0);
    const before = context.getImageData(0, 0, canvas.width, canvas.height).data;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const after = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let intersection = 0, union = 0;
    for (let i = 3; i < before.length; i += 4) {
      const a = before[i] >= 128, b = after[i] >= 128;
      if (a && b) intersection++; if (a || b) union++;
    }
    return { paths: xml.querySelectorAll('path').length, embeddedImages: xml.querySelectorAll('image').length,
      silhouetteOverlap: intersection / union };
  });
  assert.ok(results.logoVectorAsset.paths > 0);
  assert.equal(results.logoVectorAsset.embeddedImages, 0);
  assert.ok(results.logoVectorAsset.silhouetteOverlap > .98, 'The vector contours must preserve the supplied brand silhouette');
  assert.equal(await page.locator('[data-logo-image]').isVisible(), true);
  assert.equal(await page.locator('img[src*="marco"]').count(), 0);
  assert.equal(await page.locator('[data-sand-frame]').isVisible(), false);
  results.curtainArtwork = await page.evaluate(async () => {
    const state = window.__sandGpu.curtain(), image = document.querySelector('[data-curtain-image]');
    const background = document.querySelector('.hero__background'), hero = document.querySelector('[data-sand-hero]');
    await Promise.all([image.decode(), background.decode()]);
    const style = getComputedStyle(image), scale = Math.max(hero.clientWidth / 1672, hero.clientHeight / 941);
    return { count: state.count, gravity: state.gravity, rect: state.rect,
      expected: { x: (hero.clientWidth - 1672 * scale) / 2, y: (hero.clientHeight - 941 * scale) / 2,
        width: 1672 * scale, height: 941 * scale },
      source: new URL(image.src).pathname, background: new URL(background.src).pathname,
      sourceSize: [image.naturalWidth, image.naturalHeight], backgroundSize: [background.naturalWidth, background.naturalHeight],
      imageWidth: state.imageWidth, imageHeight: state.imageHeight,
      fallbackHidden: style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0,
      rendererMask: getComputedStyle(document.querySelector('[data-sand-canvas]')).maskImage };
  });
  assert.equal(results.curtainArtwork.source, '/assets/images/cortina-def.webp');
  assert.equal(results.curtainArtwork.background, '/assets/images/fondo-def.webp');
  assert.deepEqual(results.curtainArtwork.sourceSize, [1672, 941]);
  assert.deepEqual(results.curtainArtwork.backgroundSize, [1672, 941]);
  assert.equal(results.curtainArtwork.imageWidth, 1672);
  assert.equal(results.curtainArtwork.imageHeight, 941);
  assert.equal(results.curtainArtwork.gravity, 981);
  assert.equal(results.curtainArtwork.fallbackHidden, true, 'The curtain bitmap is only a static fallback, never drawn beneath its particles');
  assert.equal(results.curtainArtwork.rendererMask, 'none', 'Detached grains must remain visible outside the curtain silhouette');
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.ok(Math.abs(results.curtainArtwork.rect[key] - results.curtainArtwork.expected[key]) < .01,
      'Curtain particles and background must share the original artwork cover transform');
  }
  results.curtainSourceMask = await page.evaluate(() => {
    const state = window.__sandGpu.curtain(), image = document.querySelector('[data-curtain-image]');
    const sample = document.createElement('canvas'); sample.width = image.naturalWidth; sample.height = image.naturalHeight;
    // Match the initialization readback path: Chromium's accelerated Canvas 2D
    // rounds a few translucent RGB channels differently when unpremultiplying.
    const context = sample.getContext('2d', { willReadFrequently: true }); context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
    window.__curtainFixture = { pixels, width: sample.width, height: sample.height };
    let invalidSources = 0, mismatchedColors = 0, invalidFlows = 0;
    const colors = new Set();
    for (let index = 0; index < state.count; index++) {
      const i = index * 4;
      const x = Math.floor((state.sources[i] - state.rect.x) / state.rect.width * sample.width);
      const y = Math.floor((state.sources[i + 1] - state.rect.y) / state.rect.height * sample.height);
      const pixel = (y * sample.width + x) * 4;
      if (x < 0 || y < 0 || x >= sample.width || y >= sample.height || pixels[pixel + 3] < 128) invalidSources++;
      for (let channel = 0; channel < 4; channel++) if (state.colors[i + channel] !== pixels[pixel + channel]) mismatchedColors++;
      if (state.flows[i + 3] !== 1 || state.flows[i] > state.sources[i + 1] || state.flows[i + 1] <= state.sources[i + 1]
        || Math.abs(state.flows[i + 2] - state.sources[i]) > .001) invalidFlows++;
      colors.add(`${state.colors[i]},${state.colors[i + 1]},${state.colors[i + 2]}`);
    }
    return { count: state.count, invalidSources, mismatchedColors, invalidFlows, distinctColors: colors.size };
  });
  assert.equal(results.curtainSourceMask.invalidSources, 0, 'Every emitter must come from an opaque pixel of cortina def');
  assert.equal(results.curtainSourceMask.mismatchedColors, 0, 'Emitter RGBA must reproduce the supplied artwork, including alpha');
  assert.equal(results.curtainSourceMask.invalidFlows, 0, 'Each opaque vertical segment must have an independent waterfall channel');
  assert.ok(results.curtainSourceMask.distinctColors > 100, 'The curtain must retain its original shading');
  results.initialCurtainCoverage = await page.evaluate(curtainViewportCoverage);
  assert.equal(results.initialCurtainCoverage.offscreenSources, 0, 'Only visible curtain pixels may consume the particle budget');
  assert.equal(results.initialCurtainCoverage.offscreenFlows, 0, 'Waterfall streams must wrap within the visible crop');
  results.sourceMask = await page.evaluate(async () => {
    const sources = window.__sandGpu.sources();
    const emitter = document.querySelector('[data-sand-frame]'), hero = document.querySelector('[data-sand-hero]');
    const frame = new Image(); frame.src = emitter.dataset.sandMask; await frame.decode();
    const r = emitter.getBoundingClientRect(), h = hero.getBoundingClientRect();
    const sample = document.createElement('canvas'); sample.width = frame.naturalWidth; sample.height = frame.naturalHeight;
    const context = sample.getContext('2d'); context.drawImage(frame, 0, 0);
    const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
    let invalidSources = 0, topMin = Infinity, topMax = -Infinity;
    for (let i = 0; i < sources.length; i += 4) {
      const x = Math.floor((sources[i] - r.left + h.left) / r.width * sample.width);
      const y = Math.floor((sources[i + 1] - r.top + h.top) / r.height * sample.height);
      if (pixels[(y * sample.width + x) * 4 + 3] < 128) invalidSources++;
      if (y < 10 && x > 10 && x < sample.width - 10) { topMin = Math.min(topMin, y); topMax = Math.max(topMax, y); }
    }
    const row = Math.floor(sample.height / 2);
    let nativeStroke = 0;
    while (pixels[(row * sample.width + nativeStroke) * 4 + 3] >= 128) nativeStroke++;
    return { invalidSources, total: sources.length / 4, source: new URL(frame.src).pathname,
      width: sample.width, height: sample.height, nativeStroke, topMin, topMax };
  });
  assert.equal(results.sourceMask.invalidSources, 0);
  assert.equal(results.sourceMask.source, '/assets/images/marco.webp');
  assert.equal(results.sourceMask.nativeStroke, 10);
  assert.equal(results.sourceMask.topMin, 0);
  assert.equal(results.sourceMask.topMax, 9);
  await page.evaluate(() => { window.__sandInitial = window.__sandGpu.snapshot().positions; });
  await page.screenshot({ path: 'artifacts/hero-gpu-desktop.png' });
  await page.waitForTimeout(500);
  results.continuousFlow = await page.evaluate(() => {
    const next = window.__sandGpu.snapshot().positions, previous = window.__sandInitial;
    let moved = 0;
    for (let i = 0; i < next.length; i += 4) if (Math.hypot(next[i] - previous[i], next[i + 1] - previous[i + 1]) > 1) moved++;
    delete window.__sandInitial;
    return { moved, count: next.length / 4 };
  });
  assert.ok(results.continuousFlow.moved > results.continuousFlow.count * .8);
  results.untouchedFrame = await page.evaluate(async () => {
    const gpu = window.__sandGpu;
    gpu.step(110, { x: -1000, y: -1000, previousX: -1000, previousY: -1000, radius: 10, active: false });
    const state = gpu.snapshot(), emitter = document.querySelector('[data-sand-frame]');
    const hero = document.querySelector('[data-sand-hero]'), r = emitter.getBoundingClientRect(), h = hero.getBoundingClientRect();
    const image = new Image(); image.src = emitter.dataset.sandMask; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const alpha = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let outsideMask = 0, falling = 0, contacts = 0;
    for (let i = 0; i < state.count; i++) {
      const offset = i * 4;
      const x = Math.floor((state.positions[offset] - r.left + h.left) / r.width * canvas.width);
      const y = Math.floor((state.positions[offset + 1] - r.top + h.top) / r.height * canvas.height);
      if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height || alpha[(y * canvas.width + x) * 4 + 3] < 128) outsideMask++;
      falling += state.positions[offset + 3]; contacts += state.positions[offset + 2];
    }
    gpu.reset();
    return { outsideMask, falling, contacts, count: state.count };
  });
  assert.equal(results.untouchedFrame.outsideMask, 0, 'Circulating grains must remain inside the original frame alpha after full laps');
  assert.equal(results.untouchedFrame.falling, 0, 'No grain may fall without a cursor contact');
  assert.equal(results.untouchedFrame.contacts, 0);
  // The SVG logo stays visible and unchanged during a real hover.
  const logoBefore = await page.locator('[data-logo-image]').boundingBox();
  await page.mouse.move(logoBefore.x + logoBefore.width * .58, logoBefore.y + logoBefore.height * .48);
  await page.waitForTimeout(150);
  assert.equal(await page.locator('[data-logo-image]').isVisible(), true);
  assert.deepEqual(await page.locator('[data-logo-image]').boundingBox(), logoBefore);
  results.staticLogo = await page.evaluate(() => ({
    effect: document.querySelector('[data-sand-hero]').dataset.logoEffect,
    gpuLogoAbsent: !('logo' in window.__sandGpu) && !('stepLogo' in window.__sandGpu),
    visibility: getComputedStyle(document.querySelector('[data-logo-image]')).visibility,
    logoLayer: Number(getComputedStyle(document.querySelector('[data-logo-image]')).zIndex),
    curtainLayer: Number(getComputedStyle(document.querySelector('[data-curtain-image]')).zIndex),
    frameLayer: Number(getComputedStyle(document.querySelector('[data-sand-canvas]')).zIndex),
    logoBlend: getComputedStyle(document.querySelector('[data-logo-image]')).mixBlendMode,
  }));
  assert.equal(results.staticLogo.effect, 'none');
  assert.equal(results.staticLogo.gpuLogoAbsent, true);
  assert.equal(results.staticLogo.visibility, 'visible');
  assert.ok(results.staticLogo.logoLayer > results.staticLogo.curtainLayer &&
    results.staticLogo.logoLayer > results.staticLogo.frameLayer, 'The logo must be composited above the curtain effect');
  assert.equal(results.staticLogo.logoBlend, 'normal');
  await page.mouse.move(1300, 650);
  await page.evaluate(() => document.querySelector('[data-sand-toggle]').click());
  results.posterBeforeShaderDiagnostics = await assertCurtainPoster(page);
  results.curtainFlow = await page.evaluate(() => {
    const gpu = window.__sandGpu;
    const none = { x: -1000, y: -1000, previousX: -1000, previousY: -1000, radius: 10, active: false };
    gpu.reset();
    const initial = gpu.curtain();
    const sampleMask = state => {
      const fixture = window.__curtainFixture;
      let outsideMask = 0, detached = 0, contacts = 0, finite = true;
      for (let index = 0; index < state.count; index++) {
        const i = index * 4;
        const x = Math.floor((state.positions[i] - state.rect.x) / state.rect.width * fixture.width);
        const y = Math.floor((state.positions[i + 1] - state.rect.y) / state.rect.height * fixture.height);
        if (x < 0 || y < 0 || x >= fixture.width || y >= fixture.height || fixture.pixels[(y * fixture.width + x) * 4 + 3] < 128) outsideMask++;
        detached += state.positions[i + 3]; contacts += state.positions[i + 2];
        for (let channel = 0; channel < 4; channel++) finite &&= Number.isFinite(state.positions[i + channel]) && Number.isFinite(state.velocities[i + channel]);
      }
      return { outsideMask, detached, contacts, finite };
    };
    gpu.step(.05, none);
    const advanced = gpu.curtain();
    let moved = 0, descending = 0, wrapped = 0;
    for (let index = 0; index < advanced.count; index++) {
      const i = index * 4, dy = advanced.positions[i + 1] - initial.positions[i + 1];
      if (Math.abs(dy) > 1) moved++;
      if (dy > 0) descending++;
      else if (dy < 0) wrapped++;
    }
    const afterShortStep = sampleMask(advanced);
    // A deliberately large shader tick crosses the bottom of every long channel.
    // This verifies modulo recycling directly, independently of real frame rate.
    gpu.step(20, none);
    const afterFullLoops = sampleMask(gpu.curtain());
    gpu.reset();
    const restored = gpu.curtain();
    let resetError = 0;
    for (let i = 0; i < initial.count * 4; i++) {
      resetError = Math.max(resetError, Math.abs(restored.positions[i] - initial.positions[i]),
        Math.abs(restored.velocities[i] - initial.velocities[i]));
    }
    return { count: initial.count, moved, descending, wrapped, afterShortStep, afterFullLoops, resetError };
  });
  assert.ok(results.curtainFlow.moved > results.curtainFlow.count * .8, 'The waterfall must keep flowing without a cursor');
  assert.ok(results.curtainFlow.descending > results.curtainFlow.count * .8);
  for (const state of [results.curtainFlow.afterShortStep, results.curtainFlow.afterFullLoops]) {
    assert.equal(state.outsideMask, 0, 'Uninterrupted waterfall channels must preserve every gap and edge in the original silhouette');
    assert.equal(state.detached, 0); assert.equal(state.contacts, 0); assert.equal(state.finite, true);
  }
  assert.equal(results.curtainFlow.resetError, 0, 'Reset must restore both GPU position and velocity textures exactly');
  // Explicit diagnostic draws inspect the actual shaders while the user-facing pause remains a poster.
  await page.evaluate(() => {
    document.querySelector('[data-curtain-image]').style.visibility = 'hidden';
    window.__sandGpu.redraw(true);
  });
  const initialCurtain = await page.screenshot({ path: 'artifacts/curtain-waterfall-initial.png' });
  await page.evaluate(() => {
    const none = { x: -1000, y: -1000, previousX: -1000, previousY: -1000, radius: 10, active: false };
    for (let tick = 0; tick < 12; tick++) window.__sandGpu.step(1 / 120, none);
    window.__sandGpu.redraw(true);
  });
  const animatedCurtain = await page.screenshot({ path: 'artifacts/curtain-waterfall-animated.png' });
  results.curtainAnimation = await page.evaluate(async ({ initial, animated }) => {
    const decode = async bytes => {
      const image = new Image(); image.src = 'data:image/png;base64,' + bytes; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return { width: canvas.width, height: canvas.height, rgba: context.getImageData(0, 0, canvas.width, canvas.height).data };
    };
    const before = await decode(initial), after = await decode(animated);
    const state = window.__sandGpu.curtain(), mask = document.createElement('canvas');
    mask.width = after.width; mask.height = after.height;
    const context = mask.getContext('2d'), ratio = after.width / innerWidth;
    context.drawImage(document.querySelector('[data-curtain-image]'), state.rect.x * ratio, state.rect.y * ratio,
      state.rect.width * ratio, state.rect.height * ratio);
    const alpha = context.getImageData(0, 0, mask.width, mask.height).data;
    let inside = 0, changedInside = 0;
    for (let i = 0; i < after.rgba.length; i += 4) if (alpha[i + 3] > 240) {
      inside++;
      if ([0, 1, 2].some(channel => Math.abs(before.rgba[i + channel] - after.rgba[i + channel]) > 2)) changedInside++;
    }
    return { inside, changedInside };
  }, { initial: initialCurtain.toString('base64'), animated: animatedCurtain.toString('base64') });
  assert.ok(results.curtainAnimation.inside > 100000);
  assert.ok(results.curtainAnimation.changedInside > 10000, 'GPU particles must visibly flow throughout the curtain');
  await page.evaluate(() => { window.__sandGpu.reset(); window.__sandGpu.redraw(true); });
  const restoredCurtain = await page.screenshot({ path: 'artifacts/curtain-waterfall-restored.png' });
  assert.deepEqual(restoredCurtain, initialCurtain, 'Reset must restore the same particle artwork and static logo');
  results.curtainPhysics = await page.evaluate(() => {
    const gpu = window.__sandGpu;
    gpu.reset();
    const none = { x: -1000, y: -1000, previousX: -1000, previousY: -1000, radius: 10, active: false };
    const initial = gpu.curtain();
    let index = -1;
    for (let candidate = 0; candidate < initial.count; candidate++) {
      const i = candidate * 4, top = initial.flows[i], bottom = initial.flows[i + 1], x = initial.flows[i + 2];
      if (x > 100 && x < innerWidth - 100 && bottom - top > 100 && (top + bottom) * .5 > 100
        && (top + bottom) * .5 < document.querySelector('[data-sand-hero]').clientHeight - 100) { index = candidate; break; }
    }
    if (index < 0) throw new Error('No visible curtain channel available for the GPU physics probe');
    const offset = index * 4, flow = Array.from(initial.flows.slice(offset, offset + 4));
    const source = Array.from(initial.sources.slice(offset, offset + 4));
    const x = flow[2], y = (flow[0] + flow[1]) * .5, seed = source[2], speed = 80 + seed * 90;
    const particle = () => {
      const state = gpu.curtain();
      return { position: Array.from(state.positions.slice(offset, offset + 4)),
        velocity: Array.from(state.velocities.slice(offset, offset + 4)) };
    };
    gpu.setCurtainParticle(index, [x, y, 0, 0], [0, 120, seed, -1]);
    gpu.step(.01, none);
    const channelGravity = particle();
    gpu.setCurtainParticle(index, [x, flow[1] - .2, 0, 0], [0, 1000, seed, -1]);
    gpu.step(.01, none);
    const wrap = particle();
    gpu.setCurtainParticle(index, [x, y, 0, 0], [0, 120, seed, -1]);
    gpu.step(.01, { ...none, x: x + 12, y, previousX: x + 12, previousY: y, active: true });
    const nearMiss = particle();
    gpu.setCurtainParticle(index, [x, y, 0, 0], [0, 120, seed, -1]);
    gpu.step(.01, { ...none, x: x + 8, y, previousX: x + 8, previousY: y, active: true });
    const detached = particle();
    gpu.step(.01, none);
    const detachedFall = particle();
    gpu.setCurtainParticle(index, [400, 200, 0, 1], [0, 0, seed, 0]);
    gpu.step(.01, none);
    const gravity = particle();
    gpu.setCurtainParticle(index, [400, 255, 0, 1], [0, 500, seed, 0]);
    gpu.step(1 / 120, { ...none, x: 400, y: 260, previousX: 400, previousY: 260, active: true });
    const bounce = particle();
    gpu.setCurtainParticle(index, [400, 400, 0, 1], [0, 0, seed, 0]);
    gpu.step(1 / 120, { ...none, x: 600, y: 400, previousX: 200, previousY: 400, active: true });
    const sweep = particle();
    const heroHeight = document.querySelector('[data-sand-hero]').clientHeight;
    gpu.setCurtainParticle(index, [400, heroHeight + 21, 0, 1], [0, 100, seed, 0]);
    gpu.step(.01, none);
    const recycled = particle();
    gpu.setCurtainParticle(index, [400, 200, 0, 1], [0, 0, seed, 3.195]);
    gpu.step(.01, none);
    const ageRecycled = particle();
    const fixture = window.__curtainFixture;
    let outsidePoint;
    for (let py = 90.5; py < heroHeight - 80 && !outsidePoint; py += 29) {
      for (let px = 90.5; px < innerWidth - 80; px += 29) {
        const nativeX = Math.floor((px - initial.rect.x) / initial.rect.width * fixture.width);
        const nativeY = Math.floor((py - initial.rect.y) / initial.rect.height * fixture.height);
        if (nativeX >= 0 && nativeY >= 0 && nativeX < fixture.width && nativeY < fixture.height &&
          fixture.pixels[(nativeY * fixture.width + nativeX) * 4 + 3] === 0) { outsidePoint = [px, py]; break; }
      }
    }
    if (!outsidePoint) throw new Error('The supplied curtain must have transparent space for the detached rendering probe');
    gpu.setCurtainParticle(index, [...outsidePoint, 0, 1], [0, 0, seed, .1]);
    gpu.step(1 / 120, none);
    gpu.redraw(true);
    const detachedOutsideMask = particle(), glow = gpu.glow(detachedOutsideMask.position[0], detachedOutsideMask.position[1]);
    const rendererMask = getComputedStyle(document.querySelector('[data-sand-canvas]')).maskImage;
    const glError = document.querySelector('[data-sand-canvas]').getContext('webgl2').getError();
    gpu.reset();
    return { index, flow, source, speed, x, y, channelGravity, wrap, nearMiss, detached, detachedFall,
      gravity, bounce, sweep, recycled, ageRecycled, outsidePoint, detachedOutsideMask, glow, rendererMask, glError };
  });
  const curtainPhysics = results.curtainPhysics;
  const channelVelocity = 120 * Math.exp(-2.6 * .01) + 9.81;
  assert.ok(Math.abs(curtainPhysics.channelGravity.velocity[1] - channelVelocity) < .01);
  assert.ok(Math.abs(curtainPhysics.channelGravity.position[1] - (curtainPhysics.y + channelVelocity * .01)) < .01);
  assert.equal(curtainPhysics.channelGravity.position[3], 0);
  assert.equal(curtainPhysics.channelGravity.velocity[3], -1);
  const channelLength = curtainPhysics.flow[1] - curtainPhysics.flow[0];
  const wrapVelocity = 1000 * Math.exp(-2.6 * .01) + 9.81;
  const expectedWrappedY = curtainPhysics.flow[0] + (channelLength - .2 + wrapVelocity * .01) % channelLength;
  assert.ok(Math.abs(curtainPhysics.wrap.position[1] - expectedWrappedY) < .01);
  assert.ok(Math.abs(curtainPhysics.wrap.velocity[1] - curtainPhysics.speed) < .01);
  assert.equal(curtainPhysics.wrap.position[3], 0);
  assert.equal(curtainPhysics.nearMiss.position[3], 0, 'A cursor 12 px away must not detach curtain particles');
  assert.equal(curtainPhysics.nearMiss.position[2], 0);
  assert.equal(curtainPhysics.detached.position[3], 1, 'Curtain grains 8 px from the cursor must detach with the same frame physics');
  assert.ok(curtainPhysics.detached.position[2] > 0);
  assert.ok(Math.abs(curtainPhysics.detachedFall.velocity[1] -
    (curtainPhysics.detached.velocity[1] * Math.exp(-.45 * .01) + 9.81)) < .04);
  assert.ok(Math.abs(curtainPhysics.gravity.velocity[1] - 9.81) < .01);
  assert.ok(Math.abs(curtainPhysics.gravity.position[1] - 200.0981) < .01);
  assert.ok(curtainPhysics.bounce.position[2] > 0 && curtainPhysics.bounce.velocity[1] < 0);
  assert.ok(Math.hypot(curtainPhysics.bounce.position[0] - 400, curtainPhysics.bounce.position[1] - 260) > 10);
  assert.ok(curtainPhysics.sweep.position[2] > 0 && curtainPhysics.sweep.position[0] > 600,
    'A fast-moving cursor must collide continuously rather than tunnel through curtain particles');
  for (const recycled of [curtainPhysics.recycled, curtainPhysics.ageRecycled]) {
    assert.equal(recycled.position[3], 0); assert.equal(recycled.velocity[3], -1);
    assert.ok(Math.hypot(recycled.position[0] - curtainPhysics.source[0], recycled.position[1] - curtainPhysics.source[1]) < .001);
    assert.ok(Math.abs(recycled.velocity[1] - curtainPhysics.speed) < .01);
  }
  assert.equal(curtainPhysics.rendererMask, 'none');
  assert.ok(curtainPhysics.glow.particles[3] > 0, 'Detached curtain grains must still render outside their original silhouette');
  assert.equal(curtainPhysics.glError, 0);
  await page.evaluate(() => {
    document.querySelector('[data-curtain-image]').style.removeProperty('visibility');
    window.__sandGpu.redraw();
  });
  results.posterAfterShaderDiagnostics = await assertCurtainPoster(page);
  await page.locator('[data-sand-toggle]').click();
  const rect = await page.locator('[data-sand-frame]').boundingBox();
  await page.mouse.move(rect.x + 1, rect.y + rect.height * .45);
  await page.waitForTimeout(500);
  const contactStart = await stateSummary();
  await page.waitForTimeout(700);
  results.stationaryCursor = await stateSummary();
  assert.ok(results.stationaryCursor.contacts > contactStart.contacts, 'The live GPU stream must keep hitting a stationary cursor');
  assert.equal(results.stationaryCursor.finite, true);
  assert.ok(results.stationaryCursor.activeSparks > 0, 'Actual GPU contacts must launch the secondary particles');
  await page.screenshot({ path: 'artifacts/hero-gpu-collision.png' });
  await page.mouse.move(rect.x + 70, rect.y + rect.height * .5, { steps: 10 });
  await page.waitForTimeout(350);
  await page.screenshot({ path: 'artifacts/hero-gpu-fan.png' });

  // Pause the real animation and test the actual GPU shader, not a CPU replica.
  await page.locator('[data-sand-toggle]').click();
  const pausedTime = (await metrics()).sandTime;
  const pausedCurtain = await page.evaluate(() => Array.from(window.__sandGpu.curtain().positions));
  await page.waitForTimeout(150);
  assert.equal((await metrics()).sandTime, pausedTime);
  assert.deepEqual(await page.evaluate(() => Array.from(window.__sandGpu.curtain().positions)), pausedCurtain,
    'Pause must freeze the actual waterfall GPU texture');
  results.posterAfterCursorCollisions = await assertCurtainPoster(page);
  results.shaderPhysics = await page.evaluate(() => {
    const gpu = window.__sandGpu;
    gpu.reset();
    const none = { x: -1000, y: -1000, previousX: -1000, previousY: -1000, radius: 10, active: false };
    const particle = () => {
      const state = gpu.snapshot();
      return { position: Array.from(state.positions.slice(0, 4)), velocity: Array.from(state.velocities.slice(0, 4)),
        impact: Array.from(state.impacts.slice(0, 4)), sparkPosition: Array.from(state.sparks.positions.slice(0, 4)),
        sparkVelocity: Array.from(state.sparks.velocities.slice(0, 4)) };
    };
    const route = Array.from(gpu.routes().slice(0, 4)), sourceSeed = gpu.sources()[2];
    const [left, top, width, height] = route, speed = 48 + sourceSeed * 32;
    gpu.setParticle(0, [left + width - .2, top, 0, 0], [speed, 0, width - .2, -1]);
    gpu.step(.01, none);
    const corner = particle();
    gpu.setParticle(0, [left, top + .2, 0, 0], [0, -speed, 2 * (width + height) - .2, -1]);
    gpu.step(.01, none);
    const wrap = particle();
    const startX = left + width * .3, phase = width * .3;
    gpu.setParticle(0, [startX, top, 0, 0], [speed, 0, phase, -1]);
    gpu.step(.01, { ...none, x: startX, y: top + 12, previousX: startX, previousY: top + 12, active: true });
    const nearMiss = particle();
    gpu.setParticle(0, [startX, top, 0, 0], [speed, 0, phase, -1]);
    gpu.step(.01, { ...none, x: startX, y: top + 8, previousX: startX, previousY: top + 8, active: true });
    const detached = particle();
    gpu.step(.01, none);
    const detachedFall = particle();
    gpu.setParticle(0, [400, 200, 0, 0], [0, 0, .3, 0]);
    gpu.step(.01, none);
    const gravity = particle();
    gpu.setParticle(0, [400, 255, 0, 1], [0, 500, .3, 0]);
    gpu.step(1 / 120, { ...none, x: 400, y: 260, previousX: 400, previousY: 260, active: true });
    const bounce = particle();
    gpu.step(.01, none);
    const sparkFall = particle();
    gpu.setParticle(0, [400, 400, 0, 0], [0, 0, .3, 0]);
    gpu.step(1 / 120, { ...none, x: 600, y: 400, previousX: 200, previousY: 400, active: true });
    const sweep = particle();
    gpu.setParticle(0, [400, 921, 0, 0], [0, 100, .3, 0]);
    gpu.step(1 / 120, none);
    const recycled = particle(), source = Array.from(gpu.sources().slice(0, 4));
    gpu.setParticle(0, [420, 200, 0, 0], [0, 0, .3, 0]);
    gpu.setParticle(1, [420, 200, 0, 0], [0, 0, .3, 0]);
    gpu.step(.01, none);
    const independent = gpu.snapshot().positions;
    const independentDistance = Math.hypot(independent[0] - independent[4], independent[1] - independent[5]);
    gpu.step(1.8, none);
    const expiredSpark = particle().sparkPosition;
    gpu.reset();
    return { route, corner, wrap, nearMiss, detached, detachedFall, gravity, bounce, sparkFall,
      sweep, recycled, source, independentDistance, expiredSpark };
  });
  const physics = results.shaderPhysics;
  assert.ok(Math.abs(physics.corner.position[0] - (physics.route[0] + physics.route[2])) < .003);
  assert.ok(physics.corner.position[1] > physics.route[1] && physics.corner.position[1] < physics.route[1] + 1);
  assert.equal(physics.corner.position[3], 0);
  assert.equal(physics.corner.velocity[3], -1);
  assert.ok(Math.abs(physics.wrap.position[1] - physics.route[1]) < .003 && physics.wrap.velocity[0] > 0);
  assert.equal(physics.wrap.position[3], 0);
  assert.equal(physics.nearMiss.position[3], 0, 'A cursor 12 px away must not detach particles');
  assert.equal(physics.nearMiss.position[2], 0);
  assert.equal(physics.detached.position[3], 1, 'A grain 8 px from the cursor must detach within its 10 px radius');
  assert.ok(physics.detached.position[2] > 0);
  assert.ok(Math.abs(physics.detachedFall.velocity[1] -
    (physics.detached.velocity[1] * Math.exp(-.04 * .01) + 9.81)) < .04);
  assert.ok(Math.abs(physics.gravity.velocity[1] - 9.81) < .01);
  assert.ok(Math.abs(physics.gravity.position[1] - 200.0981) < .01);
  assert.ok(physics.bounce.position[2] > 0 && physics.bounce.velocity[1] < 0);
  assert.ok(Math.hypot(physics.bounce.position[0] - 400, physics.bounce.position[1] - 260) > 10);
  assert.ok(physics.bounce.impact[2] >= 0 && physics.bounce.sparkPosition[3] >= 0);
  assert.ok(Math.abs(physics.sparkFall.sparkVelocity[1] -
    (physics.bounce.sparkVelocity[1] * Math.exp(-1.65 * .01) + 9.81)) < .04, 'Secondary particles must obey gravity and air resistance');
  assert.ok(Math.hypot(physics.bounce.sparkPosition[0] - 400, physics.bounce.sparkPosition[1] - 260) > 10);
  assert.equal(physics.expiredSpark[0], -10000, 'Secondary particles must expire');
  assert.ok(physics.sweep.position[2] > 0 && physics.sweep.position[0] > 600);
  assert.equal(physics.recycled.position[3], 0);
  assert.equal(physics.recycled.velocity[3], -1);
  assert.ok(Math.hypot(physics.recycled.position[0] - physics.source[0], physics.recycled.position[1] - physics.source[1]) < 3);
  assert.ok(physics.independentDistance < .001, 'Particles in the supplied reference do not collide with each other');
  results.visualStyle = await page.evaluate(() => {
    const gpu = window.__sandGpu;
    const none = { x: -1000, y: -1000, previousX: -1000, previousY: -1000, radius: 10, active: false };
    const source = gpu.sources();
    const age = Math.sqrt(2 * Math.max(1, 920 - source[1]) / 981) * .28;
    gpu.setParticle(0, [1320.5, 710.5, 0, 0], [0, 0, .3, age]);
    gpu.step(1 / 120, none);
    const core = gpu.glow(1320.5, 710.5), halo = gpu.glow(1326.5, 710.5);
    const error = document.querySelector('[data-sand-canvas]').getContext('webgl2').getError();
    gpu.reset();
    return { core, halo, glError: error };
  });
  assert.equal(results.visualStyle.glError, 0);
  assert.ok(results.visualStyle.core.particles[3] > 0);
  assert.ok(results.visualStyle.halo.particles[3] < results.visualStyle.core.particles[3]);
  assert.ok(results.visualStyle.halo.bloom[3] > .000001, 'The blur must produce a real halo outside the particle sprite');
  await page.locator('[data-sand-toggle]').click();
  await page.evaluate(() => window.scrollTo(0, 0));

  results.viewports = [];
  for (const [width, height] of [[320, 812], [375, 812], [768, 900], [923, 805], [1024, 900], [1440, 900], [1900, 867], [1920, 1080]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(350);
    await page.waitForSelector('[data-sand-ready="true"][data-curtain-ready="true"]');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal((await metrics()).sandReady, 'true');
    assertParticleBudget(await metrics(), width);
    assert.equal((await metrics()).curtainReady, 'true');
    assert.equal((await metrics()).curtainEffect, 'particle-waterfall');
    assert.equal(Number((await metrics()).curtainGravity), 981);
    const alignment = await page.evaluate(() => {
      const hero = document.querySelector('[data-sand-hero]'), state = window.__sandGpu.curtain();
      const scale = Math.max(hero.clientWidth / 1672, hero.clientHeight / 941);
      const expected = { x: (hero.clientWidth - 1672 * scale) / 2, y: (hero.clientHeight - 941 * scale) / 2,
        width: 1672 * scale, height: 941 * scale };
      return Math.max(...Object.keys(expected).map(key => Math.abs(state.rect[key] - expected[key])));
    });
    assert.ok(alignment < .01, 'Resize must keep the particle curtain aligned with its background');
    const coverage = await page.evaluate(curtainViewportCoverage);
    assert.equal(coverage.offscreenSources, 0, 'All curtain emitters must remain on screen after resize, including the mobile cover crop');
    assert.equal(coverage.offscreenFlows, 0);
    assert.equal(await page.locator('[data-logo-image]').isVisible(), true);
    const lettering = await logoContainment(page);
    assert.ok(lettering.containment >= (width >= 900 ? 1 : .99), `The ${lettering.scope} must remain contained by the curtain at ${width} x ${height}; actual ${(lettering.containment * 100).toFixed(2)}%`);
    if (width >= 900) assert.ok(lettering.centerOffset < 12, `The complete logo must remain centered at ${width} x ${height}`);
    assert.equal(lettering.outsideViewport, 0);
    results.viewports.push({ width, height, ...await metrics(), ...await stateSummary(), curtainCoverage: coverage, lettering });
    if (width === 375) await page.screenshot({ path: 'artifacts/hero-gpu-mobile.png' });
    if (width === 923) await page.screenshot({ path: 'artifacts/curtain-play-playing-halfscreen.png' });
    if (width === 1900) await page.screenshot({ path: 'artifacts/curtain-play-playing-fullscreen.png' });
  }
  await activateCurtainControl(page);
  await page.waitForSelector('[data-curtain-state="paused"]');
  await page.setViewportSize({ width: 1900, height: 867 });
  await page.waitForTimeout(350);
  await page.waitForSelector('[data-sand-ready="true"][data-curtain-ready="true"][data-curtain-state="paused"]');
  await assertCurtainControl(page, false);
  const resizedPaused = await page.evaluate(() => Array.from(window.__sandGpu.curtain().positions));
  const resizedFrameTime = Number((await metrics()).sandTime);
  await page.waitForTimeout(220);
  assert.deepEqual(await page.evaluate(() => Array.from(window.__sandGpu.curtain().positions)), resizedPaused,
    'Rebuilding the viewport must preserve a paused cascade');
  assert.ok(Number((await metrics()).sandTime) > resizedFrameTime);
  results.resizedPausePoster = await assertCurtainPoster(page);
  await page.screenshot({ path: 'artifacts/curtain-poster-paused-fullscreen.png' });
  const resizedPreparations = (await metrics()).curtainPreparations;
  await activateCurtainControl(page);
  await page.waitForSelector('[data-curtain-state="playing"]');
  await assertCurtainControl(page, true);
  assert.equal((await metrics()).curtainPreparations, resizedPreparations);
  results.pausedCurtainSurvivesResize = true;
  await page.screenshot({ path: 'artifacts/curtain-persistent-control-desktop.png' });
  results.idleViewports = [];
  for (const [width, height, name] of [[923, 805, 'halfscreen'], [1900, 867, 'fullscreen']]) {
    const idlePage = await browser.newPage({ viewport: { width, height } });
    await idlePage.addInitScript(observeCurtainWorkers);
    await idlePage.goto(baseURL.href); await idlePage.waitForSelector('[data-sand-ready="true"]');
    const idle = await assertIdleCurtain(idlePage), lettering = await logoContainment(idlePage);
    assert.equal(lettering.containment, 1, 'The idle desktop poster must contain the full painted logo');
    assert.ok(lettering.centerOffset < 12);
    await idlePage.screenshot({ path: `artifacts/curtain-play-idle-${name}.png` });
    results.idleViewports.push({ width, height, idle, lettering });
    await idlePage.close();
  }
  const touchPage = await browser.newPage({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
  touchPage.setDefaultTimeout(12000);
  await touchPage.addInitScript(observeCurtainWorkers);
  await touchPage.goto(baseURL.href); await touchPage.waitForSelector('[data-sand-ready="true"]');
  await touchPage.waitForTimeout(300);
  const touchRect = await touchPage.locator('[data-sand-frame]').boundingBox();
  await touchPage.touchscreen.tap(touchRect.x + 2, touchRect.y + touchRect.height * .4);
  results.touchTap = await touchPage.evaluate(() => {
    const positions = window.__sandGpu.snapshot().positions;
    let contacts = 0;
    for (let i = 2; i < positions.length; i += 4) contacts += positions[i];
    return contacts;
  });
  assert.ok(results.touchTap > 0);
  results.touchIdle = await assertIdleCurtain(touchPage);
  await touchPage.screenshot({ path: 'artifacts/curtain-play-idle-mobile.png' });
  await playCurtain(touchPage, 'touch');
  results.touchPlay = await touchPage.locator('[data-sand-hero]').evaluate(el => ({ ...el.dataset }));
  assert.equal(Number(results.touchPlay.curtainPreparations), 1);
  const touchActivationContacts = await touchPage.evaluate(() => {
    const state = window.__sandGpu.curtain(); let contacts = 0;
    for (let i = 2; i < state.count * 4; i += 4) contacts += state.positions[i];
    return contacts;
  });
  assert.equal(touchActivationContacts, 0, 'Touching Play must not disturb the waterfall or launch a cursor sweep');
  results.mobileCurtainToggle = await verifyCurtainToggle(touchPage, 'touch');
  await touchPage.screenshot({ path: 'artifacts/curtain-persistent-control-mobile.png' });
  assert.equal(await touchPage.locator('[data-logo-image]').isVisible(), true);
  assert.equal(await touchPage.locator('[data-sand-hero]').getAttribute('data-curtain-ready'), 'true');
  assert.equal(await touchPage.locator('[data-sand-hero]').getAttribute('data-curtain-effect'), 'particle-waterfall');
  assert.equal(await touchPage.locator('[data-sand-hero]').getAttribute('data-logo-effect'), 'none');
  const curtainTap = await touchPage.evaluate(() => {
    const state = window.__sandGpu.curtain(), hero = document.querySelector('[data-sand-hero]');
    for (let index = 0; index < state.count; index++) {
      const i = index * 4, x = state.positions[i], y = state.positions[i + 1];
      if (x > 35 && x < innerWidth - 35 && y > 70 && y < hero.clientHeight - 70) return { x, y };
    }
    throw new Error('No visible curtain particles available for touch verification');
  });
  await touchPage.touchscreen.tap(curtainTap.x, curtainTap.y);
  results.curtainTouchTap = await touchPage.evaluate(() => {
    const state = window.__sandGpu.curtain();
    let contacts = 0;
    for (let i = 2; i < state.count * 4; i += 4) contacts += state.positions[i];
    return contacts;
  });
  assert.ok(results.curtainTouchTap > 0, 'A touch must disturb the real waterfall particles');
  await touchPage.close();

  const workerFallbackPage = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const workerFallbackErrors = [];
  workerFallbackPage.on('pageerror', error => workerFallbackErrors.push(error.message));
  await workerFallbackPage.addInitScript(() => {
    window.Worker = class {
      constructor() { throw new DOMException('Worker blocked by verification fixture', 'SecurityError'); }
    };
  });
  await workerFallbackPage.goto(baseURL.href);
  await workerFallbackPage.waitForSelector('[data-sand-ready="true"]');
  await assertIdleCurtain(workerFallbackPage);
  await playCurtain(workerFallbackPage);
  results.workerFailureFallback = await workerFallbackPage.locator('[data-sand-hero]').evaluate(el => ({ ...el.dataset }));
  assert.equal(results.workerFailureFallback.sandSeedPreparation, 'main-thread', 'A blocked Worker must initialize from the same pixels on the main thread');
  assertParticleBudget(results.workerFailureFallback, 390);
  assert.deepEqual(workerFallbackErrors, []);
  assert.equal(await workerFallbackPage.locator('[data-logo-image]').isVisible(), true);
  await workerFallbackPage.close();

  const economyPage = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const economyErrors = [];
  economyPage.on('pageerror', error => economyErrors.push(error.message));
  await economyPage.addInitScript(() => {
    Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, get: () => 2 });
    Object.defineProperty(navigator, 'deviceMemory', { configurable: true, get: () => 2 });
  });
  await economyPage.addInitScript(observeCurtainWorkers);
  await economyPage.goto(baseURL.href);
  await economyPage.waitForSelector('[data-sand-ready="true"]');
  await assertIdleCurtain(economyPage);
  await playCurtain(economyPage);
  results.economyDevice = await economyPage.locator('[data-sand-hero]').evaluate(el => ({ ...el.dataset }));
  assert.equal(results.economyDevice.sandQuality, 'economy');
  assertParticleBudget(results.economyDevice, 390);
  results.economyCurtainCoverage = await economyPage.evaluate(curtainViewportCoverage);
  assert.equal(results.economyCurtainCoverage.offscreenSources, 0);
  assert.equal(results.economyCurtainCoverage.offscreenFlows, 0);
  assert.deepEqual(economyErrors, []);
  await economyPage.close();

  const racePage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const raceErrors = [];
  racePage.on('pageerror', error => raceErrors.push(error.message));
  await racePage.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.__seedWorkerJobs = 0;
    window.__curtainWorkerJobs = 0;
    window.__curtainImageJobs = 0;
    window.Worker = class extends NativeWorker {
      postMessage(...args) {
        window.__seedWorkerJobs++;
        if (args[0]?.kind === 'curtain-prepare') window.__curtainWorkerJobs++;
        if (args[0]?.kind === 'curtain-image') window.__curtainImageJobs++;
        return super.postMessage(...args);
      }
      set onmessage(callback) {
        super.onmessage = callback ? event => setTimeout(() => callback.call(this, event), 180) : null;
      }
      get onmessage() { return super.onmessage; }
    };
  });
  await racePage.goto(baseURL.href, { waitUntil: 'domcontentloaded' });
  await racePage.waitForFunction(() => window.__seedWorkerJobs > 0);
  for (const width of [768, 390, 1024, 390]) await racePage.setViewportSize({ width, height: 844 });
  await racePage.waitForSelector('[data-sand-ready="true"]');
  await racePage.waitForTimeout(450);
  results.idleResizeDuringStartup = await assertIdleCurtain(racePage);
  assertParticleBudget(results.idleResizeDuringStartup, 390, false);
  const raceFrameBefore = await racePage.locator('[data-sand-hero]').getAttribute('data-sand-time');
  await racePage.locator('[data-curtain-play]').dispatchEvent('click');
  await racePage.locator('[data-curtain-play]').dispatchEvent('click');
  await racePage.waitForFunction(() => window.__curtainWorkerJobs === 1);
  results.doublePlayDuringStartup = await racePage.locator('[data-sand-hero]').evaluate(el => ({ ...el.dataset }));
  assert.equal(results.doublePlayDuringStartup.curtainState, 'loading');
  assert.equal(Number(results.doublePlayDuringStartup.curtainPreparations), 1, 'Repeated activation while loading must reuse one preparation');
  assert.equal(await racePage.locator('[data-curtain-play]').getAttribute('aria-busy'), 'true');
  assert.equal(await racePage.locator('[data-curtain-play]').isDisabled(), true);
  assert.ok(Number(results.doublePlayDuringStartup.sandTime) >= Number(raceFrameBefore), 'The frame clock must continue during waterfall preparation');
  for (const width of [768, 390, 1024, 390]) await racePage.setViewportSize({ width, height: 844 });
  await racePage.waitForSelector('[data-sand-ready="true"][data-curtain-ready="true"]');
  await racePage.waitForTimeout(450);
  results.resizeDuringStartup = await racePage.evaluate(() => {
    const hero = document.querySelector('[data-sand-hero]'), canvas = document.querySelector('[data-sand-canvas]');
    return { ...hero.dataset, width: hero.clientWidth, height: hero.clientHeight,
      canvasWidth: canvas.width, canvasHeight: canvas.height, workerJobs: window.__seedWorkerJobs,
      curtainWorkerJobs: window.__curtainWorkerJobs };
  });
  assert.equal(results.resizeDuringStartup.width, 390);
  assert.equal(results.resizeDuringStartup.height, 844);
  assertParticleBudget(results.resizeDuringStartup, 390);
  assert.equal(results.resizeDuringStartup.sandSeedPreparation, 'worker');
  assert.equal(results.resizeDuringStartup.canvasWidth, 390, 'A stale desktop worker result must never replace the final mobile layout');
  assert.equal(results.resizeDuringStartup.canvasHeight, 844);
  assert.ok(results.resizeDuringStartup.workerJobs >= 2, 'Resize while initialization is pending must prepare a new generation');
  assert.ok(results.resizeDuringStartup.curtainWorkerJobs >= 2, 'Resize during Play must discard the stale waterfall layout and prepare the current viewport');
  results.resizeDuringStartup.curtainCoverage = await racePage.evaluate(curtainViewportCoverage);
  assert.equal(results.resizeDuringStartup.curtainCoverage.offscreenSources, 0);
  assert.equal(results.resizeDuringStartup.curtainCoverage.offscreenFlows, 0);
  assert.deepEqual(raceErrors, []);
  // Play remains usable while a slower device is still preparing its frame.
  await racePage.reload({ waitUntil: 'domcontentloaded' });
  await racePage.waitForFunction(() => window.__seedWorkerJobs > 0);
  assert.notEqual(await racePage.locator('[data-sand-hero]').getAttribute('data-sand-ready'), 'true');
  await racePage.locator('[data-curtain-play]').dispatchEvent('click');
  await racePage.waitForSelector('[data-sand-ready="true"][data-curtain-ready="true"]');
  results.earlyPlay = await racePage.locator('[data-sand-hero]').evaluate(el => ({ ...el.dataset }));
  assert.equal(Number(results.earlyPlay.curtainPreparations), 1, 'An early Play click must preserve user intent and start the curtain once the frame is ready');
  assert.equal(await racePage.evaluate(() => window.__curtainWorkerJobs), 1);
  assert.deepEqual(raceErrors, []);
  await racePage.close();

  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.reload();
  await page.waitForFunction(() => document.querySelector('[data-sand-status]').textContent.includes('movimiento reducido'));
  assert.equal(await page.locator('[data-sand-toggle]').isDisabled(), true);
  assert.equal(await page.locator('[data-curtain-play]').isDisabled(), true);
  assert.equal(await page.locator('[data-sand-frame]').isVisible(), false);
  assert.equal(await page.locator('[data-logo-image]').isVisible(), true);
  assert.equal(await page.locator('[data-curtain-image]').isVisible(), true);
  assert.equal(await page.locator('[data-curtain-image]').evaluate(image => Number(getComputedStyle(image).opacity)), 1);
  assert.equal(await page.locator('[data-curtain-image]').getAttribute('src'), '/assets/images/cortina-def.webp');
  results.reducedMotion = true;
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await page.reload();
  await page.waitForSelector('[data-sand-ready="true"]');
  await assertIdleCurtain(page);
  await playCurtain(page);
  await page.locator('[data-sand-canvas]').evaluate(canvas => canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
  await page.waitForSelector('[data-sand-ready="false"]');
  assert.equal(await page.locator('[data-sand-frame]').isVisible(), false);
  results.contextLossFallback = true;
  assert.equal(await page.locator('[data-logo-image]').isVisible(), true);
  assert.equal(await page.locator('[data-curtain-image]').isVisible(), true);
  assert.equal(await page.locator('[data-curtain-image]').evaluate(image => Number(getComputedStyle(image).opacity)), 1);
  await page.addInitScript(() => {
    const original = WebGL2RenderingContext.prototype.getExtension;
    WebGL2RenderingContext.prototype.getExtension = function(name) {
      return name === 'EXT_color_buffer_float' ? null : original.call(this, name);
    };
  });
  await page.reload();
  await page.waitForSelector('[data-sand-ready="false"]');
  assert.equal(await page.locator('[data-sand-toggle]').isDisabled(), true);
  assert.equal(await page.locator('[data-curtain-play]').isDisabled(), true);
  results.unsupportedGpuFallback = true;
  assert.equal(await page.locator('[data-logo-image]').isVisible(), true);
  assert.equal(await page.locator('[data-curtain-image]').isVisible(), true);
  assert.equal(await page.locator('[data-curtain-image]').evaluate(image => Number(getComputedStyle(image).opacity)), 1);
  assert.deepEqual(errors, []); assert.deepEqual(failedRequests, []);
  results.consoleErrors = errors; results.failedRequests = failedRequests;
  await writeFile('artifacts/gpu-verification.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  console.log(JSON.stringify({ errors, failedRequests, shaderPhysics: results.shaderPhysics,
    curtainArtwork: results.curtainArtwork, curtainSourceMask: results.curtainSourceMask,
    curtainFlow: results.curtainFlow, curtainPhysics: results.curtainPhysics,
    curtainAnimation: results.curtainAnimation, metrics: await metrics(), status: await page.locator('[data-sand-status]').textContent() }, null, 2));
  await page.screenshot({ path: 'artifacts/browser-failure.png' }); throw error;
} finally { await browser.close(); }
