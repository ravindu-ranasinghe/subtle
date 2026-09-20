/**
 * The popup, rendered for real.
 *
 * It is an ordinary extension page, so it can be opened directly and driven
 * like any other React app — the chrome.* APIs it uses are all available at
 * that origin.
 */

import { expect, test } from '@playwright/test';
import { launch, type Harness } from './harness.js';

let harness: Harness;
let url: string;

test.beforeAll(async () => {
  harness = await launch();
  url = `chrome-extension://${harness.extensionId}/popup.html`;
});
test.afterAll(async () => {
  await harness?.close();
});

/** Clears anything a previous test wrote, so each starts from defaults. */
async function reset(): Promise<void> {
  await harness.serviceWorker.evaluate(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
  });
}

test('renders the whole surface', async () => {
  await reset();
  const page = await harness.context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);

  await expect(page.getByRole('heading', { name: 'Subtle' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Start captions/ })).toBeVisible();
  await expect(page.getByRole('combobox').first()).toBeVisible();
  await expect(page.getByRole('radio', { name: /tiny/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Delete downloaded models/ })).toBeVisible();
  await expect(page.getByText('Saved words (0)')).toBeVisible();
  await expect(page.getByText(/Click a word in the captions/)).toBeVisible();

  // Download sizes are shown next to each model, as the task asks.
  await expect(page.getByText('43 MB')).toBeVisible();
  await expect(page.getByText('77 MB')).toBeVisible();
  await expect(page.getByText('259 MB')).toBeVisible();

  expect(errors, 'no uncaught errors while rendering').toEqual([]);
  await page.close();
});

test('settings round-trip through storage', async () => {
  await reset();
  const page = await harness.context.newPage();
  await page.goto(url);

  await page.getByRole('combobox').first().selectOption('es');
  await page.getByRole('combobox').nth(1).selectOption('fr');
  await page.getByRole('radio', { name: /small/ }).check();
  await page.getByRole('checkbox', { name: /Show translation line/ }).uncheck();
  await page.getByRole('checkbox', { name: /Dub audio/ }).check();
  await page.locator('input[type="range"]').fill('36');

  await expect
    .poll(async () =>
      harness.serviceWorker.evaluate(async () => (await chrome.storage.local.get('config'))['config']),
    )
    .toMatchObject({ srcLang: 'es', tgtLang: 'fr', whisperModel: 'small', showTranslation: false, dubbing: true, fontSize: 36 });

  // ...and the saved values come back on reopen.
  const reopened = await harness.context.newPage();
  await reopened.goto(url);
  await expect(reopened.getByRole('combobox').first()).toHaveValue('es');
  await expect(reopened.getByRole('radio', { name: /small/ })).toBeChecked();
  await expect(reopened.locator('input[type="range"]')).toHaveValue('36');
  await expect(reopened.getByRole('checkbox', { name: /Dub audio in French/ })).toBeChecked();
  await reopened.close();
  await page.close();
});

test('the start button asks the service worker to toggle capture', async () => {
  await reset();
  const page = await harness.context.newPage();
  await page.goto(url);

  await harness.serviceWorker.evaluate(() => {
    const g = globalThis as unknown as { __seen: unknown[] };
    g.__seen = [];
    chrome.runtime.onMessage.addListener((m) => {
      g.__seen.push(m);
    });
  });

  await page.getByRole('button', { name: /Start captions/ }).click();
  await expect
    .poll(async () =>
      harness.serviceWorker.evaluate(() =>
        ((globalThis as unknown as { __seen: { type?: string }[] }).__seen ?? []).filter(
          (m) => m.type === 'toggleCapture',
        ).length,
      ),
    )
    .toBeGreaterThan(0);

  // This test has no activeTab gesture: capture failure must not look like success.
  await expect(page.getByRole('button', { name: /Start captions/ })).toBeEnabled();
  await expect(page.getByRole('status')).toBeVisible();
  await page.close();
});

test('the debug toggle writes a complete ui object', async () => {
  await reset();
  const page = await harness.context.newPage();
  await page.goto(url);

  await page.getByRole('checkbox', { name: /Debug panel/ }).check();
  await expect
    .poll(async () => harness.serviceWorker.evaluate(async () => (await chrome.storage.local.get('ui'))['ui']))
    .toMatchObject({ debug: true });
  await page.close();
});

test('saved words list and both export formats', async () => {
  await reset();
  await harness.serviceWorker.evaluate(async () => {
    await chrome.storage.local.set({
      savedWords: [
        {
          word: 'Morgen',
          sentence: 'Guten Morgen, wie geht es dir?',
          translation: 'morning',
          pos: 'noun',
          url: 'https://example.com/watch?v=1',
          videoTime: 92.5,
          savedAt: Date.UTC(2026, 8, 19, 12, 0, 0),
        },
        {
          word: 'Abend',
          sentence: 'Guten Abend',
          translation: 'evening',
          url: 'https://example.com/watch?v=2',
          videoTime: 10,
          savedAt: Date.UTC(2026, 8, 19, 13, 0, 0),
        },
      ],
    });
  });

  const page = await harness.context.newPage();
  await page.goto(url);
  await expect(page.getByText('Saved words (2)')).toBeVisible();
  await expect(page.getByText('morning')).toBeVisible();
  await expect(page.getByText('evening')).toBeVisible();

  const csvDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const csv = await csvDownload;
  expect(csv.suggestedFilename()).toBe('subtle-words.csv');
  const csvText = await (await csv.createReadStream()).toArray();
  const csvBody = Buffer.concat(csvText).toString('utf8');
  console.log('CSV:', JSON.stringify(csvBody.split('\r\n')[1]));
  expect(csvBody.split('\r\n')[0]).toBe('word,translation,pos,sentence,url,videoTime,savedAt');
  expect(csvBody).toContain('"Guten Morgen, wie geht es dir?"');

  const ankiDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export Anki' }).click();
  const anki = await ankiDownload;
  expect(anki.suggestedFilename()).toBe('subtle-words.txt');
  const ankiBody = Buffer.concat(await (await anki.createReadStream()).toArray()).toString('utf8');
  console.log('ANKI:', JSON.stringify(ankiBody.split('\n')[0]));
  const fields = ankiBody.split('\n')[0]!.split('\t');
  expect(fields).toHaveLength(4);
  expect(fields[0]).toBe('Morgen');
  expect(fields[1]).toBe('morning (noun)');

  // Removing a word updates the list in place.
  await page.locator('.words .x').first().click();
  await expect(page.getByText('Saved words (1)')).toBeVisible();
  await page.close();
});

test('surfaces an error and offers the language pack download', async () => {
  await reset();
  const page = await harness.context.newPage();
  await page.goto(url);
  await expect(page.getByRole('button', { name: /Start captions/ })).toBeVisible();

  await harness.serviceWorker.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: 'languagePackRequired', src: 'es', tgt: 'en' });
  });

  await expect(page.getByRole('button', { name: /Download es → en language pack/ })).toBeVisible();
  await page.close();
});

test('reports the active backends once they are known', async () => {
  await reset();
  const page = await harness.context.newPage();
  await page.goto(url);
  await expect(page.getByRole('button', { name: /Start captions/ })).toBeVisible();

  await harness.serviceWorker.evaluate(async () => {
    await chrome.runtime.sendMessage({
      type: 'backend',
      backend: 'webgpu',
      adapter: 'apple metal-3',
      translator: 'local-mt',
    });
  });
  await expect(page.getByText(/Running on apple metal-3 · local-mt/)).toBeVisible();
  await page.close();
});
