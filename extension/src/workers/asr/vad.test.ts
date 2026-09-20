import { describe, expect, it } from 'vitest';
import { SpeechSegmenter, VAD_FRAME, VAD_RATE, type SpeechChunk, type SpeechProbe } from './vad.js';
import type { AudioChunk } from '@subtle/shared';

/**
 * Scores frames from a script of [seconds, probability] spans, so the
 * segmenter can be tested without a model. Anything outside a span is 0.
 */
class ScriptedProbe implements SpeechProbe {
  private frame = 0;
  constructor(private readonly spans: [number, number, number][]) {}
  async score(): Promise<number> {
    const t = (this.frame++ * VAD_FRAME) / VAD_RATE;
    for (const [from, to, p] of this.spans) if (t >= from && t < to) return p;
    return 0.02;
  }
  reset(): void {
    this.frame = 0;
  }
}

/** Feed `seconds` of audio in 100 ms chunks, as capture delivers it. */
async function feed(seg: SpeechSegmenter, seconds: number, startAt = 0, fill = 0.1, includePreviews = false) {
  const out: SpeechChunk[] = [];
  const size = VAD_RATE / 10;
  for (let i = 0; i < seconds * 10; i++) {
    const samples = new Float32Array(size).fill(fill);
    const chunk: AudioChunk = { samples, audioStart: startAt + i / 10 };
    out.push(...(await seg.push(chunk)));
  }
  return includePreviews ? out : out.filter((c) => !c.preview);
}

describe('silence and non-speech', () => {
  it('emits nothing for pure silence', async () => {
    const seg = new SpeechSegmenter(new ScriptedProbe([]));
    expect(await feed(seg, 5)).toHaveLength(0);
  });

  it('emits nothing for music-like audio that never crosses the threshold', async () => {
    // The mock WAV fixture behaves this way against the real Silero: 1% of
    // frames above 0.5, mean 0.036.
    const seg = new SpeechSegmenter(new ScriptedProbe([[0, 8, 0.2]]));
    expect(await feed(seg, 8)).toHaveLength(0);
  });

  it('drops a chunk whose mean probability is below the floor', async () => {
    // Crosses 0.5 briefly, then sits just under the exit threshold: a burst
    // of applause rather than speech.
    const seg = new SpeechSegmenter(new ScriptedProbe([[1, 1.1, 0.9], [1.1, 3, 0.3]]));
    expect(await feed(seg, 5)).toHaveLength(0);
  });

  it('ignores a blip shorter than minSpeechMs', async () => {
    const seg = new SpeechSegmenter(new ScriptedProbe([[1, 1.1, 0.95]]));
    expect(await feed(seg, 4)).toHaveLength(0);
  });
});

describe('utterance segmentation', () => {
  it('emits one final chunk per utterance, padded either side', async () => {
    const seg = new SpeechSegmenter(new ScriptedProbe([[1, 2.5, 0.95]]));
    const chunks = await feed(seg, 5);
    expect(chunks).toHaveLength(1);
    const c = chunks[0]!;
    expect(c.final).toBe(true);
    expect(c.index).toBe(0);
    // Padding is silence by design, so it pulls the mean down from 0.95.
    expect(c.meanProb).toBeGreaterThan(0.75);
    // 150 ms of padding either side of [1, 2.5].
    expect(c.audioStart).toBeLessThan(1);
    expect(c.audioStart).toBeGreaterThan(0.7);
    expect(c.audioEnd).toBeGreaterThan(2.5);
    expect(c.audioEnd).toBeLessThan(2.85);
    expect(c.samples.length).toBeCloseTo((c.audioEnd - c.audioStart) * VAD_RATE, -1);
  });

  it('separates two utterances across a pause', async () => {
    const seg = new SpeechSegmenter(new ScriptedProbe([[1, 2, 0.95], [3.5, 4.5, 0.95]]));
    const chunks = await feed(seg, 6);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.utterance).not.toBe(chunks[1]!.utterance);
    expect(chunks.every((c) => c.final)).toBe(true);
  });

  it('does not split on a gap shorter than minSilenceMs', async () => {
    // 200 ms dip mid-sentence — a breath, not an utterance boundary.
    const seg = new SpeechSegmenter(new ScriptedProbe([[1, 2, 0.95], [2.2, 3, 0.95]]));
    const chunks = await feed(seg, 5);
    expect(new Set(chunks.map((c) => c.utterance)).size).toBe(1);
    expect(chunks.at(-1)!.audioEnd).toBeGreaterThan(3);
  });

  it('keeps timestamps on the audio clock it was handed', async () => {
    const seg = new SpeechSegmenter(new ScriptedProbe([[1, 2, 0.95]]));
    const chunks = await feed(seg, 4, 500);
    expect(chunks[0]!.audioStart).toBeGreaterThan(500.7);
    expect(chunks[0]!.audioStart).toBeLessThan(501);
  });

  it('closes an open utterance on flush', async () => {
    const seg = new SpeechSegmenter(new ScriptedProbe([[1, 10, 0.95]]));
    await feed(seg, 3);
    const tail = await seg.flush();
    expect(tail).toHaveLength(1);
    expect(tail[0]!.final).toBe(true);
  });
});

