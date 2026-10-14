// Build-only tracing tool; it is never imported by the landing.
// npm install --prefix artifacts/logo-tracing --no-save --package-lock=false --ignore-scripts potrace
// Prepare artifacts/logo-trace-mask.png from logo-hero.webp: alpha >= 128 is black.
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { trace } = require('../artifacts/logo-tracing/node_modules/potrace');
const input = fileURLToPath(new URL('../artifacts/logo-trace-mask.png', import.meta.url));
const output = new URL('../public/assets/images/logo-hero-vector.svg', import.meta.url);
const svg = await new Promise((resolve, reject) => trace(input, {
  threshold: 128, blackOnWhite: true, color: '#fff',
  turdSize: 2, alphaMax: 1, optCurve: true, optTolerance: .2,
}, (error, result) => error ? reject(error) : resolve(result)));
if (/<image\b/i.test(svg) || !/<path\b/i.test(svg)) throw new Error('Expected pure vector paths');
await writeFile(output, svg + '\n');
console.log('Created logo-hero-vector.svg:', Buffer.byteLength(svg), 'bytes, vector paths only');
