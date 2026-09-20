import { describe, expect, it, vi } from 'vitest';
import type { AudioChunk, MetricsMsg, Segment } from '@subtle/shared';
import { MAX_QUEUE_SEC, WorkerRecognizer } from './recognizer.js';
import { VAD_FRAME, VAD_RATE, type SpeechProbe } from './vad.js';

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

/** Returns scripted text per call, so overlap stitching can be checked exactly. */
class FakeEngine {
  readonly backend = 'wasm' as const;
  calls = 0;
  detections = 0;
  constructor(
    private readonly texts: string[],
    private readonly options: { lang?: string; delayMs?: number } = {},
  ) {}
  async detectLanguage(): Promise<string | null> {
    this.detections++;
    return this.options.lang ?? 'de';
  }
  async transcribe(_s: Float32Array, _lang: string, offset: number) {
    const text = this.texts[Math.min(this.calls++, this.texts.length - 1)] ?? '';
    if (this.options.delayMs) await new Promise((r) => setTimeout(r, this.options.delayMs));
    const parts = text.split(' ').filter(Boolean);
    return {
      text,
      words: parts.map((w, i) => ({ w, start: offset + i * 0.2, end: offset + (i + 1) * 0.2 })),
    };
  }
}

interface Harness {
  recognizer: WorkerRecognizer;
  segments: Segment[];
  metrics: Omit<MetricsMsg, 'type'>[];
  errors: string[];
  feed(seconds: number, startAt?: number): void;
}

async function harness(
  spans: [number, number, number][],
  engine: FakeEngine,
  options: Partial<ConstructorParameters<typeof WorkerRecognizer>[0]> = {},
): Promise<Harness> {
  const segments: Segment[] = [];
  const metrics: Omit<MetricsMsg, 'type'>[] = [];
  const errors: string[] = [];
  const recognizer = new WorkerRecognizer({
    segmenter: { previewSec: 0 },
    probe: new ScriptedProbe(spans),
    engine,
    onMetrics: (m) => metrics.push(m),
    onError: (m) => errors.push(m),
    ...options,
  });
  recognizer.onSegment((s) => segments.push(s));
  await recognizer.load('tiny', () => {});
  return {
    recognizer,
    segments,
    metrics,
    errors,
    feed(seconds, startAt = 0) {
      const size = VAD_RATE / 10;
      for (let i = 0; i < seconds * 10; i++) {
        const samples = new Float32Array(size).fill(0.15);
        const chunk: AudioChunk = { samples, audioStart: startAt + i / 10 };
        recognizer.pushAudio(chunk);
      }
    },
  };
}

describe('utterance assembly', () => {
  it('emits one final segment for a short utterance', async () => {
    const h = await harness([[1, 2, 0.95]], new FakeEngine(['Guten Morgen']));
    h.feed(4);
    await h.recognizer.idle();

    expect(h.segments).toHaveLength(1);
    expect(h.segments[0]).toMatchObject({ id: 'u1-0', text: 'Guten Morgen', lang: 'de', interim: false });
    expect(h.segments[0]!.words?.[0]?.w).toBe('Guten');
  });

  it('finalises bounded chunks before a speaker pauses and removes overlap', async () => {
    const engine = new FakeEngine([
      'the quick brown fox jumps',
      'fox jumps over the lazy dog',
      'lazy dog and runs away',
    ]);
    const h = await harness([[0.5, 12, 0.95]], engine);
    h.feed(7);
    await h.recognizer.idle();

    expect(h.segments).toHaveLength(3);
    expect(h.segments.map((s) => s.id)).toEqual(['u1-0', 'u1-1', 'u1-2']);
    expect(h.segments.every((s) => !s.interim)).toBe(true);
    expect(h.segments.map((s) => s.text)).toEqual([
      'the quick brown fox jumps', 'over the lazy dog', 'and runs away',
    ]);
    expect(h.segments.every((s) => s.audioEnd - s.audioStart <= 2.5)).toBe(true);
  });

  it('does not transcribe a final tail made entirely of already-captioned overlap', async () => {
    const engine = new FakeEngine(['first words here', 'second words here', 'invented tail']);
    const h = await harness([[0, 4.3, 0.95]], engine);
    h.feed(5);
    await h.recognizer.idle();
    expect(engine.calls).toBe(2);
    expect(h.segments.map((s) => s.text)).toEqual(['first words here', 'second words here']);
    expect(h.segments.every((s) => s.audioEnd > s.audioStart)).toBe(true);
  });

  it('keeps word timings in order without duplicating the overlap', async () => {
    const engine = new FakeEngine(['alpha beta gamma', 'gamma delta epsilon', 'epsilon zeta']);
    const h = await harness([[0.5, 12, 0.95]], engine);
    h.feed(14);
    await h.recognizer.idle();

    const words = h.segments.at(-1)!.words!;
    for (let i = 1; i < words.length; i++) {
      expect(words[i]!.start).toBeGreaterThanOrEqual(words[i - 1]!.start);
    }
  });
});

