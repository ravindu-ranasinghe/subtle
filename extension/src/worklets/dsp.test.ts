import { describe, expect, it } from 'vitest';
import { Chunker, FRAME_SAMPLES, Resampler, TARGET_RATE } from './dsp.js';

const IN_RATE = 48000;

function tone(freq: number, seconds: number, rate: number, amplitude = 1): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

/** Linear sine sweep from `from` to `to` Hz. */
function sweep(from: number, to: number, seconds: number, rate: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    out[i] = Math.sin(2 * Math.PI * (from * t + ((to - from) * t * t) / (2 * seconds)));
  }
  return out;
}

/** Amplitude of `freq` in `samples`, by correlation with a complex exponential. */
function amplitudeAt(samples: Float32Array, freq: number, rate: number): number {
  let re = 0;
  let im = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = (2 * Math.PI * freq * i) / rate;
    re += samples[i]! * Math.cos(a);
    im += samples[i]! * Math.sin(a);
  }
  return (2 * Math.hypot(re, im)) / samples.length;
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}

/** Run a whole signal through in 128-frame render quanta, as the worklet does. */
function resampleInQuanta(input: Float32Array, resampler: Resampler, quantum = 128): Float32Array {
  const out: number[] = [];
  const scratch = new Float32Array(resampler.maxOutput(quantum));
  for (let i = 0; i < input.length; i += quantum) {
    const block = input.subarray(i, Math.min(i + quantum, input.length));
    const n = resampler.process(block, scratch);
    for (let k = 0; k < n; k++) out.push(scratch[k]!);
  }
  return Float32Array.from(out);
}

describe('Resampler length', () => {
  it('turns one second of 48 kHz into one second of 16 kHz', () => {
    const out = resampleInQuanta(tone(1000, 1, IN_RATE), new Resampler(IN_RATE, TARGET_RATE));
    // The tail of the last partial filter window is still buffered.
    expect(out.length).toBeGreaterThan(TARGET_RATE - 100);
    expect(out.length).toBeLessThanOrEqual(TARGET_RATE);
  });

  it('handles the non-integer 44.1 kHz ratio', () => {
    const out = resampleInQuanta(tone(1000, 1, 44100), new Resampler(44100, TARGET_RATE));
    expect(out.length).toBeGreaterThan(TARGET_RATE - 100);
    expect(out.length).toBeLessThanOrEqual(TARGET_RATE);
  });

  it('bypasses the filter when the rates already match', () => {
    const r = new Resampler(TARGET_RATE, TARGET_RATE);
    expect(r.passthrough).toBe(true);
    const input = tone(1000, 0.1, TARGET_RATE);
    const out = resampleInQuanta(input, r);
    expect(out.length).toBe(input.length);
    expect(out[50]).toBeCloseTo(input[50]!, 6);
  });
});

describe('Resampler frequency response', () => {
  /** Skip the filter's start-up transient before measuring. */
  const steady = (out: Float32Array) => out.subarray(500, out.length - 500);

  it.each([300, 1000, 3000, 6000])('passes %i Hz at unity gain', (freq) => {
    const out = resampleInQuanta(tone(freq, 1, IN_RATE), new Resampler(IN_RATE, TARGET_RATE));
    expect(amplitudeAt(steady(out), freq, TARGET_RATE)).toBeCloseTo(1, 1);
  });

  it('rejects a 10 kHz tone instead of aliasing it to 6 kHz', () => {
    const input = tone(10000, 1, IN_RATE);
    const out = resampleInQuanta(input, new Resampler(IN_RATE, TARGET_RATE));
    // 10 kHz is above the 8 kHz output Nyquist: naive decimation would fold it
    // to |10000 - 16000| = 6000 Hz at close to full amplitude.
    const aliased = amplitudeAt(steady(out), 6000, TARGET_RATE);
    expect(aliased).toBeLessThan(0.002);

    const naive = new Float32Array(TARGET_RATE);
    for (let i = 0; i < naive.length; i++) naive[i] = input[i * 3]!;
    const naiveAlias = amplitudeAt(naive, 6000, TARGET_RATE);
    expect(naiveAlias).toBeGreaterThan(0.9);
    expect(20 * Math.log10(aliased / naiveAlias)).toBeLessThan(-50);
  });

  it.each([9000, 12000, 20000])('suppresses %i Hz by at least 50 dB', (freq) => {
    const out = resampleInQuanta(tone(freq, 1, IN_RATE), new Resampler(IN_RATE, TARGET_RATE));
    expect(rms(steady(out))).toBeLessThan(0.0032); // -50 dB relative to a unit sine's 0.707
  });

  it('keeps a 0-8 kHz sweep flat through the passband and dead above it', () => {
    const out = resampleInQuanta(sweep(0, 20000, 4, IN_RATE), new Resampler(IN_RATE, TARGET_RATE));
    expect(out.length).toBeGreaterThan(TARGET_RATE * 4 - 200);

    // The sweep reaches f Hz at t = f/20000 * 4 seconds.
    const at = (freq: number) => {
      const centre = Math.round((freq / 20000) * 4 * TARGET_RATE);
      return rms(out.subarray(centre - 400, centre + 400));
    };
    expect(at(1000)).toBeGreaterThan(0.6);
    expect(at(5000)).toBeGreaterThan(0.6);
    // Above the output Nyquist there is nothing left to fold back down.
    expect(at(12000)).toBeLessThan(0.01);
    expect(at(18000)).toBeLessThan(0.01);
  });

  it('does not introduce DC offset', () => {
    const out = resampleInQuanta(tone(1000, 1, IN_RATE), new Resampler(IN_RATE, TARGET_RATE));
    // Measure over a whole number of 1 kHz periods (16 output samples each),
    // otherwise the leftover part-period reads as DC that is not there.
    const body = steady(out);
    const window = body.subarray(0, Math.floor(body.length / 16) * 16);
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    expect(Math.abs(mean)).toBeLessThan(1e-5);
  });
});

