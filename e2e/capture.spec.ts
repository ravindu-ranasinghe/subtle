/**
 * The capture graph, running for real in the offscreen document.
 *
 * Everything here is the shipping code path except the one call that cannot
 * be reached from automation: `chrome.tabCapture.getMediaStreamId` needs an
 * `activeTab` grant, which needs a genuine click on the extension's action.
 * Host permissions do not substitute — env.spec.ts records the exact refusal.
 * So the stream comes from an oscillator instead, and `startCaptureFromStream`
 * takes it from there.
 */

import { expect, test } from '@playwright/test';
import { launch, type Harness } from './harness.js';

let harness: Harness;

interface SelfTest {
  inputRate: number;
  contextState: string;
  runningState?: string;
  chunks: { length: number; audioStart: number; rms: number }[];
  delivered: number;
  dropped: number;
  statsAfterStop: unknown;
  error?: string;
}

async function ensureOffscreen(harness: Harness): Promise<void> {
  await harness.serviceWorker.evaluate(async () => {
    const existing = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    if (existing.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification: 'capture self-test',
      });
    }
  });
}

test.beforeAll(async () => {
  harness = await launch();
  await ensureOffscreen(harness);
});
test.afterAll(async () => {
  await harness?.close();
});

test('startCaptureFromStream delivers 16 kHz chunks on a contiguous clock', async () => {
  const result = (await harness.serviceWorker.evaluate(
    async () => chrome.runtime.sendMessage({ type: 'debugCaptureSelfTest', seconds: 2.5, toneHz: 1000 }),
  )) as SelfTest;

  console.log(
    `input ${result.inputRate} Hz · ${result.chunks.length} chunks · delivered ${result.delivered} · ` +
      `dropped ${result.dropped} · context ${result.contextState}`,
  );
  expect(result.error, 'capture threw').toBeUndefined();

  // The regression that made the extension silent AND caption-less: an
  // offscreen document has no user activation, so its AudioContext is created
  // suspended. Suspended means the destination never renders (no passthrough,
  // the tab stays muted by tabCapture) and the audio thread never runs (no
  // chunks, no captions). It has to be running while capturing.
  expect(result.runningState, 'AudioContext while capturing').toBe('running');

  // The worklet loaded through chrome.runtime.getURL and produced 100 ms frames.
  expect(result.chunks.length).toBeGreaterThanOrEqual(15);
  for (const c of result.chunks) expect(c.length).toBe(1600);

  for (let i = 1; i < result.chunks.length; i++) {
    expect(result.chunks[i]!.audioStart - result.chunks[i - 1]!.audioStart).toBeCloseTo(0.1, 6);
  }

  // The tone actually made it through the graph rather than arriving silent.
  const loud = result.chunks.filter((c) => c.rms > 0.3);
  expect(loud.length, 'chunks carried the oscillator').toBeGreaterThan(result.chunks.length / 2);

  // Nothing was shed: the reader kept up.
  expect(result.dropped).toBe(0);
  expect(result.delivered).toBeGreaterThanOrEqual(result.chunks.length);
});

test('stopCapture tears the context down and clears the stats', async () => {
  const result = (await harness.serviceWorker.evaluate(
    async () => chrome.runtime.sendMessage({ type: 'debugCaptureSelfTest', seconds: 1, toneHz: 440 }),
  )) as SelfTest;

  expect(result.error).toBeUndefined();
  // captureStats() returns null once nothing is being captured, which is the
  // signal the debug panel and the offscreen document both key off.
  expect(result.statsAfterStop).toBeNull();
});

test('a second capture replaces the first rather than stacking', async () => {
  const first = (await harness.serviceWorker.evaluate(async () =>
    chrome.runtime.sendMessage({ type: 'debugCaptureSelfTest', seconds: 1, toneHz: 300 }),
  )) as SelfTest;
  const second = (await harness.serviceWorker.evaluate(async () =>
    chrome.runtime.sendMessage({ type: 'debugCaptureSelfTest', seconds: 1, toneHz: 600 }),
  )) as SelfTest;

  expect(first.error).toBeUndefined();
  expect(second.error).toBeUndefined();
  expect(second.chunks.length).toBeGreaterThan(0);
  // Each run starts its own AudioContext, so the clock restarts near zero
  // rather than continuing from the previous run.
  expect(second.chunks[0]!.audioStart).toBeLessThan(2);
});