describe('language handling', () => {
  it('detects once and locks', async () => {
    const engine = new FakeEngine(['eins', 'zwei'], { lang: 'es' });
    const h = await harness([[1, 2, 0.95], [3.5, 4.5, 0.95]], engine);
    h.feed(6);
    await h.recognizer.idle();

    expect(engine.detections).toBe(1);
    expect(h.segments.every((s) => s.lang === 'es')).toBe(true);
  });

  it('skips detection entirely when srcLang is fixed', async () => {
    const engine = new FakeEngine(['bonjour']);
    const h = await harness([[1, 2, 0.95]], engine, { srcLang: 'fr' });
    h.feed(4);
    await h.recognizer.idle();

    expect(engine.detections).toBe(0);
    expect(h.segments[0]!.lang).toBe('fr');
  });
});

describe('hallucination filtering', () => {
  it('drops an idle phrase and emits nothing for it', async () => {
    // Fed silence-level audio, so energy is below the gate.
    const h = await harness([[1, 2, 0.95]], new FakeEngine(['Thank you.']), {});
    const size = VAD_RATE / 10;
    for (let i = 0; i < 40; i++) {
      h.recognizer.pushAudio({ samples: new Float32Array(size).fill(0.0005), audioStart: i / 10 });
    }
    await h.recognizer.idle();
    expect(h.segments).toHaveLength(0);
  });

  it('still closes an utterance whose final chunk was filtered out', async () => {
    const engine = new FakeEngine(['real speech here', 'more real speech', 'you you you you you']);
    const h = await harness([[0.5, 12, 0.95]], engine);
    h.feed(14);
    await h.recognizer.idle();

    const final = h.segments.at(-1)!;
    expect(final.interim).toBe(false);
    expect(final.text).not.toContain('you you you');
  });
});

describe('real-time guard', () => {
  it('reports RTF and stage metrics', async () => {
    const h = await harness([[1, 2, 0.95]], new FakeEngine(['hallo']));
    h.feed(4);
    await h.recognizer.idle();

    expect(h.metrics.some((m) => m.stage === 'vad')).toBe(true);
    const asr = h.metrics.find((m) => m.stage === 'asr')!;
    expect(asr.rtf).toBeGreaterThan(0);
    expect(asr.segmentId).toBe('u1-0');
    expect(h.recognizer.rtf).toBeGreaterThan(0);
  });

  it('sheds the oldest chunks and recommends a smaller model when it falls behind', async () => {
    // 40 ms per chunk of a 5 s chunk is fast, so drive the backlog directly.
    const engine = new FakeEngine(['x'], { delayMs: 30 });
    const h = await harness([[0.5, 60, 0.95]], engine);
    h.feed(60);
    await h.recognizer.idle();

    expect(h.errors.length).toBeGreaterThan(0);
    expect(h.errors[0]).toMatch(/smaller Whisper model/);
    expect(h.errors[0]).toMatch(/dropped \d+ chunk/);
  });

  it('exposes the queue ceiling it enforces', () => {
    expect(MAX_QUEUE_SEC).toBe(3);
  });
});

