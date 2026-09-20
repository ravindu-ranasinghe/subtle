/**
 * Downmixes the captured tab audio to mono, resamples it to 16 kHz and posts
 * it back in 100 ms frames stamped on the AudioContext clock.
 *
 * Runs on the audio thread. The only per-block allocation is the frame buffer
 * handed to postMessage, which has to be fresh because it is transferred.
 *
 * Built as a classic script; load it with
 * `ctx.audioWorklet.addModule(chrome.runtime.getURL('worklets/resampler.js'))`.
 */

import { Chunker, PROCESSOR_NAME, Resampler, TARGET_RATE } from './dsp.js';

declare const registerProcessor: (name: string, ctor: typeof AudioWorkletProcessor) => void;
/** Sample rate of the AudioContext this worklet is running in. */
declare const sampleRate: number;
/** AudioContext time at the start of the current render quantum. */
declare const currentTime: number;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}

class ResamplerProcessor extends AudioWorkletProcessor {
  private readonly chunker = new Chunker();
  private resampler: Resampler | null = null;
  private mono = new Float32Array(0);
  private out = new Float32Array(0);
  private started = false;
  private running = true;

  private readonly emit = (frame: Float32Array, audioStart: number): void => {
    this.port.postMessage({ type: 'audioChunk', samples: frame, audioStart }, [frame.buffer]);
  };

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent) => {
      if ((e.data as { type?: string })?.type === 'stop') this.running = false;
    };
    this.port.postMessage({ type: 'ready', sampleRate, targetRate: TARGET_RATE });
  }

  process(inputs: Float32Array[][]): boolean {
    if (!this.running) return false;
    const input = inputs[0] ?? [];
    // A disconnected or silent input still has to advance the clock, or every
    // timestamp after it is early by however long the gap lasted.
    const frames = input[0]?.length ?? 128;
    if (frames === 0) return true;

    if (!this.started) {
      this.chunker.start(currentTime);
      this.resampler = new Resampler(sampleRate, TARGET_RATE);
      this.started = true;
    }
    const resampler = this.resampler!;

    if (this.mono.length < frames) this.mono = new Float32Array(frames);
    const mono = this.mono.subarray(0, frames);
    mono.fill(0);
    for (const channel of input) {
      for (let i = 0; i < frames; i++) mono[i]! += channel[i]!;
    }
    if (input.length > 1) {
      for (let i = 0; i < frames; i++) mono[i]! /= input.length;
    }

    const capacity = resampler.maxOutput(frames);
    if (this.out.length < capacity) this.out = new Float32Array(capacity);
    const written = resampler.process(mono, this.out);
    if (written > 0) this.chunker.push(this.out.subarray(0, written), this.emit);

    return true;
  }
}

registerProcessor(PROCESSOR_NAME, ResamplerProcessor);
