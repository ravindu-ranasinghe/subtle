/**
 * Local MT over Transformers.js: opus-mt for the pairs it covers, NLLB-200
 * distilled for everything else.
 *
 * Model choice is by attempt, not by table: build the opus-mt id, try to load
 * it, fall back to NLLB when it is not there. A hardcoded list of pairs would
 * be wrong the moment someone publishes another one.
 */

import { env, pipeline, type ProgressCallback } from '@huggingface/transformers';
import { CONTEXT_SEPARATOR, glossDifference, prependContext, removeWord, stripContext } from './text.js';

export type Backend = 'webgpu' | 'wasm' | 'cpu';

export const NLLB_MODEL = 'Xenova/nllb-200-distilled-600M';

/**
 * opus-mt names a few targets oddly — Japanese is `jap`, not `ja`. Checked
 * against the live repos; `Xenova/opus-mt-en-ja` does not exist,
 * `opus-mt-en-jap` does.
 */
const OPUS_ALIASES: Record<string, string> = { ja: 'jap' };

/** BCP-47 to NLLB's FLORES-200 codes. NLLB rejects anything else. */
const NLLB_CODES: Record<string, string> = {
  ar: 'arb_Arab', de: 'deu_Latn', en: 'eng_Latn', es: 'spa_Latn', fa: 'pes_Arab',
  fr: 'fra_Latn', he: 'heb_Hebr', hi: 'hin_Deva', id: 'ind_Latn', it: 'ita_Latn',
  ja: 'jpn_Jpan', ko: 'kor_Hang', nl: 'nld_Latn', pl: 'pol_Latn', pt: 'por_Latn',
  ru: 'rus_Cyrl', sv: 'swe_Latn', th: 'tha_Thai', tr: 'tur_Latn', uk: 'ukr_Cyrl',
  vi: 'vie_Latn', zh: 'zho_Hans',
};

export function nllbCode(lang: string): string | null {
  return NLLB_CODES[lang.toLowerCase().split('-')[0]!] ?? null;
}

export function opusModelId(src: string, tgt: string): string {
  const s = OPUS_ALIASES[src] ?? src;
  const t = OPUS_ALIASES[tgt] ?? tgt;
  return `Xenova/opus-mt-${s}-${t}`;
}

type TranslationPipeline = (
  text: string,
  options: Record<string, unknown>,
) => Promise<{ translation_text: string }[]>;

interface Loaded {
  run: TranslationPipeline;
  model: string;
  /** NLLB needs explicit source and target codes on every call. */
  nllb: boolean;
}

export interface EngineOptions {
  device?: Backend;
  wasmPaths?: string;
  onProgress?: ProgressCallback;
}

/**
 * One loaded pipeline per language pair, kept until the worker dies. Two pairs
 * at once is the realistic ceiling (captions plus glossing the other way).
 */
export class LocalEngine {
  private readonly pairs = new Map<string, Promise<Loaded>>();
  private readonly options: EngineOptions;
  private resolvedBackend: Backend;

  constructor(options: EngineOptions = {}) {
    this.options = options;
    this.resolvedBackend = options.device ?? 'wasm';
  }

  get backend(): Backend {
    return this.resolvedBackend;
  }

  private readonly loadedNames = new Map<string, string>();

  /** Which model ended up serving a pair. Null until it has loaded. */
  modelFor(src: string, tgt: string): string | null {
    return this.loadedNames.get(`${src}|${tgt}`) ?? null;
  }

  async available(src: string, tgt: string): Promise<'yes' | 'download' | 'no'> {
    if (src === tgt) return 'no';
    // NLLB covers the pair or nothing does; opus-mt is only ever an upgrade.
    if (!nllbCode(src) || !nllbCode(tgt)) return 'no';
    return this.pairs.has(`${src}|${tgt}`) ? 'yes' : 'download';
  }

