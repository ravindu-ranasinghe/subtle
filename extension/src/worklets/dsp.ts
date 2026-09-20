/**
 * The DSP behind the resampler worklet, kept free of AudioWorklet globals so
 * it can be unit-tested in Node. See ./resampler.ts for the processor.
 */

/** Name the worklet registers itself under. */
export const PROCESSOR_NAME = 'subtle-resampler';

/** Whisper's input rate. Everything downstream assumes it. */
export const TARGET_RATE = 16000;

/** 100 ms at TARGET_RATE — one audioChunk. */
export const FRAME_SAMPLES = 1600;

function sinc(x: number): number {
  if (x === 0) return 1;
  const p = Math.PI * x;
  return Math.sin(p) / p;
}

/** Modified Bessel function of the first kind, order 0. Series converges fast for the betas we use. */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 32; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}

export interface ResamplerOptions {
  /** FIR length. More taps = narrower transition band, more work per sample. */
  taps?: number;
  /** Fractional-delay resolution. Nearest phase is used, no interpolation. */
  phases?: number;
  /** Cutoff as a fraction of the *output* rate. 0.45 → 7.2 kHz for 16 kHz out. */
  cutoffRatio?: number;
  /** Target stopband attenuation in dB; sets the Kaiser beta. */
  stopbandDb?: number;
}

/**
 * Arbitrary-ratio windowed-sinc resampler with a Kaiser-windowed low-pass,
 * built for decimation (48 kHz or 44.1 kHz down to 16 kHz).
 *
 * Naive decimation folds everything above 8 kHz back into the speech band —
 * a 10 kHz tone would arrive as a 6 kHz one and Whisper would hear it. The
 * filter below puts that at roughly -60 dB instead.
 *
 * With the defaults (128 taps, cutoff 7.2 kHz) the transition band is about
 * 1.4 kHz wide, so the passband is flat to ~6.5 kHz and the stopband is
 * established before the 8 kHz Nyquist.
 */
export class Resampler {
  /** Input samples consumed per output sample. */
  readonly ratio: number;
  /** True when in and out rates match and the filter is bypassed. */
  readonly passthrough: boolean;

  private readonly taps: number;
  private readonly half: number;
  private readonly phases: number;
  /** phases × taps, row-major; each row sums to 1 so DC gain is unity. */
  private readonly table: Float32Array;
  /** The last `taps` input samples, so a filter can straddle two blocks. */
  private readonly history: Float32Array;
  private work: Float32Array;
  /** Position of the next output, in input samples relative to the next block. */
  private pos = 0;

  constructor(inRate: number, outRate: number = TARGET_RATE, options: ResamplerOptions = {}) {
    if (inRate <= 0 || outRate <= 0) throw new Error('Resampler: rates must be positive');
    this.ratio = inRate / outRate;
    this.passthrough = inRate === outRate;

    const taps = options.taps ?? 128;
    if (taps % 2 !== 0) throw new Error('Resampler: taps must be even');
    this.taps = taps;
    this.half = taps / 2;
    this.phases = options.phases ?? 512;
    this.history = new Float32Array(taps);
    this.work = new Float32Array(taps + 1024);
    this.table = new Float32Array(this.passthrough ? 0 : this.phases * taps);
    if (!this.passthrough) this.buildTable(inRate, outRate, options);
  }

