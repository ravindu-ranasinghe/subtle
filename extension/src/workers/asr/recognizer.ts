/**
 * The SpeechRecognizer contract, assembled from the VAD segmenter, the
 * Whisper engine and the text filters.
 *
 * Shape of the pipeline: audio in → VAD splits it into utterances → each
 * utterance is transcribed in overlapping 2.5 s pieces, with an early
 * preview every 640 ms. Previews refine in place; completed chunks remove
 * repeated overlap before translation and dubbing.
 */

import type {
  AudioChunk,
  MetricsMsg,
  ProgressFn,
  Segment,
  SpeechRecognizer,
  WhisperSize,
} from '@subtle/shared';
import { SpeechSegmenter, type SegmenterOptions, type SpeechChunk, type SpeechProbe } from './vad.js';
import { SileroProbe } from './silero.js';
import { WhisperEngine, type Backend, type WhisperOptions } from './whisper.js';
import { dedupeOverlap, classifySegment, rms } from './text.js';

/** Queued audio beyond this means we are losing; shed load. */
export const MAX_QUEUE_SEC = 3;
/** Don't nag: at most one backlog error per this many ms. */
const ERROR_COOLDOWN_MS = 10_000;
/** Confirm the language with a full second before locking it for the session. */
const MIN_DETECT_SEC = 1;

export interface RecognizerHooks {
  onMetrics?: (m: Omit<MetricsMsg, 'type'>) => void;
  onError?: (message: string) => void;
  onBackend?: (backend: Backend) => void;
  /** Fired as soon as a language is detected so translation can preload. */
  onLanguage?: (lang: string) => void;
}

export interface RecognizerOptions extends RecognizerHooks {
  /** BCP-47 code, or 'auto' to detect from the first usable chunk and lock. */
  srcLang?: string;
  segmenter?: SegmenterOptions;
  /** Injected by tests and by bench/; production builds the real ones. */
  probe?: SpeechProbe;
  engine?: Pick<WhisperEngine, 'transcribe' | 'detectLanguage' | 'backend'>;
  whisper?: Partial<WhisperOptions>;
}

export class WorkerRecognizer implements SpeechRecognizer {
  private segmenter: SpeechSegmenter | null = null;
  private engine: RecognizerOptions['engine'] | null = null;
  private previewEngine: RecognizerOptions['engine'] | null = null;
  private probe: SpeechProbe | null = null;
  private callbacks: ((s: Segment) => void)[] = [];

  /**
   * Audio chunks arrive faster than the VAD consumes them, and
   * `segmenter.push` awaits the model mid-way through mutating its buffer.
   * Overlapping calls would interleave there, so they are serialised.
   */
  private pushChain: Promise<void> = Promise.resolve();
  private queue: SpeechChunk[] = [];
  private queuedSeconds = 0;
  private pumping: Promise<void> | null = null;
  private disposed = false;
  private lastErrorAt = 0;

  private lang: string | null = null;
  /** End of the newest completed (non-preview) chunk, on the audio clock. */
  private lastChunkEnd = 0;
  private readonly open = new Map<number, { text: string; audioEnd: number }>();
  /** Most recent real-time factors, newest last. */
  private readonly rtfs: number[] = [];

  constructor(private readonly options: RecognizerOptions = {}) {
    const src = options.srcLang;
    if (src && src !== 'auto') this.lang = src;
  }

  /** Backend actually in use, once loaded. */
  get backend(): Backend | null {
    return this.engine?.backend ?? null;
  }

  /** Median real-time factor over the last 20 transcriptions. */
  get rtf(): number | null {
    if (this.rtfs.length === 0) return null;
    const sorted = [...this.rtfs].sort((a, b) => a - b);
    return sorted[sorted.length >> 1]!;
  }

