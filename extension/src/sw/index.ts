/**
 * Service worker: coordination only. It creates the offscreen document, mints
 * a tabCapture stream id and hands it over. No audio, no models — this worker
 * is killed whenever it goes idle, so it keeps nothing in memory that matters.
 *
 * Session state lives in chrome.storage.session, which survives a service
 * worker restart and is cleared when the browser closes.
 */

import {
  DEFAULT_CONFIG,
  isError,
  isSetConfig,
  isStop,
  isToggleCapture,
  type Config,
} from '@subtle/shared';

const OFFSCREEN_URL = 'offscreen.html';
const SESSION_KEY = 'capture';
const CONFIG_KEY = 'config';

interface CaptureSession {
  tabId: number;
}

// ------------------------------------------------------------------- state

async function getSession(): Promise<CaptureSession | null> {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  return (stored[SESSION_KEY] as CaptureSession | undefined) ?? null;
}

async function setSession(session: CaptureSession | null): Promise<void> {
  if (session) await chrome.storage.session.set({ [SESSION_KEY]: session });
  else await chrome.storage.session.remove(SESSION_KEY);
}

async function getConfig(): Promise<Config> {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  return { ...DEFAULT_CONFIG, ...((stored[CONFIG_KEY] as Partial<Config> | undefined) ?? {}) };
}

// -------------------------------------------------------------- offscreen

/**
 * Creating two offscreen documents throws, and two `start` clicks in quick
 * succession would otherwise both see "none exists".
 */
let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (contexts.length > 0) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      // USER_MEDIA for getUserMedia, AUDIO_PLAYBACK because we also play the
      // captured audio back — tabCapture mutes the tab, so the offscreen
      // document is what the user actually hears.
      reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
      justification: 'Capture tab audio, play it back, and run on-device speech recognition.',
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

// ------------------------------------------------------------------ badge

type BadgeState = 'on' | 'off' | 'error';

async function setBadge(tabId: number, state: BadgeState): Promise<void> {
  const text = state === 'on' ? 'ON' : state === 'error' ? 'ERR' : 'off';
  const color = state === 'on' ? '#16a34a' : state === 'error' ? '#dc2626' : '#6b7280';
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch {
    // The tab is gone; there is no badge left to set.
  }
}

// ------------------------------------------------------------ start / stop

/**
 * @types/chrome only declares the callback form; Chrome returns a promise in
 * MV3. Wrapping it works either way and surfaces lastError as a rejection.
 */
function getMediaStreamId(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message ?? 'getMediaStreamId failed'));
      else resolve(streamId);
    });
  });
}

async function start(tabId: number): Promise<void> {
  const previous = await getSession();
  if (previous && previous.tabId !== tabId) await stop(previous.tabId);

  try {
    await ensureOffscreen();
    // Single-use, and only mintable while this tab has an activeTab grant —
    // which the action click we are handling just gave us.
    const streamId = await getMediaStreamId(tabId);
    const result = await chrome.runtime.sendMessage({ type: 'start', tabId, streamId, config: await getConfig() });
    if (result?.error) throw new Error(result.error);
    await setSession({ tabId });
    await setBadge(tabId, 'on');
  } catch (err) {
    await setSession(null);
    await setBadge(tabId, 'error');
    const message = err instanceof Error ? err.message : String(err);
    await chrome.runtime.sendMessage({ type: 'error', stage: 'capture', message }).catch(() => {});
    console.error('[subtle] capture failed', err);
    throw err;
  }
}

async function stop(tabId: number): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'stop', tabId }).catch(() => {});
  const session = await getSession();
  if (session?.tabId === tabId) await setSession(null);
  await setBadge(tabId, 'off');
}

async function toggle(tabId: number): Promise<void> {
  const session = await getSession();
  if (session?.tabId === tabId) await stop(tabId);
  else await start(tabId);
}

/**
 * Chrome only injects content scripts when a page loads, so every tab that was
 * already open when the extension was installed, updated or reloaded has no
 * overlay — and the extension looks silently broken on exactly the tab the
 * user was watching. Inject into them by hand, once.
 */
async function injectIntoOpenTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }).catch(() => []);
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['content.js'],
        });
      } catch {
        // Restricted pages (the web store, other extensions' pages) refuse
        // injection; nothing to be done and nothing worth reporting.
      }
    }),
  );
}

// ----------------------------------------------------------------- events

chrome.runtime.onInstalled.addListener(() => void injectIntoOpenTabs());
chrome.runtime.onStartup.addListener(() => void injectIntoOpenTabs());

// Fires only when the action has no default_popup. The popup owns the click,
// so this is here for the day it does not and costs nothing meanwhile.
chrome.action.onClicked.addListener((tab) => {
  if (tab.id !== undefined) void toggle(tab.id).catch(() => {});
});

// Commands do not reach content scripts, so the service worker relays them.
chrome.commands.onCommand.addListener((command, tab) => {
  if (tab?.id === undefined) return;
  void chrome.tabs.sendMessage(tab.id, { type: 'command', command }).catch(() => {
    // No content script on this page (a chrome:// tab, say).
  });
});

/**
 * The offscreen document cannot reach content scripts — it only has
 * `chrome.runtime` — so it hands anything bound for the tab to us.
 * See BUGS.md E-3.
 */
function isRelay(m: unknown): m is { type: 'relayToTab'; tabId: number; payload: unknown } {
  return typeof m === 'object' && m !== null && (m as { type?: string }).type === 'relayToTab';
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (isRelay(message)) {
    void chrome.tabs.sendMessage(message.tabId, message.payload).catch(() => {
      // Tab gone or no content script on it.
    });
    return false;
  }
  if (isToggleCapture(message)) {
    void toggle(message.tabId).then(() => respond({ ok: true })).catch((err: unknown) =>
      respond({ error: err instanceof Error ? err.message : String(err) }),
    );
    return true;
  }
  if (isStop(message)) {
    void stop(message.tabId).then(() => respond({ ok: true }));
    return true;
  }
  if (isSetConfig(message)) {
    void chrome.storage.local.set({ [CONFIG_KEY]: message.config });
    return false;
  }
  if (isError(message)) {
    void getSession().then((s) => {
      if (s) void setBadge(s.tabId, 'error');
    });
    return false;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void getSession().then((s) => {
    if (s?.tabId === tabId) void stop(tabId);
  });
});

// A navigation replaces the page, its <video> and its content script, so the
// old capture is stamped against a timeline that no longer exists.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading' || changeInfo.url === undefined) return;
  void getSession().then((s) => {
    if (s?.tabId === tabId) void stop(tabId);
  });
});

console.log('[subtle] sw ok');
