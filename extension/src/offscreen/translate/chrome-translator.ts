/**
 * Chrome's built-in Translator API.
 *
 * Verified in Chrome 153 (SPIKES.md section C):
 *   window                → Translator: function, LanguageDetector: function
 *   dedicated Worker      → both undefined
 *
 * That is why this file lives on the offscreen document's main thread and the
 * Transformers.js fallback lives in a worker: only one of them can run in
 * each place.
 */

import type { Gloss, Translator as TranslatorContract } from '@subtle/shared';

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

interface DownloadMonitor {
  addEventListener(type: 'downloadprogress', fn: (e: { loaded: number; total?: number }) => void): void;
}

interface TranslatorInstance {
  translate(text: string): Promise<string>;
  destroy?(): void;
}

interface TranslatorFactory {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<Availability>;
  create(options: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (m: DownloadMonitor) => void;
    signal?: AbortSignal;
  }): Promise<TranslatorInstance>;
}

interface DetectorInstance {
  detect(text: string): Promise<{ detectedLanguage: string; confidence: number }[]>;
  destroy?(): void;
}

interface DetectorFactory {
  availability(): Promise<Availability>;
  create(): Promise<DetectorInstance>;
}

const factory = (): TranslatorFactory | undefined =>
  (self as unknown as { Translator?: TranslatorFactory }).Translator;

const detectorFactory = (): DetectorFactory | undefined =>
  (self as unknown as { LanguageDetector?: DetectorFactory }).LanguageDetector;

/** True in a window or offscreen document, false in a worker. */
export function chromeTranslatorSupported(): boolean {
  return factory() !== undefined;
}

/**
 * Thrown when a language pack has to be downloaded and nothing has a user
 * gesture to spend. Chrome's own message:
 *
 *   NotAllowedError: Requires a user gesture when availability is
 *   "downloading" or "downloadable".
 *
 * An offscreen document can never have a gesture — it is not a page the user
 * can click. So the download has to be started from the popup instead; see
 * {@link downloadLanguagePack} and CONTRACT_CHANGE_REQUEST.md C-1.
 */
export class LanguagePackRequiredError extends Error {
  constructor(
    readonly src: string,
    readonly tgt: string,
  ) {
    super(`Chrome needs to download a ${src} to ${tgt} language pack, which requires a click.`);
    this.name = 'LanguagePackRequiredError';
  }
}

function isGestureError(err: unknown): boolean {
  return err instanceof Error && err.name === 'NotAllowedError';
}

/**
 * Downloads a language pack. **Must be called from a user gesture** — a click
 * handler in the popup, not from the offscreen document.
 *
 * Packs are stored per browser profile, so once this resolves every context
 * sees `availability: 'available'` and can create translators without a
 * gesture of its own.
 */
export async function downloadLanguagePack(
  src: string,
  tgt: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  const api = factory();
  if (!api) throw new Error('Translator API is not available in this context');
  const instance = await api.create({
    sourceLanguage: src,
    targetLanguage: tgt,
    monitor: (m) => {
      m.addEventListener('downloadprogress', (e) => onProgress?.(e.loaded, e.total ?? 1));
    },
  });
  instance.destroy?.();
}

export class ChromeTranslator implements TranslatorContract {
  readonly name = 'chrome-translator';
  private readonly instances = new Map<string, Promise<TranslatorInstance>>();
  private detector: Promise<DetectorInstance> | null = null;

  async available(src: string, tgt: string): Promise<'yes' | 'download' | 'no'> {
    const api = factory();
    if (!api || src === tgt) return 'no';
    try {
      const state = await api.availability({ sourceLanguage: src, targetLanguage: tgt });
      if (state === 'available') return 'yes';
      if (state === 'downloadable' || state === 'downloading') return 'download';
      return 'no';
    } catch {
      return 'no';
    }
  }

  /** `context` is ignored: the API takes a string and nothing else. */
  async translate(text: string, _context: string[], src: string, tgt: string): Promise<string> {
    if (!text.trim()) return '';
    const instance = await this.instanceFor(src, tgt);
    return (await instance.translate(text)).trim();
  }

  /**
   * The API has no word-sense handle, so the sentence cannot steer it. The
   * local engine does better here (see engine.ts); this is the plain reading.
   */
  async gloss(word: string, _sentence: string, src: string, tgt: string): Promise<Gloss> {
    const instance = await this.instanceFor(src, tgt);
    const translation = (await instance.translate(word)).replace(/[.!?。！？]+$/, '').trim();
    // No backend here exposes part of speech; see SPIKES.md C.5.
    return { word, translation };
  }

  /**
   * Chrome's own language detector, for when srcLang is 'auto' and Whisper
   * did not report one. Measured confidence on single caption lines: es 1.000,
   * ja 0.997, de 1.000.
   */
  async detectLanguage(text: string, minConfidence = 0.5): Promise<string | null> {
    const api = detectorFactory();
    if (!api) return null;
    try {
      this.detector ??= api.create();
      const results = await (await this.detector).detect(text);
      const best = results.find((r) => r.detectedLanguage !== 'und');
      return best && best.confidence >= minConfidence ? best.detectedLanguage : null;
    } catch {
      return null;
    }
  }

  destroy(): void {
    for (const pending of this.instances.values()) {
      void pending.then((i) => i.destroy?.()).catch(() => {});
    }
    this.instances.clear();
    void this.detector?.then((d) => d.destroy?.()).catch(() => {});
    this.detector = null;
  }

  private instanceFor(src: string, tgt: string): Promise<TranslatorInstance> {
    const key = `${src}|${tgt}`;
    let pending = this.instances.get(key);
    if (!pending) {
      const api = factory();
      if (!api) return Promise.reject(new Error('Translator API is not available in this context'));
      pending = api.create({ sourceLanguage: src, targetLanguage: tgt }).catch((err: unknown) => {
        this.instances.delete(key);
        throw isGestureError(err) ? new LanguagePackRequiredError(src, tgt) : err;
      });
      this.instances.set(key, pending);
    }
    return pending;
  }
}
