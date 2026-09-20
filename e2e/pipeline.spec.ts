/**
 * End to end, with the unpacked extension in a real headed Chrome.
 *
 * What is exercised: the ASR worker (Silero + Whisper on real weights), the
 * translation layer, the audio-to-video clock mapping, the message path to the
 * tab, and the overlay rendering in its shadow root.
 *
 * What is not: `chrome.tabCapture`. Getting a stream id needs an `activeTab`
 * grant, and an `activeTab` grant needs a genuine click on the extension's
 * action, which no automation harness can produce. The speech is injected into
 * the offscreen document instead — everything downstream is identical code.
 * See BUGS.md and SPIKES.md section E.
 */

import { expect, test } from '@playwright/test';
import type { Caption } from '@subtle/shared';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FIXTURES, launch, peakRss, readWav, startRssSampler, wer, type Harness } from './harness.js';

const CLIP = process.env['SUBTLE_CLIP'] ?? resolve(FIXTURES, 'spanish');
const REFERENCE = readFileSync(`${CLIP}.txt`, 'utf8').trim();
/** Whisper tiny on clean speech; loose enough not to be flaky, tight enough to mean something. */
const MAX_WER = 0.45;
/** The task's requirement: a caption must sit within this of the audio it describes. */
const MAX_DRIFT_SEC = 3;
/**
 * Median time from the start of a spoken chunk to its first translated line on
 * screen. The goal is under a second; the bound is set where the measurements
 * actually land (RESULTS.md) rather than where the goal is, so a regression
 * fails here instead of being absorbed.
 */
const MAX_FIRST_TRANSLATION_MS = Number(process.env['SUBTLE_MAX_FIRST_TRANSLATION_MS'] ?? 1000);
/** Which Whisper size to exercise. RESULTS.md sweeps all three. */
const MODEL = (process.env['SUBTLE_MODEL'] ?? 'tiny') as 'tiny' | 'base' | 'small';
/** Repeats of the clip, so the percentiles have something to stand on. */
const REPEATS = Number(process.env['SUBTLE_REPEATS'] ?? 3);
/**
 * Spoken language. 'auto' is the default the popup ships with; naming the
 * language instead lets the translation model load while the video starts
 * rather than after the first word is recognised, which is the whole of the
 * cold-start difference (RESULTS.md).
 */
const SRC = process.env['SUBTLE_SRC'] ?? 'auto';

let harness: Harness;

test.beforeAll(async () => {
  harness = await launch();
  startRssSampler();
});

test.afterAll(async () => {
  await harness?.close();
});

/**
 * The offscreen document is not a Playwright target and the content script
 * runs in an isolated world, so neither can be evaluated in directly. What is
 * observable is the overlay's open shadow root in the page, and whatever the
 * offscreen document forwards to the service worker. Both are used.
 */
interface Line {
  id: string;
  /** video.currentTime when this text first appeared on screen. */
  t: number;
  original: string;
  translation: string;
  interim: boolean;
}

