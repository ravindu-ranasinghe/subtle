/**
 * Whisper via Transformers.js.
 *
 * Two things had to be worked out against the real library rather than
 * assumed (see SPIKES.md section B):
 *
 *  - Keep the existing `_timestamped` weights so installed models stay cached.
 *    Word alignment is disabled: captions use the capture clock, and the
 *    overlay's clickable words do not require per-word timestamps.
 *  - Transformers.js does not implement Whisper language detection at all
 *    (`// TODO: Implement language detection` — it silently defaults to
 *    English). {@link WhisperEngine.detectLanguage} does it by hand.
 *
 * `device` is a parameter rather than a constant so bench/ can drive this
 * exact code on Node's CPU backend.
 */

import {
  Tensor,
  env,
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
  type WhisperForConditionalGeneration,
  type ProgressCallback,
} from '@huggingface/transformers';
import type { WhisperSize, Word } from '@subtle/shared';

export type Backend = 'webgpu' | 'wasm' | 'cpu';

/** The `_timestamped` exports are the ones with cross-attention for word timings. */
export const MODEL_IDS: Record<WhisperSize, string> = {
  tiny: 'onnx-community/whisper-tiny_timestamped',
  base: 'onnx-community/whisper-base_timestamped',
  small: 'onnx-community/whisper-small_timestamped',
};

/**
 * Measured q8 download size in MB, for the popup's model picker. The WebGPU
 * path uses an fp32 encoder and a q4 decoder instead, so its totals differ —
 * unmeasured until the browser spike runs (SPIKES.md B).
 */
export const MODEL_MB: Record<WhisperSize, number> = { tiny: 43, base: 77, small: 259 };

/** Transformers.js's own Cache API bucket. */
const TRANSFORMERS_CACHE = 'transformers-cache';

export interface Transcription {
  text: string;
  words: Word[];
}

export interface WhisperOptions {
  size: WhisperSize;
  /** Omit to auto-select: WebGPU when the adapter is there, else WASM. */
  device?: Backend;
  /** Where the bundled ORT wasm lives. MV3 forbids fetching it. */
  wasmPaths?: string;
  onProgress?: ProgressCallback;
}

/** Minimal shape of the WebGPU bits used here — @webgpu/types is not a dependency. */
interface AdapterInfo {
  vendor?: string;
  architecture?: string;
  description?: string;
}
interface Adapter {
  info?: AdapterInfo;
  requestAdapterInfo?: () => Promise<AdapterInfo>;
}
interface Gpu {
  requestAdapter(): Promise<Adapter | null>;
}
const webgpu = (): Gpu | undefined => (navigator as Navigator & { gpu?: Gpu }).gpu;

/**
 * Weight precision per size and backend.
 *
 * An fp32 encoder is worth it on the small models — quantizing it costs
 * accuracy for little size — but `small`'s encoder is roughly 350 MB in fp32,
 * which overruns the ONNX Runtime wasm heap and fails with
 * `memory access out of bounds` partway through loading. See BUGS.md E-8.
 */
export function dtypeFor(size: WhisperSize, backend: Backend): Record<string, string> | string {
  if (backend !== 'webgpu') return 'q8';
  if (size === 'small') return { encoder_model: 'q8', decoder_model_merged: 'q4' };
  return { encoder_model: 'fp32', decoder_model_merged: 'q4' };
}

