import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

const label = process.env.BENCHMARK_LABEL || 'current';
const playCurtain = process.env.BENCHMARK_PLAY === '1';
let baseURL = process.env.PREVIEW_URL || 'http://127.0.0.1:4321/';
let staticServer;
if (process.env.BENCHMARK_STATIC_DIR) {
  const root = resolve(process.env.BENCHMARK_STATIC_DIR);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
  staticServer = createServer(async (request, response) => {
    try {
      const path = resolve(root, '.' + new URL(request.url, 'http://localhost').pathname.replace(/\/$/, '/index.html'));
      if (!path.startsWith(root + sep)) throw new Error('Invalid asset path');
      const body = await readFile(path);
      const gzip = request.headers['accept-encoding']?.includes('gzip') && ['.html', '.js', '.css', '.svg'].includes(extname(path));
      const encoded = gzip ? gzipSync(body) : body;
      response.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream',
        'Content-Length': encoded.length, ...(gzip ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}) });
      response.end(encoded);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => staticServer.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${staticServer.address().port}/`;
}
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.BROWSER_EXECUTABLE,
  args: ['--enable-unsafe-swiftshader'] });
const results = { label, baseURL, renderer: 'headless Chromium / SwiftShader', samples: [] };
await mkdir('artifacts', { recursive: true });
try {
  for (const device of [
    { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false },
    { name: 'mobile', width: 390, height: 844, deviceScaleFactor: 3, isMobile: true },
  ]) {
    for (let run = 1; run <= 2; run++) {
      const context = await browser.newContext({ viewport: { width: device.width, height: device.height },
        deviceScaleFactor: device.deviceScaleFactor, isMobile: device.isMobile, hasTouch: device.isMobile });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        window.__particlePerf = { longTasks: [], lcp: null, readyAt: null, playAt: null, curtainReadyAt: null };
        const observe = (type, fn) => {
          try { new PerformanceObserver(list => list.getEntries().forEach(fn)).observe({ type, buffered: true }); } catch {}
        };
        observe('longtask', e => window.__particlePerf.longTasks.push({ start: e.startTime, duration: e.duration }));
        observe('largest-contentful-paint', e => { window.__particlePerf.lcp = { start: e.startTime, size: e.size, url: e.url }; });
        const check = () => {
          const hero = document.querySelector('[data-sand-hero]');
          if (hero?.dataset.sandReady === 'true' && window.__particlePerf.readyAt === null)
            window.__particlePerf.readyAt = performance.now();
          if (hero?.dataset.curtainReady === 'true' && window.__particlePerf.curtainReadyAt === null)
            window.__particlePerf.curtainReadyAt = performance.now();
        };
        new MutationObserver(check).observe(document, { subtree: true, attributes: true, childList: true });
      });
      const response = await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-sand-ready="true"]', { timeout: 30000 });
      if (playCurtain) {
        await page.evaluate(() => { window.__particlePerf.playAt = performance.now(); });
        await page.locator('[data-curtain-play]').click();
        await page.waitForSelector('[data-curtain-ready="true"]', { timeout: 30000 });
      }
      await page.waitForTimeout(500);
      const sample = await page.evaluate(() => {
        const state = window.__particlePerf, hero = document.querySelector('[data-sand-hero]');
        const resources = performance.getEntriesByType('resource');
        const js = resources.filter(r => /(?:\.m?js(?:\?|$)|\/@vite\/client|\/src\/)/.test(r.name));
        const images = resources.filter(r => r.initiatorType === 'img' || /\.(?:webp|svg)(?:\?|$)/.test(r.name));
        const paints = Object.fromEntries(performance.getEntriesByType('paint').map(r => [r.name, r.startTime]));
        const image = document.querySelector('[data-logo-image]'), rect = image.getBoundingClientRect();
        const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let minX = canvas.width, minY = canvas.height, maxX = 0, maxY = 0;
        for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
          if (pixels[(y * canvas.width + x) * 4 + 3] < 128) continue;
          minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        }
        return { readinessMs: state.readyAt,
          curtainPlayMs: state.playAt === null ? null : state.curtainReadyAt - state.playAt,
          paints, lcp: state.lcp, longTasks: state.longTasks,
          mainThreadLongTaskMs: state.longTasks.reduce((sum, task) => sum + task.duration, 0),
          counts: { frame: Number(hero.dataset.sandParticles), sparks: Number(hero.dataset.sandSparks), curtain: Number(hero.dataset.curtainParticles) },
          jsBytes: js.reduce((sum, r) => sum + r.transferSize, 0), jsDecodedBytes: js.reduce((sum, r) => sum + r.decodedBodySize, 0), jsRequests: js.length,
          imageBytes: images.reduce((sum, r) => sum + r.transferSize, 0),
          largestScripts: js.map(r => ({ path: new URL(r.name).pathname, transfer: r.transferSize, decoded: r.decodedBodySize })).sort((a,b) => b.decoded-a.decoded).slice(0,8),
          logo: { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            intrinsic: { minX, minY, maxX, maxY },
            ink: { x: rect.x + minX / canvas.width * rect.width, y: rect.y + minY / canvas.height * rect.height,
              width: (maxX - minX + 1) / canvas.width * rect.width, height: (maxY - minY + 1) / canvas.height * rect.height } },
          hero: { width: hero.clientWidth, height: hero.clientHeight }, metadata: { ...hero.dataset } };
      });
      results.samples.push({ device: device.name, run, http: response.status(), errors, ...sample });
      if (run === 1) await page.screenshot({ path: `artifacts/particles-${label}-${device.name}.png` });
      console.log(JSON.stringify({ label, device: device.name, run, readinessMs: sample.readinessMs,
        firstPaintMs: sample.paints['first-paint'], lcpMs: sample.lcp?.start, longTaskMs: sample.mainThreadLongTaskMs,
        jsBytes: sample.jsBytes, jsDecodedBytes: sample.jsDecodedBytes, counts: sample.counts, errors }));
      await context.close();
    }
  }
  await writeFile(`artifacts/particles-${label}-benchmark.json`, JSON.stringify(results, null, 2));
} finally {
  await browser.close();
  if (staticServer) await new Promise(resolve => staticServer.close(resolve));
}
