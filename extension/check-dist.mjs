/**
 * Cheap stand-in for "load it in chrome://extensions and see no errors":
 * every path the manifest names must exist in dist, the service worker must
 * be a module, and the two classic scripts must contain no import statements.
 *
 * Run after a build: `node check-dist.mjs`
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dist = resolve(import.meta.dirname, 'dist');
const manifest = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8'));
const problems = [];

const referenced = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...manifest.content_scripts.flatMap((c) => [...(c.js ?? []), ...(c.css ?? [])]),
  // Not in the manifest, but the offscreen document and its workers are
  // loaded by path at runtime and fail just as loudly if they move.
  'offscreen.html',
  'workers/asr.js',
  'workers/mt.js',
  'workers/tts.js',
  'licenses/supertonic-model.txt',
  'worklets/resampler.js',
  'wasm/ort-wasm-simd-threaded.wasm',
  'wasm/ort-wasm-simd-threaded.jsep.wasm',
];

for (const path of referenced) {
  if (!existsSync(resolve(dist, path))) problems.push(`missing: ${path}`);
}

if (manifest.background.type !== 'module') problems.push('background must be type: module');

// Content scripts and audio worklets are classic scripts: an import statement
// in either is a silent runtime failure, not a build error.
for (const path of ['content.js', 'worklets/resampler.js']) {
  const src = readFileSync(resolve(dist, path), 'utf8');
  if (/^\s*(import|export)\s/m.test(src)) problems.push(`${path} is not a classic script`);
}

const csp = manifest.content_security_policy?.extension_pages ?? '';
if (!csp.includes("'wasm-unsafe-eval'")) problems.push('CSP must allow wasm-unsafe-eval');

if (problems.length) {
  console.error('dist check failed:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`dist check ok — ${referenced.length} referenced files present`);
