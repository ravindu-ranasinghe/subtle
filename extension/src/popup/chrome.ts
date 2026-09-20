/**
 * Everything the popup needs from the extension APIs, in one place so the
 * components stay declarative.
 */

import { DEFAULT_CONFIG, type Config, type WhisperSize } from '@subtle/shared';
import { listWords, removeWord, type SavedWord } from '../content/saved.js';

export { listWords, removeWord };
export type { SavedWord };

/**
 * Duplicated from workers/asr/whisper.ts on purpose: importing it would pull
 * Transformers.js (2 MB) into the popup bundle for three numbers. Measured
 * q8 download sizes — keep in step with MODEL_MB there.
 */
export const MODEL_SIZES: Record<WhisperSize, number> = { tiny: 43, base: 77, small: 259 };

export const LANGUAGES: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'ru', label: 'Russian' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese' },
];

export async function currentTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

/** A's service worker keeps the capturing tab here. */
export async function capturingTabId(): Promise<number | null> {
  const stored = await chrome.storage.session.get('capture');
  return (stored['capture'] as { tabId: number } | undefined)?.tabId ?? null;
}

export async function loadConfig(): Promise<Config> {
  const stored = await chrome.storage.local.get('config');
  return { ...DEFAULT_CONFIG, ...((stored['config'] as Partial<Config> | undefined) ?? {}) };
}

export async function saveConfig(config: Config): Promise<void> {
  await chrome.storage.local.set({ config });
  // The offscreen document and content script both listen for this.
  await send({ type: 'setConfig', config });
}

/** Messages are best-effort: nothing is listening until capture starts. */
export async function send(message: unknown): Promise<void> {
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    // No receiver. Not an error worth showing.
  }
}

/**
 * Start or stop capture on a tab. `default_popup` suppresses
 * chrome.action.onClicked, so the popup owns the click; the click that opened
 * this popup is the activeTab grant the service worker spends on
 * getMediaStreamId.
 */
export async function toggleCapture(tabId: number): Promise<void> {
  const result = await chrome.runtime.sendMessage({ type: 'toggleCapture', tabId });
  if (result?.error) throw new Error(result.error);
}

export async function stopCapture(tabId: number): Promise<void> {
  await chrome.runtime.sendMessage({ type: 'stop', tabId });
}

export async function deleteModels(): Promise<void> {
  await send({ type: 'deleteModels' });
}

/** Hands the browser a file without a downloads permission or a server. */
export function downloadText(filename: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