  async translate(text: string, context: string[], src: string, tgt: string): Promise<string> {
    if (!text.trim()) return '';
    const engine = await this.load(src, tgt);

    const contextCount = Math.min(context.filter((c) => c.trim()).length, 3);
    if (contextCount > 0) {
      const combined = prependContext(text, context);
      const raw = await this.run(engine, combined, src, tgt);
      const stripped = stripContext(raw, contextCount);
      if (stripped.trusted) return stripped.text;
      // The model merged or dropped a sentence; the tail is not reliably the
      // one we asked about, so pay for a second pass without context.
    }
    return stripContext(await this.run(engine, text, src, tgt), 0).text;
  }

  /**
   * Translates the word using its sentence for sense, by taking the
   * difference between the sentence with and without it. Falls back to the
   * word on its own when the difference is unusable.
   */
  async gloss(word: string, sentence: string, src: string, tgt: string): Promise<string> {
    const engine = await this.load(src, tgt);
    const trimmed = sentence.trim();
    if (trimmed && trimmed.toLowerCase() !== word.trim().toLowerCase()) {
      const without = removeWord(trimmed, word);
      if (without && without !== trimmed) {
        const [full, minus] = await Promise.all([
          this.run(engine, trimmed, src, tgt),
          this.run(engine, without, src, tgt),
        ]);
        const diff = glossDifference(full, minus);
        if (diff) return diff;
      }
    }
    return (await this.run(engine, word, src, tgt)).replace(/[.!?。！？]+$/, '').trim();
  }

  private async run(engine: Loaded, text: string, src: string, tgt: string): Promise<string> {
    const options: Record<string, unknown> = { max_new_tokens: 256 };
    if (engine.nllb) {
      options['src_lang'] = nllbCode(src);
      options['tgt_lang'] = nllbCode(tgt);
    }
    // One string at a time: batching opus-mt produces runaway trailing dots
    // ("I went to the market yesterday.......................").
    const result = await engine.run(text, options);
    return result[0]?.translation_text?.trim() ?? '';
  }

  private load(src: string, tgt: string): Promise<Loaded> {
    const key = `${src}|${tgt}`;
    let pending = this.pairs.get(key);
    if (!pending) {
      pending = this.build(src, tgt, key);
      this.pairs.set(key, pending);
      // A failed load must not be cached as a permanent failure.
      pending.catch(() => this.pairs.delete(key));
    }
    return pending;
  }

  private async build(src: string, tgt: string, key: string): Promise<Loaded> {
    if (this.options.wasmPaths) env.backends.onnx.wasm!.wasmPaths = this.options.wasmPaths;
    const device = this.options.device ?? (await pickBackend());
    this.resolvedBackend = device;

    const make = async (model: string): Promise<TranslationPipeline> => {
      const build = pipeline as unknown as (
        task: 'translation',
        model: string,
        options: Record<string, unknown>,
      ) => Promise<TranslationPipeline>;
      return build('translation', model, {
        device,
        dtype: 'q8',
        ...(this.options.onProgress ? { progress_callback: this.options.onProgress } : {}),
      });
    };

    const opus = opusModelId(src, tgt);
    try {
      const run = await make(opus);
      this.loadedNames.set(key, opus);
      return { run, model: opus, nllb: false };
    } catch {
      // No such pair on the hub — every pair opus-mt lacks falls here.
    }

    if (!nllbCode(src) || !nllbCode(tgt)) {
      throw new Error(`no translation model for ${src} to ${tgt}`);
    }
    const run = await make(NLLB_MODEL);
    this.loadedNames.set(key, NLLB_MODEL);
    return { run, model: NLLB_MODEL, nllb: true };
  }
}

/** WebGPU when an adapter answers, WASM otherwise. */
export async function pickBackend(): Promise<Backend> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return 'wasm';
  try {
    return (await gpu.requestAdapter()) ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

export { CONTEXT_SEPARATOR };
