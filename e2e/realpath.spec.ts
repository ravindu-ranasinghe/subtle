/**
 * The production start path, end to end.
 *
 * `pipeline.spec.ts` feeds audio straight to the recognizer with `debugStart`,
 * which skips `startCapture` entirely — so it proved the back half of the
 * pipeline and nothing about capture. This drives the real `start()`: the
 * AudioContext, the worklet, the node graph, the chunk stream, the pump, and
 * the relay to the tab. Only `getMediaStreamId`/`getUserMedia` are replaced,
 * because an `activeTab` grant needs a real click on the extension's action.
 *
 * Both of the symptoms this was written for — silence and no captions — would
 * fail here.
 */

import { expect, test } from '@playwright/test';
import type { Caption } from '@subtle/shared';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FIXTURES, launch, readWav, wer, type Harness } from './harness.js';

const REFERENCE = readFileSync(resolve(FIXTURES, 'spanish.txt'), 'utf8').trim();

let harness: Harness;

test.beforeAll(async () => {
  harness = await launch();
});
test.afterAll(async () => {
  await harness?.close();
});

test('real start(): capture graph to painted caption', async () => {
  const page = await harness.context.newPage();
  await page.goto('http://localhost:5311/page.html');
  await page.bringToFront();
  await page.evaluate(() => document.querySelector('video')!.play());

  await harness.serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({ ui: { captionsOn: true, immersion: false, debug: true } });
    const g = globalThis as unknown as { __msgs: unknown[]; __snap?: unknown };
    g.__msgs = [];
    chrome.runtime.onMessage.addListener((m: { type?: string; payload?: { type?: string; snapshot?: unknown } }) => {
      g.__msgs.push(m);
      if (m?.type === 'relayToTab' && m.payload?.type === 'debugStats') g.__snap = m.payload.snapshot;
    });
    const existing = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    if (existing.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        // The same reasons the service worker uses, including AUDIO_PLAYBACK:
        // tabCapture mutes the tab, so this document is what the user hears.
        reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
        justification: 'real start path test',
      });
    }
  });

  // Record what the overlay paints.
  await page.evaluate(() => {
    const w = window as unknown as { __lines: unknown[] };
    w.__lines = [];
    let last = '';
    setInterval(() => {
      const shadow = document.querySelector('[data-subtle="overlay"]')?.shadowRoot;
      const original = shadow?.querySelector('.original');
      if (!original || shadow?.querySelector<HTMLElement>('.root')?.hidden) return;
      const text = original.textContent ?? '';
      const translation = shadow!.querySelector('.translation')?.textContent ?? '';
      const key = `${text}\u0000${translation}`;
      if (!text || key === last) return;
      last = key;
      w.__lines.push({ text, translation, interim: original.classList.contains('interim') });
    }, 100);
  });

  const tabId = await harness.serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab!.id!;
  });

  const wav = readWav(resolve(FIXTURES, 'spanish.wav'));
  // Trailing silence so the VAD closes the utterance; the buffer loops.
  const withGap = [...wav.samples, ...new Array<number>(wav.sampleRate * 2).fill(0)];

  const started = (await harness.serviceWorker.evaluate(
    async ([id, rate, samples]) =>
      chrome.runtime.sendMessage({
        type: 'debugStartCapture',
        tabId: id,
        sampleRate: rate,
        samples,
        config: {
          srcLang: 'es',
          tgtLang: 'en',
          whisperModel: 'tiny',
          showTranslation: true,
          fontSize: 28,
          dubbing: false,
        },
      }),
    [tabId, wav.sampleRate, withGap] as const,
  )) as { ok?: boolean; error?: string };

  console.log('start():', JSON.stringify(started));
  expect(started.error, 'start() threw').toBeUndefined();

  // The AudioContext must be running: suspended means the tab stays muted by
  // tabCapture *and* the audio thread never turns, which is silence plus no
  // captions at once.
  await expect
    .poll(
      async () =>
        harness.serviceWorker.evaluate(
          () => (globalThis as unknown as { __snap?: { contextState?: string } }).__snap?.contextState ?? null,
        ),
      { timeout: 30_000 },
    )
    .toBe('running');

  // Audio is flowing through the worklet: vad metrics only appear once chunks
  // reach the recognizer.
  await expect
    .poll(
      async () =>
        harness.serviceWorker.evaluate(
          () =>
            ((globalThis as unknown as { __msgs: { type?: string; stage?: string }[] }).__msgs ?? []).filter(
              (m) => m.type === 'metrics' && m.stage === 'vad',
            ).length,
        ),
      { timeout: 300_000, intervals: [2000] },
    )
    .toBeGreaterThan(20);

  // ...and a caption is painted from audio that went through capture.
  await expect
    .poll(async () => page.evaluate(() => (window as unknown as { __lines: unknown[] }).__lines.length), {
      timeout: 300_000,
      intervals: [2000],
    })
    .toBeGreaterThan(0);

  await page.waitForTimeout(6000);
  const lines = (await page.evaluate(
    () => (window as unknown as { __lines: { text: string; translation: string; interim: boolean }[] }).__lines,
  )) as { text: string; translation: string; interim: boolean }[];
  const finals = lines.filter((l) => !l.interim);
  const texts = [...new Set(finals.map((l) => l.text))];
  console.log('painted:', JSON.stringify(texts.slice(0, 3)));

  const snapshot = (await harness.serviceWorker.evaluate(
    () => (globalThis as unknown as { __snap: unknown }).__snap,
  )) as { contextState: string; droppedChunks: number; network: Record<string, number>; capturing: boolean };
  console.log('snapshot:', JSON.stringify(snapshot));

  expect(texts.length, 'a caption was painted from captured audio').toBeGreaterThan(0);
  const delivered = await harness.serviceWorker.evaluate(() => {
    const messages = (globalThis as unknown as { __msgs: { payload?: Caption }[] }).__msgs;
    return messages.map((m) => m.payload).filter((c): c is Caption => !!c && typeof c.original === 'string');
  });
  const chunks = [...new Map(delivered.map((c) => [c.id, c])).values()].sort((a, b) => a.videoStart - b.videoStart);
  const utterances = new Map<string, string[]>();
  for (const c of chunks) {
    const id = c.id.split('-')[0]!;
    utterances.set(id, [...(utterances.get(id) ?? []), c.original]);
  }
  const best = Math.min(...[...utterances.values()].map((words) => wer(REFERENCE, words.join(' '))));
  console.log(`best WER ${(best * 100).toFixed(1)}%`);
  expect(best, 'transcript from captured audio').toBeLessThan(0.5);
  expect(snapshot.droppedChunks, 'capture kept up').toBe(0);

  const errors = (await harness.serviceWorker.evaluate(
    () => ((globalThis as unknown as { __msgs: { type?: string }[] }).__msgs ?? []).filter((m) => m.type === 'error'),
  )) as unknown[];
  console.log('errors:', JSON.stringify(errors));
  expect(errors, 'no errors from any stage').toHaveLength(0);

  await harness.serviceWorker.evaluate(async (id) => chrome.runtime.sendMessage({ type: 'stop', tabId: id }), tabId);
  await page.close();
});
