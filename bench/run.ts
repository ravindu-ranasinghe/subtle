/**
 * Whisper benchmark: every model size over a folder of clips, out as a
 * markdown table.
 *
 * Drives extension/src/workers/asr/whisper.ts directly rather than a copy, so
 * what is measured is what ships — the only difference is `device`, since
 * Node has no WebGPU. The WebGPU numbers in SPIKES.md section B have to come
 * from a browser.
 *
 *   node run.ts --clips ./clips --models tiny,base --device cpu
 *
 * Clip layout: <clips>/<lang>/<name>.wav plus <name>.txt holding the
 * reference transcript.
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { env } from '@huggingface/transformers';
// Explicit .ts specifiers: Node's type stripping does not rewrite .js to .ts.
// Safe here because every module below has only type-only relative imports,
// which are erased before Node ever resolves them.
import { decodeWav } from '../shared/mocks/audio.ts';
import { WhisperEngine, MODEL_IDS, gpuAdapterName, type Backend } from '../extension/src/workers/asr/whisper.ts';
import type { WhisperSize } from '../shared/interfaces.ts';

// Weights land here rather than in the user's home cache.
env.cacheDir = './.cache';

interface Clip {
  lang: string;
  name: string;
  samples: Float32Array;
  seconds: number;
  reference: string;
}

interface Result {
  model: WhisperSize;
  lang: string;
  errorRate: number;
  metric: 'WER' | 'CER';
  latencies: number[];
  rtfs: number[];
  clips: number;
}

/** Peak resident memory per model, MB. Section B of SPIKES.md wants this. */
const memory = new Map<WhisperSize, number>();

// ------------------------------------------------------------------ scoring

/** Lowercase, drop punctuation, collapse spacing. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Languages without spaces are scored per character; the rest per word. */
function isCharScored(lang: string): boolean {
  return lang === 'ja' || lang === 'zh' || lang === 'ko';
}

function units(text: string, lang: string): string[] {
  const norm = normalize(text);
  return isCharScored(lang) ? [...norm.replace(/\s/g, '')] : norm.split(' ').filter(Boolean);
}

/** Levenshtein distance, two rows rather than a full matrix. */
function editDistance(a: string[], b: string[]): number {
  if (a.length === 0) return b.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j]! + 1,
        row[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length]!;
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// -------------------------------------------------------------------- input

