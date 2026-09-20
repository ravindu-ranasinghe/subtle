/**
 * The translation layer the rest of the extension talks to.
 *
 * Picks a backend per language pair, caches results, carries the last few
 * final captions as context, and reports timing. Implements the Translator
 * contract, so a MockTranslator can stand in for the whole thing.
 */

import type { Gloss, MetricsMsg, Translator } from '@subtle/shared';
import { MAX_CONTEXT } from '../../workers/mt/text.js';
import {
  ChromeTranslator,
  LanguagePackRequiredError,
  chromeTranslatorSupported,
  downloadLanguagePack,
} from './chrome-translator.js';
import { LocalMTTranslator } from './local-translator.js';

export { LanguagePackRequiredError, downloadLanguagePack, chromeTranslatorSupported };
export { ChromeTranslator } from './chrome-translator.js';
export { LocalMTTranslator } from './local-translator.js';

/** Translations held before the oldest is dropped. ~2 hours of captions. */
const CACHE_LIMIT = 500;

export interface TranslationServiceOptions {
  /** Defaults to the real Chrome API wrapper; tests pass their own. */
  chrome?: Translator | null;
  /** Defaults to nothing: pass a LocalMTTranslator, or a mock. */
  local?: Translator | null;
  onMetrics?: (m: Omit<MetricsMsg, 'type'>) => void;
  /**
   * Called when a language pair needs a pack Chrome will only download from a
   * user gesture. The popup turns this into a button.
   */
  onLanguagePackRequired?: (src: string, tgt: string) => void;
}

export class TranslationService implements Translator {
  readonly name = 'subtle';

  private readonly chrome: Translator | null;
  private readonly local: Translator | null;
  private readonly options: TranslationServiceOptions;

  /** Chosen backend per `src|tgt`, so availability is not re-checked per line. */
  private readonly chosen = new Map<string, Translator>();
  private readonly cache = new Map<string, string>();
  /** The last few source texts, used when the caller passes no context. */
  private history: string[] = [];
  private generation = 0;
  private activeName: string | null = null;

  constructor(options: TranslationServiceOptions = {}) {
    this.options = options;
    this.chrome =
      options.chrome === undefined ? (chromeTranslatorSupported() ? new ChromeTranslator() : null) : options.chrome;
    this.local = options.local ?? null;
  }

  /** Name of the backend serving the most recent call. Null before the first. */
  get active(): string | null {
    return this.activeName;
  }

  /** Load the selected pair and compile its kernels before its first caption. */
  async prepare(src: string, tgt: string): Promise<void> {
    if (src !== 'auto' && src !== tgt) await this.translate('.', [], src, tgt, false);
  }

  /**
   * 'yes' when anything can serve the pair right now, 'download' when
   * something could after fetching weights, 'no' when nothing can.
   */
  async available(src: string, tgt: string): Promise<'yes' | 'download' | 'no'> {
    const results = await Promise.all(
      [this.chrome, this.local].filter((t): t is Translator => t !== null).map((t) => t.available(src, tgt)),
    );
    if (results.includes('yes')) return 'yes';
    if (results.includes('download')) return 'download';
    return 'no';
  }

  /**
   * Translate bounded, finished caption chunks, with recent source context.
   *
   * When `context` is empty the last {@link MAX_CONTEXT} texts passed through
   * here are used instead.
   */
  async translate(text: string, context: string[], src: string, tgt: string, remember = true): Promise<string> {
    const trimmed = text.trim();
    if (!trimmed) return '';
    if (src === tgt) return trimmed;

    const key = `${src}|${tgt}|${trimmed}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      if (remember) this.remember(trimmed);
      return hit;
    }

    const version = this.generation;
    const translator = await this.pick(src, tgt);
    // A preview must not add provisional text to the next line's context or
    // translate a whole history just to show the first few words.
    const effective = remember ? (context.length > 0 ? context : this.history) : [];
    const started = performance.now();
    try {
      const result = await translator.translate(trimmed, effective.slice(-MAX_CONTEXT), src, tgt);
      this.options.onMetrics?.({ stage: 'translate', ms: performance.now() - started });
      this.store(key, result);
      if (remember && version === this.generation) this.remember(trimmed);
      return result;
    } catch (err) {
      return this.recover(err, src, tgt, translator, () =>
        this.translate(trimmed, context, src, tgt, remember),
      );
    }
  }

  async gloss(word: string, sentence: string, src: string, tgt: string): Promise<Gloss> {
    const translator = await this.pick(src, tgt);
    const started = performance.now();
    try {
      const result = await translator.gloss(word, sentence, src, tgt);
      this.options.onMetrics?.({ stage: 'translate', ms: performance.now() - started });
      return result;
    } catch (err) {
      return this.recover(err, src, tgt, translator, () => this.gloss(word, sentence, src, tgt));
    }
  }

  /** Forget the rolling context. Call on a seek or when capture restarts. */
  resetContext(): void {
    this.history = [];
    this.generation++;
    this.chosen.clear();
  }

  // ------------------------------------------------------------- internals

  /**
   * Chrome's translator when it can serve the pair without downloading
   * anything, the local models otherwise. Chrome is smaller, faster and
   * already on disk; the local path exists for the pairs Chrome will not do.
   */
  private async pick(src: string, tgt: string): Promise<Translator> {
    const key = `${src}|${tgt}`;
    const already = this.chosen.get(key);
    if (already) {
      this.activeName = already.name;
      return already;
    }

    const availability = await this.chrome?.available(src, tgt);
    if (availability === 'download') this.options.onLanguagePackRequired?.(src, tgt);
    if (this.chrome && availability === 'yes') {
      this.chosen.set(key, this.chrome);
      this.activeName = this.chrome.name;
      return this.chrome;
    }
    if (this.local) {
      this.chosen.set(key, this.local);
      this.activeName = this.local.name;
      return this.local;
    }
    if (this.chrome) {
      // Nothing else to fall back to: let Chrome try and surface whatever it
      // says, including the gesture requirement.
      this.chosen.set(key, this.chrome);
      this.activeName = this.chrome.name;
      return this.chrome;
    }
    throw new Error(`no translator available for ${src} to ${tgt}`);
  }

  /**
   * A pack that needs a click is not a dead end while local models exist:
   * report it so the popup can offer the download, then retry on the fallback.
   */
  private async recover<T>(
    err: unknown,
    src: string,
    tgt: string,
    failed: Translator,
    retry: () => Promise<T>,
  ): Promise<T> {
    if (!(err instanceof LanguagePackRequiredError)) throw err;
    this.options.onLanguagePackRequired?.(src, tgt);
    if (!this.local || failed === this.local) throw err;
    this.chosen.set(`${src}|${tgt}`, this.local);
    return retry();
  }

  private store(key: string, value: string): void {
    this.cache.set(key, value);
    if (this.cache.size > CACHE_LIMIT) {
      // Map iterates in insertion order, so the first key is the oldest.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  private remember(text: string): void {
    this.history.push(text);
    if (this.history.length > MAX_CONTEXT) this.history.shift();
  }
}
