/**
 * Content script: find the video, report its clock, draw the captions.
 *
 * Built as a classic script — content scripts are not modules.
 */

import {
  DEFAULT_CONFIG,
  isCaption,
  isGlossResponse,
  isSetConfig,
  type Caption,
  type Config,
} from '@subtle/shared';
import { DebugPanel } from '../debug/debug-panel.js';
import type { DebugSnapshot } from '../debug/stats.js';
import { CaptionStore } from './captions.js';
import { Overlay } from './overlay.js';
import { saveWord, type SavedWord } from './saved.js';
import { VideoWatcher } from './video.js';

/** videoSync cadence while nothing else is happening. */
const HEARTBEAT_MS = 2000;

/**
 * When the extension is reloaded, the content scripts already in a page are
 * orphaned: the DOM stays, but `chrome.runtime` is dead and every call throws
 * `Extension context invalidated` — **synchronously**, so a `.catch()` on the
 * returned promise never runs. An orphan that keeps its heartbeat going fills
 * the console with uncaught errors every two seconds, forever.
 *
 * `chrome.runtime.id` is undefined once the context is gone, which is the
 * cheap way to notice before making a call.
 */
function alive(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

let torndown = false;

/** Sends a message, or quietly retires this instance if the extension is gone. */
function send(message: unknown): void {
  if (!alive()) {
    teardown();
    return;
  }
  try {
    void chrome.runtime.sendMessage(message).catch(() => {
      // No receiver: the service worker is asleep or the offscreen document
      // has not been created yet. Normal, and nothing to do about it.
    });
  } catch {
    teardown();
  }
}

/** Same, for the writes that would otherwise throw on an orphan. */
function persist(items: Record<string, unknown>): void {
  if (!alive()) {
    teardown();
    return;
  }
  try {
    void chrome.storage.local.set(items).catch(() => {});
  } catch {
    teardown();
  }
}

interface UiState {
  captionsOn: boolean;
  immersion: boolean;
  debug: boolean;
}

let config: Config = DEFAULT_CONFIG;
let ui: UiState = { captionsOn: true, immersion: false, debug: false };

const store = new CaptionStore();
const overlay = new Overlay(document, { onWordClick: requestGloss });
const watcher = new VideoWatcher(onVideoChange);
// Same shadow root as the captions, so site CSS cannot reach it either.
const debugPanel = new DebugPanel(overlay.host.shadowRoot!, document);

let heartbeat: ReturnType<typeof setInterval> | null = null;
let frame = 0;
/** Gloss requests waiting on a response, keyed by word. */
const pendingGloss = new Map<string, { sentence: string; anchor: DOMRect; requestedAt: number }>();
/** Caption id -> when its message arrived, for the render metric. */
const arrived = new Map<string, number>();

// ------------------------------------------------------------------- sync

/**
 * `audioTime` is supposed to be the offscreen AudioContext clock, which this
 * context cannot read, and `tabId` is not knowable here either. Both are
 * filled in by the receiver — see CONTRACT_CHANGE_REQUEST.md D-2.
 */
function sendSync(): void {
  const video = watcher.video;
  if (!video) return;
  send({
    type: 'videoSync',
    tabId: -1,
    videoTime: video.currentTime,
    audioTime: performance.now() / 1000,
    paused: video.paused || video.ended,
    playbackRate: video.playbackRate,
  });
}

const SYNC_EVENTS = ['play', 'pause', 'seeking', 'seeked', 'ratechange', 'playing', 'waiting'] as const;

function onVideoChange(video: HTMLVideoElement | null): void {
  // A different video is a different timeline; the old lines are meaningless.
  store.clear();
  overlay.attachTo(video);
  overlay.closePopover();
  if (!video) return;
  for (const event of SYNC_EVENTS) {
    video.addEventListener(event, onSyncEvent, { passive: true });
  }
  sendSync();
}

function onSyncEvent(event: Event): void {
  // A seek invalidates everything already on screen.
  if (event.type === 'seeking') store.clear();
  sendSync();
}

// ----------------------------------------------------------------- render

function tick(): void {
  frame = requestAnimationFrame(tick);
  overlay.reparent();
  overlay.syncPosition();

  const video = watcher.video;
  if (!video || !ui.captionsOn) {
    overlay.render({ caption: null, showTranslation: false, fontSize: config.fontSize, immersion: ui.immersion });
    return;
  }
  const caption = store.activeAt(video.currentTime, config.showTranslation && !ui.immersion);
  overlay.render({
    caption,
    showTranslation: config.showTranslation,
    fontSize: config.fontSize,
    immersion: ui.immersion,
  });

  // Painted: the metric is message-received to on-screen, so it is reported
  // from the frame that actually put the line up.
  if (caption) {
    const at = arrived.get(caption.id);
    if (at !== undefined) {
      arrived.delete(caption.id);
      send({ type: 'metrics', stage: 'render', ms: performance.now() - at, segmentId: caption.id });
    }
  }
}

// ------------------------------------------------------------------ gloss

function requestGloss(word: string, sentence: string, anchor: DOMRect): void {
  pendingGloss.set(word, { sentence, anchor, requestedAt: performance.now() });
  overlay.showPopover(anchor, (root) => {
    root.append(el('b', word), el('div', 'Looking up…', 'tr'));
  });
  send({
    type: 'glossRequest',
    word,
    sentence,
    srcLang: config.srcLang === 'auto' ? (store.latest()?.srcLang ?? 'auto') : config.srcLang,
    tgtLang: config.tgtLang,
  });
}

function showGlossError(word: string): void {
  const pending = pendingGloss.get(word);
  if (!pending) return;
  overlay.showPopover(pending.anchor, (root) => {
    root.append(el('b', word), el('div', 'Could not look this word up.', 'tr'));
  });
}

function showGloss(word: string, translation: string, pos?: string): void {
  const pending = pendingGloss.get(word);
  if (!pending) return;
  pendingGloss.delete(word);
  const video = watcher.video;

  overlay.showPopover(pending.anchor, (root) => {
    const heading = el('div');
    heading.append(el('b', word));
    if (pos) heading.append(el('span', pos, 'pos'));
    const button = document.createElement('button');
    button.textContent = 'Save';
    button.addEventListener('click', () => {
      button.disabled = true;
      button.textContent = 'Saved';
      const entry: SavedWord = {
        word,
        sentence: pending.sentence,
        translation,
        ...(pos ? { pos } : {}),
        url: location.href,
        videoTime: video?.currentTime ?? 0,
        savedAt: Date.now(),
      };
      void saveWord(entry);
    });
    root.append(heading, el('div', translation, 'tr'), button);
  });
}

function el(tag: string, text?: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

// -------------------------------------------------------------- shortcuts

/**
 * The manifest declares these as chrome.commands, which the service worker
 * relays here because commands do not reach content scripts directly. The
 * keydown chords below stay as a fallback: a relayed command cannot arrive if
 * the page has focus inside an iframe we are not in.
 */
const ACTIONS: Record<string, () => void> = {
  'toggle-captions': () => {
    ui = { ...ui, captionsOn: !ui.captionsOn };
    persist({ ui });
  },
  'toggle-translation': () => {
    config = { ...config, showTranslation: !config.showTranslation };
    persist({ config });
    send({ type: 'setConfig', config });
  },
  'toggle-immersion': () => {
    ui = { ...ui, immersion: !ui.immersion };
    persist({ ui });
  },
  'toggle-debug': () => {
    ui = { ...ui, debug: !ui.debug };
    persist({ ui });
  },
  'replay-line': () => {
    const video = watcher.video;
    const last = store.latest();
    if (video && last) video.currentTime = Math.max(0, last.videoStart - 0.15);
  },
};

const CHORDS: Record<string, string> = {
  KeyC: 'toggle-captions',
  KeyT: 'toggle-translation',
  KeyI: 'toggle-immersion',
  KeyR: 'replay-line',
  KeyD: 'toggle-debug',
};

function onKeyDown(event: KeyboardEvent): void {
  if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
  const name = CHORDS[event.code];
  const action = name ? ACTIONS[name] : undefined;
  if (!action) return;
  event.preventDefault();
  action();
}

/** Relayed from the service worker; not a /shared message, it never leaves this pair. */
function isCommand(m: unknown): m is { type: 'command'; command: string } {
  return typeof m === 'object' && m !== null && (m as { type?: string }).type === 'command';
}

/** Offscreen -> overlay, twice a second while capturing. Internal to the panel. */
function isDebugStats(m: unknown): m is { type: 'debugStats'; snapshot: DebugSnapshot } {
  return typeof m === 'object' && m !== null && (m as { type?: string }).type === 'debugStats';
}

function applyConfig(next: Config): void {
  if (next.srcLang !== config.srcLang || next.tgtLang !== config.tgtLang) store.clear();
  config = next;
}

function applyDebugVisibility(): void {
  if (ui.debug) debugPanel.show();
  else debugPanel.hide();
}

/**
 * Retires this instance: stops the timers, drops the overlay and unhooks the
 * observers. Called when the extension goes away under us, and on pagehide.
 * Idempotent — several paths can notice the context is gone at once.
 */
function teardown(): void {
  if (torndown) return;
  torndown = true;
  if (heartbeat !== null) clearInterval(heartbeat);
  heartbeat = null;
  cancelAnimationFrame(frame);
  watcher.stop();
  overlay.unmount();
}

// ------------------------------------------------------------------- boot

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'clearCaptions') {
    store.clear();
    arrived.clear();
    overlay.closePopover();
    return;
  }
  if (isCaption(message)) {
    const caption: Caption = message;
    arrived.set(caption.id, performance.now());
    store.upsert(caption);
    return;
  }
  if (isGlossResponse(message)) {
    showGloss(message.word, message.translation, message.pos);
    return;
  }
  if (isDebugStats(message)) {
    debugPanel.update(message.snapshot);
    return;
  }
  if (isCommand(message)) {
    ACTIONS[message.command]?.();
    return;
  }
  if (isSetConfig(message)) {
    applyConfig(message.config);
    sendSync();
  }
});