function loadClips(dir: string): Clip[] {
  if (!existsSync(dir)) throw new Error(`no clip folder at ${dir} — run \`node make-clips.mjs\` first`);
  const clips: Clip[] = [];
  for (const lang of readdirSync(dir, { withFileTypes: true })) {
    if (!lang.isDirectory()) continue;
    const langDir = join(dir, lang.name);
    for (const file of readdirSync(langDir)) {
      if (!file.endsWith('.wav')) continue;
      const name = basename(file, '.wav');
      const reference = join(langDir, `${name}.txt`);
      if (!existsSync(reference)) {
        console.warn(`skipping ${lang.name}/${name}: no reference transcript`);
        continue;
      }
      const buf = readFileSync(join(langDir, file));
      const wav = decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
      if (wav.sampleRate !== 16000) throw new Error(`${file}: expected 16 kHz, got ${wav.sampleRate}`);
      clips.push({
        lang: lang.name,
        name,
        samples: wav.samples,
        seconds: wav.samples.length / wav.sampleRate,
        reference: readFileSync(reference, 'utf8').trim(),
      });
    }
  }
  return clips.sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

// --------------------------------------------------------------------- main

async function main(): Promise<void> {
  const clipDir = arg('clips', './clips');
  const models = arg('models', 'tiny,base').split(',') as WhisperSize[];
  const device = arg('device', 'cpu') as Backend;
  const outFile = arg('out', './RESULTS.md');

  const clips = loadClips(clipDir);
  if (clips.length === 0) throw new Error(`no clips found under ${clipDir}`);
  const langs = [...new Set(clips.map((c) => c.lang))];
  console.log(`${clips.length} clips, ${langs.join('/')}, models ${models.join('/')}, device ${device}\n`);

  const results: Result[] = [];
  let backend: Backend = device;

  for (const model of models) {
    console.log(`loading ${MODEL_IDS[model]} ...`);
    const loadStart = Date.now();
    const engine = await WhisperEngine.create({ size: model, device });
    backend = engine.backend;
    console.log(`  ready in ${((Date.now() - loadStart) / 1000).toFixed(1)}s (${backend})`);
    let peak = process.memoryUsage().rss;

    const perLang = new Map<string, { errors: number; total: number; latencies: number[]; rtfs: number[]; clips: number }>();

    for (const clip of clips) {
      const started = performance.now();
      const { text } = await engine.transcribe(clip.samples, clip.lang, 0);
      const ms = performance.now() - started;

      const reference = units(clip.reference, clip.lang);
      const hypothesis = units(text, clip.lang);
      const errors = editDistance(reference, hypothesis);

      peak = Math.max(peak, process.memoryUsage().rss);
      const acc = perLang.get(clip.lang) ?? { errors: 0, total: 0, latencies: [], rtfs: [], clips: 0 };
      acc.errors += errors;
      acc.total += reference.length;
      acc.latencies.push(ms);
      acc.rtfs.push(ms / 1000 / clip.seconds);
      acc.clips++;
      perLang.set(clip.lang, acc);

      console.log(
        `  ${model}/${clip.name}  ${(ms / 1000).toFixed(2)}s  rtf ${(ms / 1000 / clip.seconds).toFixed(2)}  ` +
          `${errors}/${reference.length}  ${JSON.stringify(text.slice(0, 60))}`,
      );
    }

    for (const [lang, acc] of perLang) {
      results.push({
        model,
        lang,
        errorRate: acc.total === 0 ? NaN : acc.errors / acc.total,
        metric: isCharScored(lang) ? 'CER' : 'WER',
        latencies: acc.latencies,
        rtfs: acc.rtfs,
        clips: acc.clips,
      });
    }
    memory.set(model, peak / 1024 / 1024);
    await engine.dispose();
  }

  const gpu = device === 'webgpu' ? await gpuAdapterName() : null;
  writeFileSync(outFile, report(results, backend, gpu, clipDir));
  console.log(`\nwrote ${outFile}`);
  console.log(report(results, backend, gpu, clipDir));
}

function report(results: Result[], backend: Backend, gpu: string | null, clipDir: string): string {
  const rows = results.map((r) => {
    const pct = Number.isNaN(r.errorRate) ? '—' : `${(r.errorRate * 100).toFixed(1)}%`;
    return `| ${r.model} | ${r.lang} | ${r.metric} | ${pct} | ${median(r.latencies).toFixed(0)} ms | ${median(r.rtfs).toFixed(2)} | ${backend} | ${gpu ?? '—'} | ${r.clips} |`;
  });

  return [
    '# Whisper benchmark',
    '',
    `Clips: \`${clipDir}\` · generated ${new Date().toISOString().slice(0, 10)}`,
    '',
    '| model | lang | metric | error rate | median latency | RTF | backend | GPU adapter | clips |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    'RTF is processing seconds per audio second — under 1.0 is faster than real time.',
    '',
    'Peak process RSS while running: ' +
      [...memory].map(([m, mb]) => `${m} ${mb.toFixed(0)} MB`).join(' · ') +
      '. Process-wide, so it includes the runtime, not just the weights.',
    '',
    '> If these clips came from `make-clips.mjs` they are text-to-speech: clean,',
    '> evenly paced and free of background noise. Treat the error rates as a',
    '> best case and the RTF as representative. Point `--clips` at real',
    '> recordings before quoting any of it.',
    '',
  ].join('\n');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
