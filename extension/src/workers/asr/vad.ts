/**
 * Voice activity detection and utterance segmentation.
 *
 * Silero scores 32 ms frames; the segmenter turns that score stream into
 * speech chunks with hysteresis, padding and a hard length cap. The two are
 * separate so the segmenter can be tested against scripted probabilities
 * without loading a model.
 */

import type { AudioChunk } from '@subtle/shared';

/** Silero v5 takes exactly this many samples per call at 16 kHz. */
export const VAD_FRAME = 512;
export const VAD_RATE = 16000;
/** 32 ms. */
export const FRAME_SEC = VAD_FRAME / VAD_RATE;

/** Scores one 512-sample frame. Silero in production, a script in tests. */
export interface SpeechProbe {
  /** Probability in [0, 1] that the frame contains speech. */
  score(frame: Float32Array): Promise<number>;
  /** Clear recurrent state — call on a discontinuity, not between frames. */
  reset(): void;
}

export interface SpeechChunk {
  samples: Float32Array;
  audioStart: number;
  audioEnd: number;
  /** Mean speech probability over the chunk, for the hallucination filter. */
  meanProb: number;
  /** Utterance id. A long utterance is split into several chunks sharing it. */
  utterance: number;
  /** Position within the utterance. > 0 means this chunk overlaps the previous. */
  index: number;
  /** True for the last chunk of an utterance. */
  final: boolean;
  /** A growing snapshot; the finished chunk will reuse its index. */
  preview?: boolean;
}

export interface SegmenterOptions {
  /** Probability at which speech starts. */
  threshold?: number;
  /** Lower bar to stay in speech — hysteresis stops flapping mid-word. */
  exitThreshold?: number;
  /** Utterances shorter than this are noise, not speech. */
  minSpeechMs?: number;
  /** Silence this long ends an utterance. */
  minSilenceMs?: number;
  /** Context kept either side, so plosives and trailing vowels survive. */
  padMs?: number;
  /** Hard cap on a chunk; a longer utterance is split. */
  maxChunkSec?: number;
  /**
   * Emit growing snapshots at this interval; 0 disables previews. This is the
   * single largest term in caption latency — nothing downstream can start
   * before the first snapshot exists — so it is set just above the shortest
   * span Whisper transcribes usefully rather than at a round number.
   */
  previewSec?: number;
  /** How much a split chunk repeats of the one before, for text de-duplication. */
  overlapSec?: number;
  /** Chunks below this mean probability are dropped before they reach Whisper. */
  minMeanProb?: number;
  /** An audio gap larger than this resets the segmenter. */
  discontinuityMs?: number;
}

const DEFAULTS = {
  threshold: 0.5,
  exitThreshold: 0.35,
  minSpeechMs: 250,
  minSilenceMs: 400,
  padMs: 150,
  maxChunkSec: 2.5,
  previewSec: 0.48,
  overlapSec: 0.5,
  minMeanProb: 0.4,
  discontinuityMs: 50,
} satisfies Required<SegmenterOptions>;

/**
 * Turns a 16 kHz mono stream into speech chunks.
 *
 * All positions are absolute sample indices from the start of the stream;
 * `originTime` maps index 0 onto the AudioContext clock so chunk timestamps
 * stay on the contract's clock.
 */
export class SpeechSegmenter {
  private readonly o: Required<SegmenterOptions>;
  private readonly padSamples: number;
  private readonly minSpeechSamples: number;
  private readonly minSilenceSamples: number;
  private readonly maxChunkSamples: number;
  private readonly overlapSamples: number;

  private buf = new Float32Array(VAD_RATE * 12);
  private bufStart = 0;
  private bufLen = 0;
  private total = 0;
  private originTime = 0;
  private hasOrigin = false;

  private frameAt = 0;
  private inSpeech = false;
  private chunkStart = 0;
  private speechStart = 0;
  private lastVoiced = 0;
  private silenceRun = 0;
  private utterance = 0;
  private emittedInUtterance = 0;
  private previewAt = 0;
  private probs: { end: number; p: number }[] = [];

  constructor(
    private readonly probe: SpeechProbe,
    options: SegmenterOptions = {},
  ) {
    this.o = { ...DEFAULTS, ...options };
    const perMs = VAD_RATE / 1000;
    this.padSamples = Math.round(this.o.padMs * perMs);
    this.minSpeechSamples = Math.round(this.o.minSpeechMs * perMs);
    this.minSilenceSamples = Math.round(this.o.minSilenceMs * perMs);
    this.maxChunkSamples = Math.round(this.o.maxChunkSec * VAD_RATE);
    this.overlapSamples = Math.round(this.o.overlapSec * VAD_RATE);
    if (this.overlapSamples >= this.maxChunkSamples) {
      throw new Error('SpeechSegmenter: overlapSec must be shorter than maxChunkSec');
    }
  }

  /** Seconds of audio scored so far. */
  get processedSeconds(): number {
    return this.total / VAD_RATE;
  }

  async push(chunk: AudioChunk): Promise<SpeechChunk[]> {
    if (!this.hasOrigin) {
      this.originTime = chunk.audioStart;
      this.hasOrigin = true;
    } else {
      // Capture is contiguous by construction; a jump means a restart or a
      // dropped stretch, and carrying VAD state across it invents speech.
      const expected = this.time(this.total);
      if (Math.abs(chunk.audioStart - expected) * 1000 > this.o.discontinuityMs) {
        this.reset();
        this.originTime = chunk.audioStart;
        this.hasOrigin = true;
      }
    }

    this.append(chunk.samples);

    const out: SpeechChunk[] = [];
    while (this.frameAt + VAD_FRAME <= this.total) {
      const offset = this.frameAt - this.bufStart;
      const p = await this.probe.score(this.buf.subarray(offset, offset + VAD_FRAME));
      this.step(p, out);
      this.frameAt += VAD_FRAME;
    }
    this.trim();
    return out;
  }