/** WebGPU when an adapter answers, WASM otherwise. */
export async function pickBackend(): Promise<Backend> {
  const gpu = webgpu();
  if (!gpu) return 'wasm';
  try {
    return (await gpu.requestAdapter()) ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

/** Name of the GPU actually in use, for the metrics table. Null off WebGPU. */
export async function gpuAdapterName(): Promise<string | null> {
  const gpu = webgpu();
  if (!gpu) return null;
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return null;
    // `info` on newer Chrome, `requestAdapterInfo()` on older.
    const info = adapter.info ?? (await adapter.requestAdapterInfo?.());
    const parts = [info?.vendor, info?.architecture, info?.description].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : 'webgpu';
  } catch {
    return null;
  }
}

/** Audio the pipeline hands to Whisper is always 16 kHz mono. */
const SAMPLE_RATE = 16000;

/**
 * Decode budget for `seconds` of audio.
 *
 * Whisper's own limit is 448 tokens, sized for a 30 s window. Applied to a
 * 0.5-2.5 s chunk that is not a limit at all: when the decoder falls into a
 * repetition loop it spends every one of those steps, and a single 4.2 s
 * generate() blocks the preview behind it (measured, RESULTS.md). 24 tokens
 * per second is roughly twice the fastest real speech in any of the supported
 * languages, so a true caption never reaches it and a loop is cut short.
 */
export function maxTokensFor(seconds: number): number {
  return Math.min(224, Math.max(24, Math.ceil(seconds * 24)));
}

export class WhisperEngine {
  readonly size: WhisperSize;
  readonly backend: Backend;
  private readonly asr: AutomaticSpeechRecognitionPipeline;
  private prepared: { samples: Float32Array; features: Tensor } | null = null;

  // Plain fields rather than constructor parameter properties: bench/ loads
  // this file under Node's strip-only type stripping, which rejects those.
  private constructor(size: WhisperSize, backend: Backend, asr: AutomaticSpeechRecognitionPipeline) {
    this.size = size;
    this.backend = backend;
    this.asr = asr;
  }

  static async create(options: WhisperOptions): Promise<WhisperEngine> {
    const backend = options.device ?? (await pickBackend());
    if (options.wasmPaths) env.backends.onnx.wasm!.wasmPaths = options.wasmPaths;

    const build = pipeline as unknown as (
      task: 'automatic-speech-recognition',
      model: string,
      options: Record<string, unknown>,
    ) => Promise<AutomaticSpeechRecognitionPipeline>;
    const asr = (await build('automatic-speech-recognition', MODEL_IDS[options.size], {
      device: backend,
      dtype: dtypeFor(options.size, backend),
      ...(options.onProgress ? { progress_callback: options.onProgress } : {}),
    })) as AutomaticSpeechRecognitionPipeline;

    const engine = new WhisperEngine(options.size, backend, asr);
    // Compile inference kernels during loading, before the first spoken word.
    await engine.transcribe(new Float32Array(8000), 'en', 0);
    return engine;
  }

  /**
   * One decoder step from `<|startoftranscript|>`, then argmax over the
   * language tokens — which is what Whisper's own detection does, and what
   * Transformers.js leaves unimplemented.
   *
   * Returns a two-letter code, or null if the logits are unreadable.
   */
  async detectLanguage(samples: Float32Array): Promise<string | null> {
    const model = this.asr.model as unknown as {
      generation_config: { decoder_start_token_id: number; lang_to_id?: Record<string, number> };
      (inputs: Record<string, unknown>): Promise<{ logits: { data: Float32Array; dims: number[] } }>;
    };
    const langToId = model.generation_config.lang_to_id;
    if (!langToId) return null;

    const inputs = { input_features: await this.features(samples) };
    const start = BigInt(model.generation_config.decoder_start_token_id);
    const out = await model({
      ...inputs,
      decoder_input_ids: new Tensor('int64', BigInt64Array.from([start]), [1, 1]),
    });

    const dims = out.logits.dims;
    const vocab = dims[dims.length - 1]!;
    const lastStep = (dims[1]! - 1) * vocab;
    let best: string | null = null;
    let bestScore = -Infinity;
    for (const [token, id] of Object.entries(langToId)) {
      const score = out.logits.data[lastStep + id];
      if (score !== undefined && score > bestScore) {
        bestScore = score;
        best = token;
      }
    }
    return best ? (/<\|([a-z]{2,3})\|>/.exec(best)?.[1] ?? null) : null;
  }

  /** Caption timing comes from the captured audio; the overlay does not use word alignment. */
  async transcribe(samples: Float32Array, lang: string, _offset: number): Promise<Transcription> {
    const features = await this.features(samples);
    const tokens = await (this.asr.model as WhisperForConditionalGeneration).generate({
      inputs: features,
      language: lang,
      task: 'transcribe',
      return_timestamps: false,
      max_new_tokens: maxTokensFor(samples.length / SAMPLE_RATE),
    } as Parameters<WhisperForConditionalGeneration['generate']>[0]) as Tensor;
    this.prepared = null;
    return { text: this.asr.tokenizer.batch_decode(tokens, { skip_special_tokens: true })[0]!.trim(), words: [] };
  }

  private async features(samples: Float32Array): Promise<Tensor> {
    if (this.prepared?.samples === samples) return this.prepared.features;
    const features = await liveFeatures(this.asr.processor.feature_extractor!, samples);
    this.prepared = { samples, features };
    return features;
  }

  async dispose(): Promise<void> {
    await this.asr.dispose();
  }
}

/** Whisper requires 3000 mel frames, but computing FFTs for 29 seconds of
 * zeros blocks live audio. Compute the real audio plus a silent FFT window,
 * then fill the remaining frames with the exact normalized silence value.
 * This keeps the model input unchanged, including its global dynamic range. */
export async function liveFeatures(
  processor: (samples: Float32Array, options?: { max_length: number }) => Promise<{ input_features: Tensor }>,
  samples: Float32Array,
): Promise<Tensor> {
  const max_length = Math.min(480_000, Math.ceil((samples.length + 400) / 160) * 160);
  const { input_features: short } = await processor(samples, { max_length });
  const frames = short.dims[2]!;
  if (frames === 3000) return short;
  const source = short.data as Float32Array;
  let peak = -Infinity;
  for (const value of source) peak = Math.max(peak, value);
  const data = new Float32Array(80 * 3000).fill(Math.max(-1.5, peak - 2));
  for (let mel = 0; mel < 80; mel++) data.set(source.subarray(mel * frames, (mel + 1) * frames), mel * 3000);
  return new Tensor('float32', data, [1, 80, 3000]);
}

/**
 * Drops every cached model weight. Returns the cache buckets that existed.
 * The next load re-downloads, so only call this from an explicit user action.
 */
export async function deleteCachedModels(extra: string[] = []): Promise<string[]> {
  const deleted: string[] = [];
  for (const name of [TRANSFORMERS_CACHE, ...extra]) {
    if (await caches.delete(name)) deleted.push(name);
  }
  return deleted;
}
