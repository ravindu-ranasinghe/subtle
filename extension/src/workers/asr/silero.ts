/**
 * Silero VAD v5, loaded through Transformers.js.
 *
 * Going through Transformers.js rather than importing onnxruntime-web
 * directly keeps one ORT instance and one weight cache in the worker, and
 * gets download progress for free. Verified to give identical scores to
 * running the .onnx by hand (92% of frames > 0.5 on the same clip, mean
 * 0.909 both ways).
 *
 * Graph, checked against the real file rather than assumed:
 *   inputs  input [1,512] f32 · state [2,1,128] f32 · sr int64 scalar
 *   outputs output [1,1] f32 · stateN [2,1,128] f32
 */

import { AutoModel, Tensor, type ProgressCallback } from '@huggingface/transformers';
import { VAD_FRAME, VAD_RATE, type SpeechProbe } from './vad.js';

export const SILERO_MODEL_ID = 'onnx-community/silero-vad';
const STATE_DIMS = [2, 1, 128];
const STATE_SIZE = 2 * 1 * 128;

type VadModel = (inputs: {
  input: Tensor;
  sr: Tensor;
  state: Tensor;
}) => Promise<{ output: Tensor; stateN: Tensor }>;

export class SileroProbe implements SpeechProbe {
  private model: VadModel | null = null;
  private state = new Tensor('float32', new Float32Array(STATE_SIZE), STATE_DIMS);
  private readonly sr = new Tensor('int64', new BigInt64Array([BigInt(VAD_RATE)]), []);

  async load(onProgress?: ProgressCallback): Promise<void> {
    if (this.model) return;
    this.model = (await AutoModel.from_pretrained(SILERO_MODEL_ID, {
      // Silero has no transformers architecture; this is the documented way
      // to load a bare ONNX graph. It logs "Unknown model class" and works.
      config: { model_type: 'custom' } as never,
      dtype: 'fp32',
      ...(onProgress ? { progress_callback: onProgress } : {}),
    })) as unknown as VadModel;
  }

  async score(frame: Float32Array): Promise<number> {
    const model = this.model;
    if (!model) throw new Error('SileroProbe: load() first');
    if (frame.length !== VAD_FRAME) {
      throw new Error(`SileroProbe: expected ${VAD_FRAME} samples, got ${frame.length}`);
    }
    // The segmenter reuses its buffer and ORT holds on to what it is given,
    // so hand over a copy.
    const input = new Tensor('float32', Float32Array.from(frame), [1, VAD_FRAME]);
    const out = await model({ input, sr: this.sr, state: this.state });
    this.state = out.stateN;
    return (out.output.data as Float32Array)[0]!;
  }

  /** Silero is recurrent: carrying state across a gap invents speech after it. */
  reset(): void {
    this.state = new Tensor('float32', new Float32Array(STATE_SIZE), STATE_DIMS);
  }
}