  /** Closes an utterance still in progress. Call when capture stops. */
  async flush(): Promise<SpeechChunk[]> {
    const out: SpeechChunk[] = [];
    if (this.inSpeech) this.closeUtterance(out);
    return out;
  }

  reset(): void {
    this.probe.reset();
    this.bufStart = 0;
    this.bufLen = 0;
    this.total = 0;
    this.frameAt = 0;
    this.inSpeech = false;
    this.silenceRun = 0;
    this.emittedInUtterance = 0;
    this.previewAt = 0;
    this.probs = [];
    this.hasOrigin = false;
  }

  // ------------------------------------------------------------- internals

  private time(sample: number): number {
    return this.originTime + sample / VAD_RATE;
  }

  private append(samples: Float32Array): void {
    if (this.bufLen + samples.length > this.buf.length) {
      const grown = new Float32Array(Math.max(this.buf.length * 2, this.bufLen + samples.length));
      grown.set(this.buf.subarray(0, this.bufLen));
      this.buf = grown;
    }
    this.buf.set(samples, this.bufLen);
    this.bufLen += samples.length;
    this.total += samples.length;
  }

  /** Drop audio and scores nobody can reach any more. */
  private trim(): void {
    const needed = this.inSpeech ? this.chunkStart : this.frameAt - this.padSamples;
    const keepFrom = Math.max(0, Math.min(needed, this.frameAt));
    if (keepFrom > this.bufStart) {
      const drop = keepFrom - this.bufStart;
      this.buf.copyWithin(0, drop, this.bufLen);
      this.bufLen -= drop;
      this.bufStart = keepFrom;
    }
    const oldest = this.frameAt - (this.maxChunkSamples + this.padSamples);
    while (this.probs.length > 0 && this.probs[0]!.end <= oldest) this.probs.shift();
  }

  private step(p: number, out: SpeechChunk[]): void {
    const frameEnd = this.frameAt + VAD_FRAME;
    this.probs.push({ end: frameEnd, p });

    if (!this.inSpeech) {
      if (p < this.o.threshold) return;
      this.inSpeech = true;
      this.utterance++;
      this.emittedInUtterance = 0;
      this.previewAt = 0;
      this.speechStart = Math.max(this.bufStart, this.frameAt - this.padSamples);
      this.chunkStart = this.speechStart;
      this.lastVoiced = frameEnd;
      this.silenceRun = 0;
      return;
    }

    if (p >= this.o.exitThreshold) {
      this.lastVoiced = frameEnd;
      this.silenceRun = 0;
    } else {
      this.silenceRun += VAD_FRAME;
    }

    if (this.silenceRun >= this.minSilenceSamples) {
      this.closeUtterance(out);
      return;
    }

    // A speaker who does not pause still has to be handed to Whisper in
    // bounded pieces; the overlap gives the de-duplicator something to match.
    if (frameEnd - this.chunkStart >= this.maxChunkSamples) {
      const end = this.chunkStart + this.maxChunkSamples;
      this.emit(this.chunkStart, end, false, out);
      this.chunkStart = end - this.overlapSamples;
      this.previewAt = 0;
    } else if (this.o.previewSec > 0 && this.silenceRun === 0 &&
      frameEnd - Math.max(this.chunkStart, this.previewAt) >= this.o.previewSec * VAD_RATE) {
      this.emit(this.chunkStart, frameEnd, false, out, true);
      this.previewAt = frameEnd;
    }
  }

  private closeUtterance(out: SpeechChunk[]): void {
    const end = Math.min(this.total, this.lastVoiced + this.padSamples);
    const spoken = this.lastVoiced - this.speechStart;
    if (this.emittedInUtterance > 0 || spoken >= this.minSpeechSamples) {
      this.emit(this.chunkStart, end, true, out);
    }
    this.inSpeech = false;
    this.silenceRun = 0;
  }

  private emit(start: number, end: number, final: boolean, out: SpeechChunk[], preview = false): void {
    if (end <= start) return;
    const meanProb = this.meanProbOver(start, end);
    if (meanProb < this.o.minMeanProb) {
      // Scored as speech at the edges but mostly not — music, applause, a
      // door. Whisper would happily invent a sentence for it.
      if (final) this.emittedInUtterance = 0;
      return;
    }
    const from = start - this.bufStart;
    const to = Math.min(end - this.bufStart, this.bufLen);
    if (to <= from) return;
    out.push({
      samples: this.buf.slice(from, to),
      audioStart: this.time(start),
      audioEnd: this.time(start + (to - from)),
      meanProb,
      utterance: this.utterance,
      index: this.emittedInUtterance,
      preview,
      final,
    });
    if (!preview) this.emittedInUtterance++;
  }

  private meanProbOver(start: number, end: number): number {
    let sum = 0;
    let n = 0;
    for (const { end: frameEnd, p } of this.probs) {
      if (frameEnd <= start || frameEnd - VAD_FRAME >= end) continue;
      sum += p;
      n++;
    }
    return n === 0 ? 0 : sum / n;
  }
}