document.addEventListener('keydown', onKeyDown, true);
// A click anywhere but the popover dismisses it.
document.addEventListener('click', () => overlay.closePopover(), true);
document.addEventListener('fullscreenchange', () => overlay.reparent());

void chrome.storage.local
  .get(['config', 'ui'])
  .then((stored) => {
    config = { ...DEFAULT_CONFIG, ...((stored['config'] as Partial<Config> | undefined) ?? {}) };
    ui = { ...ui, ...((stored['ui'] as Partial<UiState> | undefined) ?? {}) };
    applyDebugVisibility();
  })
  .catch(() => teardown());
chrome.storage.onChanged.addListener((changes) => {
  if (changes['config']?.newValue) applyConfig({ ...config, ...changes['config'].newValue });
  if (changes['ui']?.newValue) {
    ui = { ...ui, ...(changes['ui'].newValue as Partial<UiState>) };
    applyDebugVisibility();
  }
});

/**
 * A previous instance's overlay may still be in the DOM: reloading the
 * extension orphans its content scripts without unloading the page, and the
 * service worker then injects a fresh one. Two overlays would fight over the
 * same screen, so the old one goes first.
 */
for (const stale of document.querySelectorAll('[data-subtle="overlay"]')) {
  if (stale !== overlay.host) stale.remove();
}

overlay.mount();
watcher.start();
heartbeat = setInterval(sendSync, HEARTBEAT_MS);
frame = requestAnimationFrame(tick);

window.addEventListener('pagehide', teardown);

console.log('[subtle] content ok', location.host);