describe('lifecycle', () => {
  it('flush closes an utterance still open at the end of capture', async () => {
    const h = await harness([[1, 20, 0.95]], new FakeEngine(['still talking']));
    h.feed(3);
    await h.recognizer.flush();
    expect(h.segments.some((s) => !s.interim)).toBe(true);
  });

  it('dispose stops emitting', async () => {
    const h = await harness([[1, 2, 0.95]], new FakeEngine(['hallo']));
    h.recognizer.dispose();
    h.feed(4);
    await h.recognizer.idle();
    expect(h.segments).toHaveLength(0);
  });
});

it('refines a preview in place without losing its words to overlap deduplication', async () => {
  const h = await harness([[0, 4, 0.95]], new FakeEngine(['hello', 'hello world']), { segmenter: { previewSec: 1.2 } });
  h.feed(1.3);
  await h.recognizer.idle();
  expect(h.segments).toHaveLength(1);
  expect(h.segments[0]).toMatchObject({ id: 'u1-0', text: 'hello', interim: true });
  h.feed(1.3, 1.3);
  await h.recognizer.idle();
  expect(h.segments.at(-1)).toMatchObject({ id: 'u1-0', text: 'hello world', interim: false });
});

it('lets the newest preview wait behind the chunk in flight, so the line keeps moving', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const engine = new FakeEngine(['first', 'second']);
  const real = engine.transcribe.bind(engine);
  vi.spyOn(engine, 'transcribe').mockImplementationOnce(async (...args) => {
    const result = await real(...args);
    await pending;
    return result;
  });
  // maxChunkSec well past the audio fed: nothing final is due, so the only
  // thing that can reach the engine is a preview.
  const h = await harness([[0, 7, 0.95]], engine, { segmenter: { previewSec: 1.2, maxChunkSec: 10 } });
  h.feed(1.3);
  await vi.waitFor(() => expect(engine.calls).toBe(1));
  h.feed(2.4, 1.3);
  // Two more previews fall due while the first is blocked; only the newest
  // survives, and it runs as soon as the engine is free.
  await vi.waitFor(() => expect(h.metrics.filter((m) => m.stage === 'vad')).toHaveLength(37));
  release();
  await h.recognizer.idle();
  expect(engine.calls).toBe(2);
  const interim = h.segments.filter((s) => s.interim);
  expect(interim).toHaveLength(2);
  expect(interim.at(-1)!.audioEnd, 'the surviving preview is the newest one').toBeGreaterThan(3.5);
});

it('drops a queued preview when a finished chunk supersedes it', async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const engine = new FakeEngine(['first', 'final words']);
  const real = engine.transcribe.bind(engine);
  vi.spyOn(engine, 'transcribe').mockImplementationOnce(async (...args) => {
    const result = await real(...args);
    await pending;
    return result;
  });
  const h = await harness([[0, 7, 0.95]], engine, { segmenter: { previewSec: 1.2 } });
  h.feed(1.3);
  await vi.waitFor(() => expect(engine.calls).toBe(1));
  h.feed(2.2, 1.3);
  // VAD keeps scoring while inference is blocked; a second preview becomes due.
  await vi.waitFor(() => expect(h.metrics.filter((m) => m.stage === 'vad')).toHaveLength(35));
  release();
  await h.recognizer.idle();
  expect(h.segments.filter((s) => s.interim)).toHaveLength(1);
  expect(h.segments.at(-1)).toMatchObject({ id: 'u1-0', interim: false });
  expect(engine.calls).toBe(2);
});