  private buildTable(inRate: number, outRate: number, options: ResamplerOptions): void {
    // Cutoff is relative to the lower of the two rates: decimating needs the
    // output Nyquist, interpolating needs the input's.
    const cutoffHz = (options.cutoffRatio ?? 0.45) * Math.min(inRate, outRate);
    const fc = cutoffHz / inRate; // normalised to the input rate, < 0.5
    const attenuation = options.stopbandDb ?? 60;
    const beta =
      attenuation > 50
        ? 0.1102 * (attenuation - 8.7)
        : attenuation >= 21
          ? 0.5842 * (attenuation - 21) ** 0.4 + 0.07886 * (attenuation - 21)
          : 0;
    const i0beta = besselI0(beta);

    for (let phase = 0; phase < this.phases; phase++) {
      const frac = phase / this.phases;
      const row = phase * this.taps;
      let sum = 0;
      for (let k = 0; k < this.taps; k++) {
        // Distance from the output position to tap k's input sample.
        const d = frac + (this.half - 1 - k);
        const r = d / this.half;
        const window = r * r >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - r * r)) / i0beta;
        const h = 2 * fc * sinc(2 * fc * d) * window;
        this.table[row + k] = h;
        sum += h;
      }
      // Normalise away the window's DC ripple; without this the gain wobbles
      // by a few tenths of a dB as the fractional phase walks.
      if (sum !== 0) for (let k = 0; k < this.taps; k++) this.table[row + k]! /= sum;
    }
  }

  /** Upper bound on outputs from `n` inputs — size `out` at least this big. */
  maxOutput(n: number): number {
    return this.passthrough ? n : Math.ceil(n / this.ratio) + 1;
  }

  /** Filters `input` into `out`; returns how many output samples were written. */
  process(input: Float32Array, out: Float32Array): number {
    const n = input.length;
    if (n === 0) return 0;
    if (this.passthrough) {
      out.set(input.subarray(0, Math.min(n, out.length)));
      return Math.min(n, out.length);
    }

    const { taps, half, table, phases } = this;
    if (this.work.length < taps + n) this.work = new Float32Array(taps + n);
    const work = this.work;
    work.set(this.history, 0);
    work.set(input, taps);

    // An output at position p needs inputs floor(p)-half+1 .. floor(p)+half,
    // so we can only emit while floor(p)+half is inside this block.
    const limit = n - 1 - half;
    let p = this.pos;
    let o = 0;
    while (p <= limit && o < out.length) {
      const base = Math.floor(p);
      let phase = ((p - base) * phases) | 0;
      if (phase >= phases) phase = phases - 1;
      const row = phase * taps;
      const start = base - half + 1 + taps;
      let sum = 0;
      for (let k = 0; k < taps; k++) sum += table[row + k]! * work[start + k]!;
      out[o++] = sum;
      p += this.ratio;
    }

    this.pos = p - n;
    this.history.set(work.subarray(n, n + taps));
    return o;
  }

  reset(): void {
    this.history.fill(0);
    this.pos = 0;
  }
}

/**
 * Packs a sample stream into fixed 100 ms frames and stamps each with its
 * position on the AudioContext clock.
 *
 * Timestamps are derived from a running output-sample count rather than read
 * off the clock per frame, so they stay exactly contiguous even though the
 * resampler emits an uneven number of samples per render quantum.
 */
export class Chunker {
  private buf: Float32Array;
  private filled = 0;
  private emitted = 0;
  private t0 = 0;

  constructor(
    private readonly frameSamples: number = FRAME_SAMPLES,
    private readonly rate: number = TARGET_RATE,
  ) {
    this.buf = new Float32Array(frameSamples);
  }

  /** `t0` is the AudioContext time of the first sample that will be pushed. */
  start(t0: number): void {
    this.t0 = t0;
    this.emitted = 0;
    this.filled = 0;
  }

  /** Frame duration in seconds. */
  get frameDuration(): number {
    return this.frameSamples / this.rate;
  }

  /**
   * Emits every complete frame in `src`. Each frame handed to `emit` is a
   * fresh buffer, so the caller is free to transfer it.
   */
  push(src: Float32Array, emit: (frame: Float32Array, audioStart: number) => void): void {
    let i = 0;
    while (i < src.length) {
      const take = Math.min(this.frameSamples - this.filled, src.length - i);
      this.buf.set(src.subarray(i, i + take), this.filled);
      this.filled += take;
      i += take;
      if (this.filled < this.frameSamples) continue;
      const frame = this.buf;
      const audioStart = this.t0 + (this.emitted * this.frameSamples) / this.rate;
      this.emitted++;
      this.buf = new Float32Array(this.frameSamples);
      this.filled = 0;
      emit(frame, audioStart);
    }
  }
}