describe('long utterances', () => {
  it('splits at maxChunkSec with an overlap and marks only the last final', async () => {
    const seg = new SpeechSegmenter(new ScriptedProbe([[0.5, 12, 0.95]]));
    const chunks = await feed(seg, 14);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.every((c) => c.utterance === chunks[0]!.utterance)).toBe(true);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
    expect(chunks.slice(0, -1).every((c) => !c.final)).toBe(true);
    expect(chunks.at(-1)!.final).toBe(true);

    for (const c of chunks.slice(0, -1)) {
      expect(c.audioEnd - c.audioStart).toBeCloseTo(2.5, 1);
    }
    // Each split repeats the last 0.5 s of the one before.
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.audioStart).toBeCloseTo(chunks[i - 1]!.audioEnd - 0.5, 1);
    }
  });

  it('honours custom chunk and overlap lengths', async () => {
    const seg = new SpeechSegmenter(new ScriptedProbe([[0.5, 8, 0.95]]), {
      maxChunkSec: 2,
      overlapSec: 0.25,
    });
    const chunks = await feed(seg, 9);
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    expect(chunks[1]!.audioStart).toBeCloseTo(chunks[0]!.audioEnd - 0.25, 1);
  });

  it('rejects an overlap longer than the chunk', () => {
    expect(() => new SpeechSegmenter(new ScriptedProbe([]), { maxChunkSec: 1, overlapSec: 2 })).toThrow(
      /overlapSec/,
    );
  });
});

describe('discontinuities', () => {
  it('resets rather than inventing speech across an audio gap', async () => {
    const seg = new SpeechSegmenter(new ScriptedProbe([[0, 30, 0.95]]));
    await feed(seg, 2, 0);
    const after = await feed(seg, 2, 100); // 98 s jump: a seek or a restart
    // Nothing straddling the gap; whatever comes out starts after it.
    for (const c of after) expect(c.audioStart).toBeGreaterThanOrEqual(100);
  });
});

it('previews growing speech early and reuses its index for the completed chunk', async () => {
  const seg = new SpeechSegmenter(new ScriptedProbe([[0, 5, 0.95]]));
  const early = await feed(seg, 1.3, 0, 0.1, true);
  expect(early).toHaveLength(2);
  expect(early[0]).toMatchObject({ index: 0, preview: true, final: false });
  expect(early[0]!.audioEnd).toBeLessThan(1.3);
  const later = await feed(seg, 1.3, 1.3, 0.1, true);
  expect(early[1]!.audioEnd).toBeGreaterThan(early[0]!.audioEnd);
  const finished = later.find((c) => !c.preview)!;
  expect(finished).toMatchObject({ index: 0, preview: false });
  expect(finished.audioStart).toBe(early[0]!.audioStart);
  expect(finished.audioEnd).toBeCloseTo(2.5);
});
