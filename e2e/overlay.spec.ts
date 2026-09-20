/**
 * The overlay on a hostile page: a strict Content-Security-Policy, and a real
 * fullscreen transition driven by a real click.
 *
 * Content scripts are documented as exempt from the host page's CSP for what
 * they inject. This checks it, because the overlay is useless if its
 * stylesheet is dropped, and the failure would be silent — an unstyled
 * `position: static` div behind the video.
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

/** Puts a caption on screen by way of the service worker, as the offscreen doc would. */
async function paint(h: Harness, tabId: number, original: string, translation: string): Promise<void> {
  await h.serviceWorker.evaluate(
    async ([id, text, tr]) => {
      await chrome.tabs.sendMessage(id as number, {
        type: 'caption',
        id: 'u1',
        original: text,
        translation: tr,
        srcLang: 'es',
        tgtLang: 'en',
        videoStart: 0,
        videoEnd: 9999,
        interim: false,
      });
    },
    [tabId, original, translation] as const,
  );
}

test('renders and styles correctly under a strict CSP', async () => {
  const page = await harness.context.newPage();
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
  });
  await page.goto('http://localhost:5311/strict.html');
  await page.bringToFront();

  // Prove the CSP is actually in force before concluding anything from it:
  // an inline style added by page script must be refused.
  const cspActive = await page.evaluate(() => {
    try {
      const s = document.createElement('style');
      s.textContent = 'body { outline: 1px solid red; }';
      document.head.append(s);
      return getComputedStyle(document.body).outlineStyle !== 'solid';
    } catch {
      return true;
    }
  });
  expect(cspActive, 'the page CSP is in force').toBe(true);
  // That probe deliberately tripped the policy; from here anything logged is
  // the overlay's doing.
  violations.length = 0;

  await harness.serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({ ui: { captionsOn: true, immersion: false, debug: false } });
  });
  const tabId = await harness.serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab!.id!;
  });

  await expect
    .poll(async () => page.evaluate(() => !!document.querySelector('[data-subtle="overlay"]')), { timeout: 20_000 })
    .toBe(true);

  await paint(harness, tabId, 'El tren llega a las siete.', 'The train arrives at seven.');

  // The stylesheet inside the shadow root survived: `position: fixed` and the
  // caption background both come from it. Static positioning would mean the
  // <style> was dropped.
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const root = document
            .querySelector('[data-subtle="overlay"]')
            ?.shadowRoot?.querySelector('.root') as HTMLElement | null;
          if (!root) return null;
          const style = getComputedStyle(root);
          return { position: style.position, zIndex: style.zIndex, hidden: root.hidden };
        }),
      { timeout: 20_000 },
    )
    .toMatchObject({ position: 'fixed', hidden: false });

  const line = await page.evaluate(() => {
    const shadow = document.querySelector('[data-subtle="overlay"]')!.shadowRoot!;
    const original = shadow.querySelector('.original') as HTMLElement;
    const cs = getComputedStyle(original);
    return {
      text: original.textContent,
      translation: shadow.querySelector('.translation')?.textContent,
      background: cs.backgroundColor,
      colour: cs.color,
      words: shadow.querySelectorAll('.w').length,
    };
  });
  console.log('under strict CSP:', JSON.stringify(line));
  expect(line.text).toContain('El tren');
  expect(line.translation).toContain('The train');
  expect(line.words).toBeGreaterThan(3);
  // A dropped stylesheet leaves the default transparent background.
  expect(line.background, 'caption background came from the shadow stylesheet').not.toBe('rgba(0, 0, 0, 0)');
  expect(violations, 'the overlay tripped no CSP directive').toEqual([]);

  await page.close();
});

test('re-parents into a real fullscreen element and back', async () => {
  const page = await harness.context.newPage();
  await page.goto('http://localhost:5311/strict.html');
  await page.bringToFront();

  const tabId = await harness.serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab!.id!;
  });
  await expect
    .poll(async () => page.evaluate(() => !!document.querySelector('[data-subtle="overlay"]')), { timeout: 20_000 })
    .toBe(true);
  await paint(harness, tabId, 'Hola mundo', 'Hello world');

  const where = (): Promise<string | null> =>
    page.evaluate(() => document.querySelector('[data-subtle="overlay"]')?.parentElement?.tagName ?? null);
  expect(await where()).toBe('BODY');

  // A trusted click is what requestFullscreen requires; this is the real
  // transition, not a stubbed document.fullscreenElement.
  await page.evaluate(() => {
    document.querySelector('#fs')!.addEventListener('click', () => {
      void document.querySelector('#wrap')!.requestFullscreen();
    });
  });
  await page.click('#fs');
  await expect.poll(async () => page.evaluate(() => !!document.fullscreenElement), { timeout: 10_000 }).toBe(true);

  // The overlay must follow: nothing outside the fullscreen element renders.
  await expect.poll(where, { timeout: 10_000 }).toBe('DIV');
  const stillThere = await page.evaluate(
    () =>
      document.querySelector('[data-subtle="overlay"]')!.shadowRoot!.querySelector('.original')?.textContent ?? '',
  );
  expect(stillThere, 'caption survived the move').toContain('Hola');

  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(where, { timeout: 10_000 }).toBe('BODY');

  await page.close();
});