describe('Chunker', () => {
  function collect(totalSamples: number, pushSize: number, t0 = 12.5) {
    const chunker = new Chunker();
    chunker.start(t0);
    const frames: { samples: Float32Array; audioStart: number }[] = [];
    let written = 0;
    while (written < totalSamples) {
      const n = Math.min(pushSize, totalSamples - written);
      const block = new Float32Array(n);
      for (let i = 0; i < n; i++) block[i] = written + i; // ramp, so order is checkable
      written += n;
      chunker.push(block, (samples, audioStart) => frames.push({ samples, audioStart }));
    }
    return frames;
  }

  it('emits 100 ms frames of exactly FRAME_SAMPLES', () => {
    const frames = collect(TARGET_RATE, 431);
    expect(frames).toHaveLength(10);
    for (const f of frames) expect(f.samples.length).toBe(FRAME_SAMPLES);
  });

  it('stamps timestamps that are monotonic and exactly contiguous', () => {
    const frames = collect(TARGET_RATE * 3, 431, 12.5);
    expect(frames[0]!.audioStart).toBe(12.5);
    for (let i = 1; i < frames.length; i++) {
      const gap = frames[i]!.audioStart - frames[i - 1]!.audioStart;
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeCloseTo(0.1, 9);
    }
    // No accumulated drift across 3 s.
    expect(frames.at(-1)!.audioStart).toBeCloseTo(12.5 + 0.1 * (frames.length - 1), 9);
  });

  it('loses no samples and preserves order across ragged pushes', () => {
    const frames = collect(FRAME_SAMPLES * 4, 97, 0);
    expect(frames).toHaveLength(4);
    let expected = 0;
    for (const f of frames) {
      for (const s of f.samples) expect(s).toBe(expected++);
    }
  });

  it('hands out a fresh buffer per frame so callers can transfer it', () => {
    const frames = collect(FRAME_SAMPLES * 3, FRAME_SAMPLES, 0);
    const buffers = new Set(frames.map((f) => f.samples.buffer));
    expect(buffers.size).toBe(3);
  });
});

describe('end to end: 48 kHz capture to timestamped chunks', () => {
  it('produces contiguous chunks whose clock matches real elapsed audio', () => {
    const resampler = new Resampler(IN_RATE, TARGET_RATE);
    const chunker = new Chunker();
    chunker.start(100);
    const input = tone(440, 2, IN_RATE);
    const scratch = new Float32Array(resampler.maxOutput(128));
    const frames: number[] = [];
    for (let i = 0; i < input.length; i += 128) {
      const n = resampler.process(input.subarray(i, i + 128), scratch);
      chunker.push(scratch.subarray(0, n), (_s, audioStart) => frames.push(audioStart));
    }
    // 2 s of audio, 100 ms per chunk, minus whatever is still in flight.
    expect(frames.length).toBeGreaterThanOrEqual(19);
    expect(frames[0]).toBe(100);
    for (let i = 1; i < frames.length; i++) {
      expect(frames[i]! - frames[i - 1]!).toBeCloseTo(0.1, 9);
    }
    // The last chunk starts within one chunk of where 2 s of audio ends.
    expect(frames.at(-1)!).toBeGreaterThanOrEqual(101.8);
    expect(frames.at(-1)!).toBeLessThanOrEqual(102);
  });
});
