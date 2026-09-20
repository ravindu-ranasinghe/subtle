/** Supertonic 3, adapted for single-caption inference from the official MIT
 * browser example. Model: OpenRAIL-M. See extension/licenses/ for both notices.
 * https://github.com/supertone-oss-archive/supertonic/tree/main/web
 * Modified: flat tensors, cached downloads, bounded input, eight denoising steps.
 */
import * as ort from 'onnxruntime-web/webgpu';
import { supportsNeuralVoice } from '../../offscreen/dub/speech.js';

export const TTS_CACHE = 'subtle-neural-voice';
export const MODEL_URL = 'https://huggingface.co/supertone-oss-archive/supertonic-3/resolve/aafc6e32416a594460b32413efc49d7fe4ce6d46';

interface Settings {
  ae: { sample_rate: number; base_chunk_size: number };
  ttl: { chunk_compress_factor: number; latent_dim: number };
}
interface StyleData { data: number[][][]; dims: number[] }
interface Style { style_ttl: StyleData; style_dp: StyleData }

async function asset(path: string): Promise<Response> {
  const url = `${MODEL_URL}/${path}`;
  const cache = await caches.open(TTS_CACHE);
  const cached = await cache.match(url);
  if (cached) return cached;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Neural voice download failed (${response.status}).`);
  await cache.put(url, response.clone());
  return response;
}

/** Keep the model's normalization and language markers; unsupported symbols
 * must not become -1 embedding indices. Never put user text into model URLs. */
export function voiceText(text: string, lang: string): string {
  if (!supportsNeuralVoice(lang)) throw new Error(`Neural voice does not support ${lang}.`);
  let clean = text.normalize('NFKD')
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/gu, '')
    .replace(/[–‑—]/g, '-').replace(/[“”]/g, '"').replace(/[‘’´`]/g, "'")
    .replace(/[_\[\]|/#→←]/g, ' ').replace(/[♥☆♡©\\]/g, '')
    .replace(/\s+([,.!?;:'])/g, '$1').replace(/(["'])\1+/g, '$1')
    .replace(/\s+/g, ' ').trim();
  if (!/[.!?;:,'")\]}…。」』】〉》›»]$/.test(clean)) clean += '.';
  const base = lang.toLowerCase().split('-')[0]!;
  return `<${base}>${clean}</${base}>`;
}

export class NeuralVoiceEngine {
  private constructor(
    private readonly models: ort.InferenceSession[],
    private readonly settings: Settings,
    private readonly indexer: number[],
    private readonly ttl: ort.Tensor,
    private readonly dp: ort.Tensor,
    readonly backend: 'webgpu' | 'wasm',
  ) {}

  static async create(status: (text: string) => void): Promise<NeuralVoiceEngine> {
    ort.env.wasm.wasmPaths = new URL('/wasm/', self.location.href).href;
    ort.env.wasm.numThreads = 1;
    const settings = await (await asset('onnx/tts.json')).json() as Settings;
    const indexer = await (await asset('onnx/unicode_indexer.json')).json() as number[];
    const style = await (await asset('voice_styles/F1.json')).json() as Style;
    const tensor = (value: StyleData): ort.Tensor => new ort.Tensor('float32', Float32Array.from(value.data.flat(2)), value.dims);
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    let backend: 'webgpu' | 'wasm' = await gpu?.requestAdapter().catch(() => null) ? 'webgpu' : 'wasm';
    const models: ort.InferenceSession[] = [];
    const files = ['duration_predictor', 'text_encoder', 'vector_estimator', 'vocoder'];
    try {
      for (const [i, file] of files.entries()) {
        status(`Loading neural voice ${i + 1}/4… First download is about 400 MB.`);
        const bytes = await (await asset(`onnx/${file}.onnx`)).arrayBuffer();
        try {
          models.push(await ort.InferenceSession.create(bytes, { executionProviders: [backend] }));
        } catch (error) {
          if (backend === 'wasm') throw error;
          // Keep CPU-only platforms usable without remote speech processing.
          models.push(await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] }));
          backend = 'wasm';
        }
      }
      const voice = new NeuralVoiceEngine(models, settings, indexer, tensor(style.style_ttl), tensor(style.style_dp), backend);
      status('Preparing neural voice…');
      await voice.synthesize('Hello.', 'en', 2);
      return voice;
    } catch (error) {
      await Promise.allSettled(models.map((model) => model.release()));
      throw error;
    }
  }

  async synthesize(text: string, lang: string, budget: number): Promise<{ samples: Float32Array; sampleRate: number }> {
    // Captions are only 2.5 s long. Reject malformed/oversized requests rather
    // than allocating an unbounded latent tensor or silently truncating words.
    if (!text.trim() || text.length > 400) throw new Error('Neural voice needs a caption of 1–400 characters.');
    const normalized = voiceText(text, lang);
    const ids = Array.from(normalized, (char) => this.indexer[char.codePointAt(0)!] ?? -1);
    const known = ids.filter((id) => id >= 0);
    const textIds = new ort.Tensor('int64', BigInt64Array.from(known, BigInt), [1, known.length]);
    const textMask = new ort.Tensor('float32', new Float32Array(known.length).fill(1), [1, 1, known.length]);
    const [durationModel, encoder, estimator, vocoder] = this.models as [ort.InferenceSession, ort.InferenceSession, ort.InferenceSession, ort.InferenceSession];
    const durationOut = await durationModel.run({ text_ids: textIds, style_dp: this.dp, text_mask: textMask });
    const natural = Number(durationOut['duration']!.data[0]);
    if (!Number.isFinite(natural) || natural <= 0 || natural > 25) throw new Error('Invalid neural speech duration.');
    // Speed is changed inside the model, preserving pitch. Never rush past
    // 1.15x; the player finishes a phrase before starting the next one.
    const speed = budget > 0 ? Math.max(1, Math.min(1.15, natural / budget)) : 1;
    const duration = natural / speed;
    const encoded = await encoder.run({ text_ids: textIds, style_ttl: this.ttl, text_mask: textMask });
    const { ae, ttl } = this.settings;
    const length = Math.ceil(Math.floor(duration * ae.sample_rate) / (ae.base_chunk_size * ttl.chunk_compress_factor));
    const dims = [1, ttl.latent_dim * ttl.chunk_compress_factor, length];
    const noise = Float32Array.from({ length: dims[1]! * length }, () =>
      Math.sqrt(-2 * Math.log(Math.max(0.0001, Math.random()))) * Math.cos(2 * Math.PI * Math.random()));
    let latent: ort.Tensor = new ort.Tensor('float32', noise, dims);
    const mask = new ort.Tensor('float32', new Float32Array(length).fill(1), [1, 1, length]);
    const steps = new ort.Tensor('float32', new Float32Array([8]), [1]);
    for (let step = 0; step < 8; step++) {
      const result = await estimator.run({
        noisy_latent: latent, text_emb: encoded['text_emb']!, style_ttl: this.ttl,
        latent_mask: mask, text_mask: textMask,
        current_step: new ort.Tensor('float32', new Float32Array([step]), [1]), total_step: steps,
      });
      latent = result['denoised_latent']!;
    }
    const output = await vocoder.run({ latent });
    const samples = (output['wav_tts']!.data as Float32Array).slice(0, Math.floor(duration * ae.sample_rate));
    return { samples, sampleRate: ae.sample_rate };
  }
}
