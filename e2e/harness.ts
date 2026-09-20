/**
 * Loading the unpacked extension and driving it.
 *
 * Extensions only work in a persistent context, and only headed — Playwright's
 * headless shell does not load them. `PWTEST_HEADED=0` is not an option here.
 */

import { execSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Worker } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
export const DIST = resolve(here, '../extension/dist');
export const FIXTURES = resolve(here, 'fixtures');

export interface Harness {
  context: BrowserContext;
  extensionId: string;
  serviceWorker: Worker;
  close(): Promise<void>;
}

/**
 * The profile is kept between runs on purpose. Model weights live in its Cache
 * API storage, and a fresh profile means re-downloading ~160 MB before the
 * first caption — slow, and it makes the "network requests should be 0 once
 * weights are cached" check impossible to observe. `SUBTLE_CLEAN_PROFILE=1`
 * forces a cold run.
 */
export async function launch(profileName = 'profile'): Promise<Harness> {
  const profile = resolve(here, profileName);
  if (process.env['SUBTLE_CLEAN_PROFILE'] === '1') {
    rmSync(profile, { recursive: true, force: true });
  }

  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: false,
    args: [
      `--disable-extensions-except=${DIST}`,
      `--load-extension=${DIST}`,
      // Deliberately NOT --autoplay-policy=no-user-gesture-required. That flag
      // let a suspended AudioContext start on its own and hid a bug that made
      // the real extension both silent and caption-less: an offscreen document
      // has no user activation, so its AudioContext never ran. Tests run under
      // the same rules as a real browser.
      '--mute-audio',
    ],
  });

  // The service worker is the handle on everything else; it may take a moment.
  let [serviceWorker] = context.serviceWorkers();
  serviceWorker ??= await context.waitForEvent('serviceworker', { timeout: 30_000 });
  const extensionId = new URL(serviceWorker.url()).host;

  return {
    context,
    extensionId,
    serviceWorker,
    async close() {
      await context.close();
    },
  };
}

export interface Wav {
  sampleRate: number;
  samples: number[];
}

/** 16-bit PCM only; these are our own fixtures. */
export function readWav(path: string): Wav {
  const buf = readFileSync(path);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (at: number): string =>
    String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let data: { at: number; length: number } | null = null;
  for (let at = 12; at + 8 <= view.byteLength; ) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      data = { at: body, length: size };
    }
    at = body + size + (size % 2);
  }
  if (!data || bits !== 16) throw new Error(`${path}: expected 16-bit PCM`);

  const frames = Math.floor(data.length / 2 / channels);
  const samples: number[] = new Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += view.getInt16(data.at + (f * channels + c) * 2, true) / 32768;
    samples[f] = sum / channels;
  }
  return { sampleRate, samples };
}

// ------------------------------------------------------------------- memory

/**
 * Peak resident memory across every Chrome process belonging to this profile.
 * Renderer, GPU and utility processes are separate, and the models live in a
 * worker in one of them, so a single process number would be meaningless.
 */
let peak = 0;
let sampler: ReturnType<typeof setInterval> | null = null;

export function startRssSampler(profileName = 'profile'): void {
  if (sampler) return;
  const marker = resolve(here, profileName);
  sampler = setInterval(() => {
    try {
      const out = execSync('ps -A -o rss=,command=', { encoding: 'utf8' });
      let total = 0;
      for (const line of out.split('\n')) {
        if (!line.includes(marker)) continue;
        total += Number.parseInt(line.trim().split(/\s+/)[0] ?? '0', 10);
      }
      peak = Math.max(peak, total / 1024);
    } catch {
      // ps is not essential; the number is simply not reported.
    }
  }, 2000);
  sampler.unref?.();
}

export function peakRss(): number {
  return Math.round(peak);
}

// ------------------------------------------------------------------ scoring

export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Word error rate: Levenshtein over normalized words, divided by reference length. */
export function wer(reference: string, hypothesis: string): number {
  const a = normalize(reference).split(' ').filter(Boolean);
  const b = normalize(hypothesis).split(' ').filter(Boolean);
  if (a.length === 0) return b.length === 0 ? 0 : 1;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length]! / a.length;
}