  async load(model: WhisperSize, onProgress: ProgressFn): Promise<void> {
    // Two downloads behind one progress bar: VAD is ~2 MB against Whisper's
    // 80-490 MB, so it gets the first 2% and Whisper the rest.
    const probe = this.options.probe ?? new SileroProbe();
    if (probe instanceof SileroProbe) {
      await probe.load((p) => {
        if (p.status === 'progress') onProgress(p.loaded * 0.02, p.total);
      });
    }
    if (this.disposed) return;
    this.probe = probe;
    this.segmenter = new SpeechSegmenter(probe, this.options.segmenter);

    this.engine =
      this.options.engine ??
      (await WhisperEngine.create({
        size: model,
        ...this.options.whisper,
        onProgress: (p) => {
          if (p.status === 'progress') onProgress(p.total * 0.02 + p.loaded * 0.98, p.total);
        },
      }));
    if (this.disposed) {
      void (this.engine as WhisperEngine)?.dispose?.();
      return;
    }
    // Tiny handles the short, replaceable preview. The user's selected model
    // still produces the complete caption and the text used for dubbing.
    this.previewEngine = model === 'tiny' || this.options.engine ? this.engine : await WhisperEngine.create({
      size: 'tiny', ...this.options.whisper,
      onProgress: (p) => { if (p.status === 'progress') onProgress(p.loaded, p.total); },
    });
    if (this.disposed) {
      if (this.previewEngine !== this.engine) void (this.previewEngine as WhisperEngine)?.dispose?.();
      return;
    }
    this.options.onBackend?.(this.engine.backend);
  }

  pushAudio(chunk: AudioChunk): void {
    if (this.disposed || !this.segmenter || !this.engine || !this.previewEngine) return;
    this.pushChain = this.pushChain
      .then(async () => {
        if (this.disposed || !this.segmenter || !this.engine) return;
        const started = performance.now();
        const speech = await this.segmenter.push(chunk);
        this.options.onMetrics?.({ stage: 'vad', ms: performance.now() - started });
        for (const s of speech) this.enqueue(s);
        void this.pump();
      })
      .catch((err: unknown) => this.report(err));
  }

  /** Resolves once every pushed chunk has been segmented and transcribed. */
  async idle(): Promise<void> {
    await this.pushChain;
    await this.pump();
  }

  onSegment(cb: (s: Segment) => void): void {
    this.callbacks.push(cb);
  }

  dispose(): void {
    this.disposed = true;
    this.queue = [];
    this.queuedSeconds = 0;
    this.callbacks = [];
    this.open.clear();
    void (this.engine as WhisperEngine | null)?.dispose?.();
    if (this.previewEngine !== this.engine) void (this.previewEngine as WhisperEngine | null)?.dispose?.();
  }

  /** Closes whatever is still being spoken. Call when capture stops. */
  async flush(): Promise<void> {
    await this.pushChain;
    const tail = (await this.segmenter?.flush()) ?? [];
    for (const s of tail) this.enqueue(s);
    await this.pump();
  }

  // ------------------------------------------------------------- internals

  private enqueue(chunk: SpeechChunk): void {
    // At most one preview ever waits, and it is always the newest: an older
    // snapshot of the same speech is never worth the inference. A preview may
    // wait behind the chunk currently in flight — that is what keeps the line
    // moving while a slower model finishes the sentence — but never behind
    // another queued chunk, so finals keep their priority and previews cannot
    // accumulate.
    this.dropQueuedPreviews();
    if (chunk.preview && this.queue.length > 0) return;
    this.queue.push(chunk);
    this.queuedSeconds += chunk.audioEnd - chunk.audioStart;
    this.shedLoad();
  }

  private dropQueuedPreviews(): void {
    if (!this.queue.some((queued) => queued.preview)) return;
    this.queue = this.queue.filter((queued) => {
      if (!queued.preview) return true;
      this.queuedSeconds -= queued.audioEnd - queued.audioStart;
      return false;
    });
  }

