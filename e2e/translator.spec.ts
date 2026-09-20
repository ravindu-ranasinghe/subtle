/**
 * Chrome's built-in Translator, end to end: availability, the user-gesture
 * wall, the download that only a real click can authorise, and translation
 * afterwards.
 *
 * The download lands in this test profile, not the user's browser.
 */

import { expect, test } from '@playwright/test';
import { launch, type Harness } from './harness.js';

let harness: Harness;

interface SelfTest {
  supported: boolean;
  availability: 'yes' | 'download' | 'no';
  detectorAvailability: string;
  translated: string | null;
  error: string | null;
  detected: string | null;
  gloss: { word: string; translation: string } | null;
}

async function ensureOffscreen(h: Harness): Promise<void> {
  await h.serviceWorker.evaluate(async () => {
    const existing = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    if (existing.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.USER_MEDIA],
        justification: 'translator self-test',
      });
    }
  });
}

const selfTest = (h: Harness, src = 'es', tgt = 'en'): Promise<SelfTest> =>
  h.serviceWorker.evaluate(
    async ([s, t]) =>
      chrome.runtime.sendMessage({
        type: 'debugTranslatorSelfTest',
        src: s,
        tgt: t,
        text: 'El tren llega a las siete.',
      }),
    [src, tgt] as const,
  ) as Promise<SelfTest>;

test.beforeAll(async () => {
  harness = await launch();
  await ensureOffscreen(harness);
});
test.afterAll(async () => {
  await harness?.close();
});

test.describe.configure({ mode: 'serial' });

test('the API is present in the offscreen document', async () => {
  const before = await selfTest(harness);
  console.log('BEFORE DOWNLOAD', JSON.stringify(before));

  // SPIKES C.6.1, which was open: the Translator API does reach an offscreen
  // document, even though chrome.tabs does not.
  expect(before.supported, 'Translator API in the offscreen document').toBe(true);

  // On a fresh profile the detector model is not there either, and an
  // offscreen document cannot authorise its download any more than it can the
  // translator's. detectLanguage returns null rather than throwing.
  if (before.detectorAvailability !== 'available') {
    expect(before.detected, 'no detector yet, so no detection').toBeNull();
  }
});

test('a pack that needs downloading is refused without a gesture, not silently', async () => {
  const before = await selfTest(harness);
  test.skip(before.availability === 'yes', 'pack already installed on this profile');

  expect(before.availability).toBe('download');
  // The offscreen document can never satisfy this: it is not a surface anyone
  // can click. The wrapper turns it into a typed error the popup can act on.
  expect(before.error).toContain('LanguagePackRequiredError');
  expect(before.translated).toBeNull();
});

test('a real click downloads the pack, and translation works afterwards', async () => {
  // The result is reported through the service worker rather than polled from
  // the page: the popup page does not reliably survive Chrome's pack download
  // in an automated profile, and a dead page loses a page.evaluate result.
  await harness.serviceWorker.evaluate(() => {
    const g = globalThis as unknown as { __dl?: string | undefined; __p?: number | undefined };
    g.__dl = undefined;
    chrome.runtime.onMessage.addListener((m: { type?: string; value?: string; progress?: number }) => {
      if (m?.type === 'packResult') g.__dl = m.value;
      if (m?.type === 'packProgress') g.__p = m.progress;
    });
  });

  const page = await harness.context.newPage();
  page.on('close', () => console.log('  popup page closed'));
  page.on('crash', () => console.log('  popup page crashed'));
  await page.goto(`chrome-extension://${harness.extensionId}/popup.html`);

  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'dl';
    button.textContent = 'download';
    document.body.append(button);
    button.addEventListener('click', () => {
      void (async () => {
        const say = (type: string, body: Record<string, unknown>): void => {
          void chrome.runtime.sendMessage({ type, ...body }).catch(() => {});
        };
        try {
          const api = (self as unknown as {
            Translator: {
              create(o: Record<string, unknown>): Promise<{ translate(t: string): Promise<string>; destroy?(): void }>;
            };
          }).Translator;
          const t = await api.create({
            sourceLanguage: 'es',
            targetLanguage: 'en',
            monitor(m: { addEventListener(n: string, f: (e: { loaded: number }) => void): void }) {
              m.addEventListener('downloadprogress', (e) => say('packProgress', { progress: e.loaded }));
            },
          });
          const sample = await t.translate('El tren llega a las siete.');
          t.destroy?.();
          say('packResult', { value: `OK: ${sample}` });
        } catch (err) {
          say('packResult', {
            value: `ERROR: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
          });
        }
      })();
    });
  });

  // A trusted click gives this document transient activation — exactly what
  // Chrome demands, and exactly what the popup exists to provide.
  await page.click('#dl');

  await expect
    .poll(
      async () => {
        const state = await harness.serviceWorker.evaluate(() => {
          const g = globalThis as unknown as { __dl?: string | undefined; __p?: number | undefined };
          return { result: g.__dl ?? null, progress: g.__p ?? null };
        });
        if (state.result === null && state.progress !== null) {
          console.log(`  downloading… ${Math.round(state.progress * 100)}%`);
        }
        return state.result;
      },
      { timeout: 600_000, intervals: [5000] },
    )
    .not.toBeNull();

  const result = await harness.serviceWorker.evaluate(
    () => (globalThis as unknown as { __dl: string }).__dl,
  );
  console.log('WITH GESTURE:', result);
  expect(result, 'download + translate under a user gesture').toContain('OK:');
  await page.close().catch(() => {});
});

test('the wrapper translates and glosses once the pack is there', async () => {
  const after = await selfTest(harness);
  console.log('AFTER DOWNLOAD', JSON.stringify(after));

  expect(after.availability).toBe('yes');
  expect(after.error).toBeNull();
  expect(after.translated, 'translation is non-empty English').toBeTruthy();
  expect(after.translated!.toLowerCase()).toContain('train');
  expect(after.gloss?.translation, 'gloss of "tren"').toBeTruthy();
  // The detector is a separate model and reports `unavailable` on a fresh
  // automated profile — no gesture unlocks it. Whisper's own detection is the
  // primary path; this one is the fallback, so a miss is degraded, not broken.
  if (after.detectorAvailability === 'available') {
    expect(after.detected, 'language detected from the caption text').toBe('es');
  } else {
    console.log(`LanguageDetector unavailable on this profile (${after.detectorAvailability}) — detection skipped`);
    expect(after.detected).toBeNull();
  }
});