test('speech reaches the overlay as a timed, translated caption', async () => {
  const page = await harness.context.newPage();
  const lines: Line[] = [];

  // http, not file://: content scripts do not run on file URLs in a fresh
  // unpacked profile.
  await page.goto('http://localhost:5311/page.html');
  await page.waitForFunction(() => (window as unknown as { __videoReady?: boolean }).__videoReady === true, {
    timeout: 60_000,
  });
  await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).play());

  // Record every distinct line the overlay paints, with the video position it
  // appeared at — that pairing is what the drift assertion needs.
  await page.evaluate(() => {
    const w = window as unknown as { __lines: unknown[] };
    w.__lines = [];
    const video = document.querySelector('video') as HTMLVideoElement;
    let last = '';
    // Sampled per frame, not on a 100 ms timer: a coarser poll adds up to
    // 100 ms of its own to every latency number it reports.
    const sample = (): void => {
      requestAnimationFrame(sample);
      const shadow = document.querySelector('[data-subtle="overlay"]')?.shadowRoot;
      const original = shadow?.querySelector('.original');
      if (!original || shadow?.querySelector<HTMLElement>('.root')?.hidden) return;
      const text = original.textContent ?? '';
      const translation = shadow!.querySelector('.translation')?.textContent ?? '';
      // Key on both: the caption is re-emitted with the same original once the
      // translation lands, and that second state is the one under test.
      const key = `${text}\u0000${translation}\u0000${original.classList.contains('interim')}`;
      if (!text || key === last) return;
      last = key;
      w.__lines.push({
        id: shadow!.querySelector<HTMLElement>('.root')!.dataset['captionId'],
        t: video.currentTime,
        original: text,
        translation,
        interim: original.classList.contains('interim'),
      });
    };
    requestAnimationFrame(sample);
  });

  // Anything the offscreen document forwards upstream: metrics, errors, the
  // backend it settled on.
  await harness.serviceWorker.evaluate(() => {
    const g = globalThis as unknown as { __msgs: unknown[] };
    g.__msgs = [];
    chrome.runtime.onMessage.addListener((m) => {
      g.__msgs.push(m);
    });
  });

  // Focus first: the profile also opens an about:blank tab, and captions sent
  // to the wrong tab vanish silently. Filtering by url needs the "tabs"
  // permission, which the manifest deliberately does not take.
  await page.bringToFront();
  const tabId = await harness.serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab!.id!;
  });
  console.log('target tab', tabId);

  // Turn the debug panel on; the test reads the pipeline's own view of itself.
  // The whole ui object has to be written: the content script replaces it
  // wholesale on a storage change rather than merging (BUGS.md E-4).
  await harness.serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({ ui: { captionsOn: true, immersion: false, debug: true } });
  });

  const wav = readWav(`${CLIP}.wav`);
  expect(wav.sampleRate).toBe(16000);
  // Trailing silence, because the VAD closes an utterance on 400 ms of quiet
  // and this clip is one continuous run of speech. Real capture always has it;
  // a bare fixture does not, and the segment stays open until stop() flushes.
  const speechSeconds = wav.samples.length / wav.sampleRate;
  wav.samples.push(...new Array<number>(wav.sampleRate * 2).fill(0));
  const rms = Math.sqrt(wav.samples.reduce((a, b) => a + b * b, 0) / wav.samples.length);
  console.log(`clip: ${speechSeconds.toFixed(2)}s speech + 2s silence · rms ${rms.toFixed(4)}`);
  expect(rms, 'fixture is not silent').toBeGreaterThan(0.01);

  // The offscreen document is normally created by the capture path, which is
  // the one thing this test cannot take; create it directly.
  await harness.serviceWorker.evaluate(async () => {
    const existing = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    if (existing.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification: 'e2e: inject audio in place of tabCapture',
      });
    }
  });
  await harness.serviceWorker.evaluate(() => new Promise((r) => setTimeout(r, 1500)));

  // Start an injected session and feed the clip in 100 ms chunks, paced as
  // capture would deliver them.
  await harness.serviceWorker.evaluate(
    async ([id, config]) => {
      await chrome.runtime.sendMessage({ type: 'debugStart', tabId: id, config });
    },
    [tabId, { srcLang: SRC, tgtLang: 'en', whisperModel: MODEL, showTranslation: true, fontSize: 28, dubbing: false }] as const,
  );

  // Audio pushed before the recognizer has loaded is dropped on the floor, so
  // wait for the `backend` message the worker posts when it is ready rather
  // than guessing at a delay. First run downloads ~45 MB.
  await expect
    .poll(
      async () =>
        harness.serviceWorker.evaluate(
          () =>
            ((globalThis as unknown as { __msgs: { type: string }[] }).__msgs ?? []).filter(
              (m) => m.type === 'backend',
            ).length,
        ),
      { timeout: 300_000, intervals: [2000] },
    )
    .toBeGreaterThan(0);
  const readyAt = Date.now();
  console.log('recognizer ready');

  // The clip is injected part-way through the video, so drift has to be
  // measured from here rather than from the video's zero.
  const injectStart = await page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentTime);

  await harness.serviceWorker.evaluate(
    async ([samples, rate, repeats]) => {
      const size = (rate as number) / 10;
      const all = samples as number[];
      let sent = 0;
      let energy = 0;
      let cursor = 0;
      const started = performance.now();
      for (let pass = 0; pass < (repeats as number); pass++) {
        for (let i = 0; i < all.length; i += size) {
          const slice = all.slice(i, i + size);
          energy += slice.reduce((a, b) => a + b * b, 0);
          // Like an AudioWorklet, deliver a chunk after its samples exist.
          // Absolute deadlines prevent sendMessage/timer overhead from adding
          // fictitious caption lag on every subsequent chunk.
          const due = started + (cursor + slice.length) / (rate as number) * 1000;
          await new Promise((r) => setTimeout(r, Math.max(0, due - performance.now())));
          await chrome.runtime.sendMessage({
            type: 'audioChunk',
            samples: slice,
            audioStart: cursor / (rate as number),
          });
          cursor += slice.length;
          sent++;
        }
      }
      (globalThis as unknown as { __sent: unknown }).__sent = {
        chunks: sent,
        rms: Math.sqrt(energy / (all.length * (repeats as number))),
      };
    },
    [wav.samples, wav.sampleRate, REPEATS] as const,
  );

  // If nothing paints, the reason is in what the offscreen document forwarded.
  const dump = async (label: string): Promise<void> => {
    const msgs = (await harness.serviceWorker.evaluate(
      () => (globalThis as unknown as { __msgs: unknown[] }).__msgs,
    )) as { type: string; stage?: string; message?: string; model?: string; loaded?: number; total?: number }[];
    const overlay = await page.evaluate(() => !!document.querySelector('[data-subtle="overlay"]'));
    console.log(
      `[${label}] overlay mounted: ${overlay} · messages: ` +
        JSON.stringify(
          msgs.reduce<Record<string, number>>(
            (acc, m) => ({ ...acc, [m.type === 'metrics' ? `metrics:${m.stage}` : m.type]: (acc[m.type === 'metrics' ? `metrics:${m.stage}` : m.type] ?? 0) + 1 }),
            {},
          ),
        ) +
        ' · errors: ' +
        JSON.stringify(msgs.filter((m) => m.type === 'error').slice(0, 4)),
    );
  };
  console.log(
    `sent from sw (${((Date.now() - readyAt) / 1000).toFixed(1)}s after ready):`,
    JSON.stringify(await harness.serviceWorker.evaluate(() => (globalThis as unknown as { __sent: unknown }).__sent)),
  );
  await dump('after audio');
  console.log(
    'model files:',
    JSON.stringify(
      await harness.serviceWorker.evaluate(() => {
        const msgs = ((globalThis as unknown as { __msgs: { type: string; model?: string; loaded?: number; total?: number }[] }).__msgs ?? [])
          .filter((m) => m.type === 'modelProgress');
        const by: Record<string, string> = {};
        for (const m of msgs) by[String(m.model)] = `${Math.round(((m.loaded ?? 0) / (m.total || 1)) * 100)}%`;
        return by;
      }),
    ),
  );
  const vadMs = (await harness.serviceWorker.evaluate(
    () => ((globalThis as unknown as { __msgs: { type: string; stage?: string; ms?: number }[] }).__msgs ?? [])
      .filter((m) => m.type === 'metrics' && m.stage === 'vad')
      .map((m) => Number((m.ms ?? 0).toFixed(2))),
  )) as number[];
  console.log('vad ms:', JSON.stringify(vadMs.slice(0, 12)), 'max', Math.max(...vadMs, 0));
  console.log(
    'debug panel:',
    JSON.stringify(
      await page.evaluate(
        () =>
          document.querySelector('[data-subtle="overlay"]')?.shadowRoot?.querySelector('.subtle-debug')
            ?.textContent ?? 'not rendered',
      ),
    ),
  );

  // Give Whisper time to finish the tail.
  await expect
    .poll(async () => page.evaluate(() => (window as unknown as { __lines: unknown[] }).__lines.length), {
      timeout: 120_000,
      intervals: [2000],
    })
    .toBeGreaterThan(0);

  // The translation lands after the original: the MT model may have to
  // download the first time a pair is used.
  await expect
    .poll(
      async () =>
        page.evaluate(
          () =>
            ((window as unknown as { __lines: { translation: string }[] }).__lines ?? []).filter(
              (l) => l.translation.trim().length > 0,
            ).length,
        ),
      { timeout: 420_000, intervals: [3000] },
    )
    .toBeGreaterThan(0);

  await page.waitForTimeout(3000);
  await dump('after translation');
  console.log(
    'debug panel:',
    JSON.stringify(
      await page.evaluate(
        () =>
          document.querySelector('[data-subtle="overlay"]')?.shadowRoot?.querySelector('.subtle-debug')
            ?.textContent ?? 'not rendered',
      ),
    ),
  );
  lines.push(...((await page.evaluate(() => (window as unknown as { __lines: unknown[] }).__lines)) as Line[]));

  const finals = lines.filter((l) => !l.interim);
  expect(finals.length, 'at least one final caption painted').toBeGreaterThan(0);

  // Recognition now finalises short chunks. Reassemble each injected pass
  // for WER; comparing each fragment to the full reference would count all
  // the words in the other fragments as recognition errors.
  const delivered = await harness.serviceWorker.evaluate(() => {
    const messages = (globalThis as unknown as { __msgs: { payload?: Caption }[] }).__msgs;
    return messages.map((m) => m.payload).filter((c): c is Caption => !!c && typeof c.original === 'string');
  });
  const unique = [...new Map(delivered.filter((c) => !c.interim).map((c) => [c.id, c])).values()].sort((a, b) => a.videoStart - b.videoStart);
  // Latency, measured the way a viewer experiences it: from the start of the
  // speech a caption claims to describe, to the frame that first shows it
  // translated. `videoStart` is the chunk's own start, which includes the
  // segmenter's 150 ms of pre-roll padding, so these numbers are if anything
  // pessimistic. A chunk that never got a translated line at all counts as a
  // miss rather than being dropped from the distribution.
  const latency = (pool: Caption[], want: (l: Line) => boolean): (number | null)[] =>
    pool.map((c) => {
      const first = lines.find((line) => line.id === c.id && want(line));
      return first ? Math.round((first.t - c.videoStart) * 1000) : null;
    });
  const firstChunks = unique.filter((c) => c.id.endsWith('-0'));
  const firstOriginalMs = latency(firstChunks, () => true);
  const firstTranslationMs = latency(firstChunks, (l) => l.translation.trim().length > 0);
  // Every chunk, not just the one that opens an utterance: more samples, and
  // it catches a mid-sentence chunk that stalls while the first one is quick.
  const everyChunkMs = latency(unique, (l) => l.translation.trim().length > 0);
  // The same chunks, timed from the first audio in them that was not already
  // on screen. A split chunk repeats half a second of the previous one for
  // de-duplication, and charging that repeat as latency would overstate the
  // wait for words the viewer has not seen yet.
  const newSpeechMs = unique.map((c, i) => {
    const from = Math.max(c.videoStart, unique[i - 1]?.videoEnd ?? c.videoStart);
    const first = lines.find((line) => line.id === c.id && line.translation.trim());
    return first ? Math.round((first.t - from) * 1000) : null;
  });

  const stats = (all: (number | null)[]): Record<string, number | null> => {
    const ok = all.filter((ms): ms is number => ms !== null).sort((a, b) => a - b);
    const at = (q: number): number | null =>
      ok.length === 0 ? null : ok[Math.min(ok.length - 1, Math.max(0, Math.ceil(q * ok.length) - 1))]!;
    return { n: all.length, misses: all.length - ok.length, median: at(0.5), p95: at(0.95), max: at(1) };
  };

  console.log('PREVIEWS ' + JSON.stringify(lines.filter((l) => l.interim && l.translation)));
  console.log(
    'CAPTION_LATENCY ' +
      JSON.stringify({
        firstOriginalMs,
        firstTranslationMs,
        everyChunkMs,
        newSpeechMs,
        utterance: stats(firstTranslationMs),
        chunk: stats(everyChunkMs),
        newSpeech: stats(newSpeechMs),
        // The first utterance of the session pays for whatever the models
        // still have to load; it is reported rather than averaged away.
        coldStartMs: firstTranslationMs[0],
      }),
  );
  expect(lines.some((line) => line.interim && line.translation.trim()), 'an early translated preview was painted').toBe(true);
  const firstTranslated = firstTranslationMs.filter((ms): ms is number => ms !== null).sort((a, b) => a - b);
  expect(firstTranslated.length).toBeGreaterThan(0);
  expect(
    firstTranslationMs.filter((ms) => ms === null).length,
    'every utterance got a translated caption',
  ).toBe(0);
  expect(firstTranslated[firstTranslated.length >> 1], 'median first translation from speech start').toBeLessThan(
    MAX_FIRST_TRANSLATION_MS,
  );
  const passLength = speechSeconds + 2;
  const texts = Array.from({ length: REPEATS }, (_, pass) => unique.filter((c) =>
    Math.max(0, Math.floor((c.videoStart - injectStart + 0.3) / passLength)) === pass,
  ).map((c) => c.original).join(' ')).filter(Boolean);
  const rates = texts.map((t) => wer(REFERENCE, t)).sort((a, b) => a - b);
  const transcript = texts.join(' | ');
  const rate = rates[rates.length >> 1] ?? 1;
  console.log(`transcript: ${JSON.stringify(transcript)}\nreference:  ${JSON.stringify(REFERENCE)}\nWER: ${(rate * 100).toFixed(1)}%`);
  expect(rate, `WER ${(rate * 100).toFixed(1)}% over ${MAX_WER * 100}%`).toBeLessThan(MAX_WER);

  expect(
    finals.some((l) => l.translation.trim().length > 0),
    'a translation was painted',
  ).toBe(true);

  // Compare each painted chunk to its own endpoint, not the end of the
  // entire utterance (which would conceal latency for early chunks).
  const lags = finals.map((line) => {
    const matches = unique.filter((c) => c.original === line.original && c.videoStart <= line.t);
    const caption = matches.sort((a, b) => Math.abs(a.videoEnd - line.t) - Math.abs(b.videoEnd - line.t))[0];
    expect(caption, 'painted caption has a delivered timestamp').toBeDefined();
    return line.t - caption!.videoEnd;
  });
  const speechEnd = injectStart + speechSeconds;
  console.log(
    `injected at video ${injectStart.toFixed(2)}s · speech ends ${speechEnd.toFixed(2)}s · ` +
      `captions at ${finals.map((l) => l.t.toFixed(2)).join(', ')}s · ` +
      `lag ${lags.map((l) => l.toFixed(2)).join(', ')}s`,
  );
  for (const [i, line] of finals.entries()) {
    expect(lags[i]!, `"${line.original.slice(0, 32)}" lagged its audio by ${lags[i]!.toFixed(2)}s`).toBeLessThan(
      MAX_DRIFT_SEC,
    );
    expect(line.t, 'caption appeared before its audio was fed').toBeGreaterThan(injectStart);
  }

  const messages = (await harness.serviceWorker.evaluate(
    () => (globalThis as unknown as { __msgs: unknown[] }).__msgs,
  )) as { type: string; stage?: string; ms?: number; rtf?: number; backend?: string; message?: string }[];
  const errors = messages.filter((m) => m.type === 'error');
  console.log('errors:', JSON.stringify(errors));
  console.log(
    'metrics:',
    JSON.stringify(
      Object.fromEntries(
        ['vad', 'asr', 'translate', 'render'].map((stage) => [
          stage,
          messages.filter((m) => m.type === 'metrics' && m.stage === stage).map((m) => Math.round(m.ms ?? 0)),
        ]),
      ),
    ),
  );
  expect(errors, 'no errors from any stage').toHaveLength(0);

  // One machine-readable line per run; collect.mjs turns these into RESULTS.md.
  const pick = (stage: string): number[] =>
    messages.filter((m) => m.type === 'metrics' && m.stage === stage).map((m) => m.ms ?? 0);
  const panel = await page.evaluate(
    () =>
      document.querySelector('[data-subtle="overlay"]')?.shadowRoot?.querySelector('.subtle-debug')
        ?.textContent ?? '',
  );
  console.log(
    'SUBTLE_RESULT ' +
      JSON.stringify({
        model: MODEL,
        srcLang: SRC,
        wer: rate,
        firstTranslationMs,
        everyChunkMs,
        newSpeechMs,
        captions: finals.length,
        lagSec: lags.map((l) => Number(l.toFixed(2))),
        asrMs: pick('asr').map(Math.round),
        translateMs: pick('translate').map(Math.round),
        renderMs: pick('render').map(Math.round),
        vadP95Ms: Math.round(pick('vad').sort((a, b) => a - b)[Math.ceil(0.95 * pick('vad').length) - 1] ?? 0),
        rtf: /rtf([0-9.]+)/.exec(panel)?.[1] ?? null,
        gpu: /gpu([a-z0-9 -]+?)translator/.exec(panel)?.[1] ?? null,
        backend: /asr backend(webgpu|wasm)/.exec(panel)?.[1] ?? null,
        network: /requests(\d+)/.exec(panel)?.[1] ?? null,
        peakRssMb: peakRss(),
      }),
  );

  // Stop tears everything down.
  await harness.serviceWorker.evaluate(async (id) => {
    await chrome.runtime.sendMessage({ type: 'stop', tabId: id });
  }, tabId);
  await page.waitForTimeout(1500);

  const before = await page.evaluate(() => (window as unknown as { __lines: unknown[] }).__lines.length);
  await page.waitForTimeout(4000);
  const after = await page.evaluate(() => (window as unknown as { __lines: unknown[] }).__lines.length);
  // One more sample is allowed: the overlay clears its last line on stop.
  expect(after - before, 'no new captions after stop').toBeLessThanOrEqual(1);

  await page.close();
});