  /**
   * Whisper slower than real time means the backlog grows without bound and
   * captions fall further behind the video every second. Better to lose the
   * oldest audio and tell the user to pick a smaller model.
   */
  private shedLoad(): void {
    if (this.queuedSeconds <= MAX_QUEUE_SEC) return;
    let dropped = 0;
    while (this.queuedSeconds > MAX_QUEUE_SEC && this.queue.length > 1) {
      const gone = this.queue.shift()!;
      this.queuedSeconds -= gone.audioEnd - gone.audioStart;
      this.open.delete(gone.utterance);
      dropped++;
    }
    const now = Date.now();
    if (dropped > 0 && now - this.lastErrorAt > ERROR_COOLDOWN_MS) {
      this.lastErrorAt = now;
      const rtf = this.rtf;
      this.options.onError?.(
        `Speech recognition is falling behind${rtf ? ` (RTF ${rtf.toFixed(1)})` : ''}; ` +
          `dropped ${dropped} chunk${dropped === 1 ? '' : 's'}. Try a smaller Whisper model.`,
      );
    }
  }

  private pump(): Promise<void> {
    if (this.pumping) return this.pumping;
    if (this.disposed || this.queue.length === 0) return Promise.resolve();
    this.pumping = this.drain();
    return this.pumping;
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0 && !this.disposed) {
        const chunk = this.queue.shift()!;
        this.queuedSeconds -= chunk.audioEnd - chunk.audioStart;
        await this.transcribe(chunk);
      }
    } catch (err) {
      this.report(err);
    } finally {
      this.pumping = null;
    }
  }

  private async transcribe(chunk: SpeechChunk): Promise<void> {
    const engine = chunk.preview ? this.previewEngine : this.engine;
    if (!engine) return;
    // A preview that waited through a completed chunk describes audio that is
    // already captioned, and carries the same id as the chunk that captioned
    // it. Emitting it would put provisional text back over a finished line.
    if (chunk.preview && chunk.audioEnd <= this.lastChunkEnd) return;
    if (!chunk.preview) this.lastChunkEnd = Math.max(this.lastChunkEnd, chunk.audioEnd);
    const previous = this.open.get(chunk.utterance);
    // The silence detector can close inside the previous chunk's padding.
    // That tail contains no new audio; transcribing it invents another line.
    if (previous && chunk.audioEnd <= previous.audioEnd) {
      if (chunk.final) this.open.delete(chunk.utterance);
      return;
    }
    const seconds = chunk.audioEnd - chunk.audioStart;

    // Detection is a forward pass of its own and happens on every chunk until
    // a long enough one locks the language in. Timing only the decode would
    // report a number the pipeline never actually achieves.
    const started = performance.now();
    let lang = this.lang;
    if (lang === null) {
      const detected = await engine.detectLanguage(chunk.samples);
      if (detected) {
        lang = detected;
        this.options.onLanguage?.(detected);
        if (seconds >= MIN_DETECT_SEC) {
          this.lang = detected;
        }
      }
    }
    // Never caption an undetected language as English just to get a preview.
    if (!lang) return;

    const result = await engine.transcribe(chunk.samples, lang, chunk.audioStart);
    const ms = performance.now() - started;
    const rtf = ms / 1000 / seconds;
    this.rtfs.push(rtf);
    if (this.rtfs.length > 20) this.rtfs.shift();

    const id = `u${chunk.utterance}-${chunk.index}`;
    this.options.onMetrics?.({ stage: 'asr', ms, rtf, segmentId: id });

    const verdict = classifySegment({
      text: result.text,
      audioSeconds: seconds,
      meanProb: chunk.meanProb,
      energy: rms(chunk.samples),
    });
    if (this.disposed) return;
    if (chunk.final) this.open.delete(chunk.utterance);
    if (!verdict.keep) return;

    // Finalise each bounded chunk: waiting for a pause can delay translation
    // and dubbing indefinitely. Keep only the last chunk to remove overlap.
    const text = dedupeOverlap(previous?.text ?? '', result.text);
    if (!chunk.final && !chunk.preview) this.open.set(chunk.utterance, { text: result.text, audioEnd: chunk.audioEnd });
    if (!text) return;
    const audioStart = Math.max(chunk.audioStart, previous?.audioEnd ?? chunk.audioStart);
    const segment: Segment = {
      id, text, lang, audioStart, audioEnd: chunk.audioEnd, interim: chunk.preview === true,
      words: result.words.filter((w) => w.end > audioStart),
    };
    for (const cb of this.callbacks) cb(segment);
  }

  private report(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.options.onError?.(message);
  }
}
