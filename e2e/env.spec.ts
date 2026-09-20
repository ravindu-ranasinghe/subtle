/**
 * What the extension can actually do in each context, measured rather than
 * assumed. Every row here was a wrong assumption at some point.
 */

import { expect, test } from '@playwright/test';
import { launch, type Harness } from './harness.js';

let harness: Harness;

test.beforeAll(async () => {
  harness = await launch();
});
test.afterAll(async () => {
  await harness?.close();
});

test('context capability matrix', async () => {
  const page = await harness.context.newPage();
  await page.goto('http://localhost:5311/page.html');
  await page.bringToFront();

  // --- service worker -----------------------------------------------------
  const sw = await harness.serviceWorker.evaluate(() => ({
    tabs: typeof chrome.tabs?.sendMessage === 'function',
    tabCapture: typeof chrome.tabCapture?.getMediaStreamId === 'function',
    translator: typeof (self as unknown as { Translator?: unknown }).Translator === 'function',
    speechSynthesis: typeof (self as unknown as { speechSynthesis?: unknown }).speechSynthesis !== 'undefined',
    webgpu: typeof (navigator as unknown as { gpu?: unknown }).gpu !== 'undefined',
  }));
  console.log('SERVICE WORKER', JSON.stringify(sw));

  // --- extension page (the popup is one) ----------------------------------
  const ext = await harness.context.newPage();
  await ext.goto(`chrome-extension://${harness.extensionId}/popup.html`);
  const extEnv = await ext.evaluate(() => ({
    tabs: typeof chrome.tabs?.sendMessage === 'function',
    translator: typeof (self as unknown as { Translator?: unknown }).Translator === 'function',
    languageDetector: typeof (self as unknown as { LanguageDetector?: unknown }).LanguageDetector === 'function',
    speechSynthesis: typeof speechSynthesis !== 'undefined',
    voices: typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices().length : 0,
    webgpu: typeof (navigator as unknown as { gpu?: unknown }).gpu !== 'undefined',
  }));
  console.log('EXTENSION PAGE', JSON.stringify(extEnv));

  // --- offscreen document, via its own report -----------------------------
  await harness.serviceWorker.evaluate(async () => {
    const existing = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    if (existing.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification: 'capability probe',
      });
    }
    const g = globalThis as unknown as { __snap?: unknown };
    chrome.runtime.onMessage.addListener((m: { type?: string; snapshot?: unknown }) => {
      if (m?.type === 'relayToTab') {
        const payload = (m as unknown as { payload?: { type?: string; snapshot?: unknown } }).payload;
        if (payload?.type === 'debugStats') g.__snap = payload.snapshot;
      }
    });
  });
  const tabId = await harness.serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab!.id!;
  });
  await harness.serviceWorker.evaluate(
    async (id) => chrome.runtime.sendMessage({ type: 'debugStart', tabId: id, config: { whisperModel: 'tiny' } }),
    tabId,
  );
  await expect
    .poll(async () => harness.serviceWorker.evaluate(() => (globalThis as unknown as { __snap?: unknown }).__snap !== undefined), {
      timeout: 30_000,
    })
    .toBe(true);
  const offscreen = await harness.serviceWorker.evaluate(
    () => (globalThis as unknown as { __snap: { env: unknown } }).__snap.env,
  );
  console.log('OFFSCREEN', JSON.stringify(offscreen));

  // --- does tabCapture really need a click? -------------------------------
  const capture = await harness.serviceWorker.evaluate(
    (id) =>
      new Promise<string>((resolve) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: id }, (streamId) => {
          const err = chrome.runtime.lastError;
          resolve(err ? `ERROR: ${err.message}` : `OK: ${streamId.slice(0, 12)}…`);
        });
      }),
    tabId,
  );
  console.log('TAB CAPTURE (no gesture)', JSON.stringify(capture));

  await harness.serviceWorker.evaluate(async (id) => chrome.runtime.sendMessage({ type: 'stop', tabId: id }));
  await ext.close();
  await page.close();
});
