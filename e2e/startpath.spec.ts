/**
 * The real start path, driven by the real message.
 *
 * Sends the exact `toggleCapture` the popup sends and lets the service worker
 * run its own `start()`: session lookup, offscreen creation, stream id,
 * message to the offscreen document, badge. Nothing is stubbed.
 *
 * `getMediaStreamId` is expected to refuse, because an `activeTab` grant needs
 * a real click on the extension's action and no harness can produce one. The
 * point of the test is that it is the *only* thing that refuses: everything
 * either side of it is verified here, so a real click is the single remaining
 * variable.
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

test('toggleCapture runs the whole start path and stops only at activeTab', async () => {
  const page = await harness.context.newPage();
  await page.goto('http://localhost:5311/page.html');
  await page.bringToFront();

  const tabId = await harness.serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab!.id!;
  });

  // Sent from the popup's own origin, which is where it comes from in
  // production. A service worker's sendMessage does not reach its own
  // listener, so sending from there would only ever fail to connect.
  const popup = await harness.context.newPage();
  await popup.goto(`chrome-extension://${harness.extensionId}/popup.html`);
  // The listener lives here too: a service worker does not receive its own
  // sendMessage, so the error it reports is only visible to another context —
  // which in production is exactly this popup.
  await popup.evaluate(() => {
    const w = window as unknown as { __msgs: unknown[] };
    w.__msgs = [];
    chrome.runtime.onMessage.addListener((m) => {
      w.__msgs.push(m);
    });
  });
  await popup.evaluate(async (id) => {
    await chrome.runtime.sendMessage({ type: 'toggleCapture', tabId: id });
  }, tabId);
  await page.waitForTimeout(3000);

  // The offscreen document was created by the real ensureOffscreen().
  const contexts = await harness.serviceWorker.evaluate(async () =>
    (await chrome.runtime.getContexts({})).map((c) => c.contextType),
  );
  console.log('contexts after toggleCapture:', JSON.stringify(contexts));
  expect(contexts, 'ensureOffscreen created the document').toContain('OFFSCREEN_DOCUMENT');

  const errors = (await popup.evaluate(() =>
    ((window as unknown as { __msgs: { type?: string; stage?: string; message?: string }[] }).__msgs ?? [])
      .filter((m) => m.type === 'error')
      .map((m) => `${m.stage}: ${m.message}`),
  )) as string[];
  console.log('errors:', JSON.stringify(errors));

  // The badge tells the user which way it went.
  const badge = await harness.serviceWorker.evaluate(
    async (id) => chrome.action.getBadgeText({ tabId: id }),
    tabId,
  );
  console.log('badge:', badge);

  // One failure, and it is the documented permission wall — not a wiring bug,
  // a missing listener, or a crash somewhere in the chain.
  expect(errors, 'exactly one failure in the whole start path').toHaveLength(1);
  expect(errors[0]).toContain('capture');
  expect(errors[0]).toMatch(/activeTab|has not been invoked/);
  expect(badge, 'the user is told it failed').toBe('ERR');

  // The popup renders whatever error arrives, so the user sees the reason
  // without opening a console.
  await expect(popup.getByText(/activeTab|has not been invoked/)).toBeVisible();

  // And the session was not left claiming a capture that is not running.
  const session = await harness.serviceWorker.evaluate(
    async () => (await chrome.storage.session.get('capture'))['capture'] ?? null,
  );
  expect(session, 'no phantom session after a failed start').toBeNull();

  await popup.close();
  await page.close();
});
