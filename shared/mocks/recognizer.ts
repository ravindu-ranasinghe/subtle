/**
 * Scripted stand-in for the real Whisper recognizer (owned by B).
 * Emits segments on a timer so downstream work — translation, overlay,
 * timing — can be built and tested before any model exists.
 */

import type { ProgressFn, SpeechRecognizer, WhisperSize } from '../interfaces.js';
import type { AudioChunk, Segment, Word } from '../messages.js';

export interface ScriptedLine {
  text: string;
  /** Seconds, relative to the first pushed audio chunk. */
  start: number;
  end: number;
  lang?: string;
}

export const DEFAULT_SCRIPT: readonly ScriptedLine[] = [
  { text: 'Guten Morgen, wie geht es dir?', start: 0.2, end: 2.0, lang: 'de' },
  { text: 'Mir geht es gut, danke der Nachfrage.', start: 2.4, end: 4.6, lang: 'de' },
  { text: 'Wollen wir heute Abend ins Kino gehen?', start: 5.0, end: 7.4, lang: 'de' },
];

export interface MockRecognizerOptions {
  /** Wall-clock multiplier. 0 emits everything on the next tick. */
  speed?: number;
  /** Emit a half-finished interim segment before each final one. */
  interim?: boolean;
  /** Fake model download duration, ms. */
  loadMs?: number;
}

/** Split a line's span evenly across its words. Good enough for karaoke UI work. */
function wordsFor(line: ScriptedLine, offset: number): Word[] {
  const parts = line.text.split(' ');
  const step = (line.end - line.start) / parts.length;
  return parts.map((w, i) => ({
    w,
    start: offset + line.start + i * step,
    end: offset + line.start + (i + 1) * step,
  }));
}

export class MockRecognizer implements SpeechRecognizer {
  private cbs: ((s: Segment) => void)[] = [];
  private timers: ReturnType<typeof setTimeout>[] = [];
  private anchor: number | null = null;
  private loaded = false;
  private readonly speed: number;
  private readonly interim: boolean;
  private readonly loadMs: number;

  constructor(
    private readonly script: readonly ScriptedLine[] = DEFAULT_SCRIPT,
    options: MockRecognizerOptions = {},
  ) {
    this.speed = options.speed ?? 1;
    this.interim = options.interim ?? true;
    this.loadMs = options.loadMs ?? 0;
  }

  async load(_model: WhisperSize, onProgress: ProgressFn): Promise<void> {
    const steps = 4;
    for (let i = 1; i <= steps; i++) {
      if (this.loadMs > 0) await new Promise((r) => setTimeout(r, this.loadMs / steps));
      onProgress((i / steps) * 1e6, 1e6);
    }
    this.loaded = true;
  }

  /** Ignores the audio; the first chunk only anchors the script to the audio clock. */
  pushAudio(chunk: AudioChunk): void {
    if (this.anchor !== null) return;
    this.anchor = chunk.audioStart;
    if (this.loaded) this.schedule(chunk.audioStart);
  }

  onSegment(cb: (s: Segment) => void): void {
    this.cbs.push(cb);
  }

  dispose(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.cbs = [];
  }

  private schedule(offset: number): void {
    this.script.forEach((line, i) => {
      const id = `mock-${i}`;
      const words = wordsFor(line, offset);
      if (this.interim) {
        const mid = line.start + (line.end - line.start) / 2;
        const half = Math.max(1, Math.ceil(line.text.split(' ').length / 2));
        this.at(mid, () =>
          this.emit({
            id,
            text: line.text.split(' ').slice(0, half).join(' '),
            lang: line.lang ?? 'de',
            audioStart: offset + line.start,
            audioEnd: offset + mid,
            words: words.slice(0, half),
            interim: true,
          }),
        );
      }
      this.at(line.end, () =>
        this.emit({
          id,
          text: line.text,
          lang: line.lang ?? 'de',
          audioStart: offset + line.start,
          audioEnd: offset + line.end,
          words,
          interim: false,
        }),
      );
    });
  }

  private at(seconds: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, this.speed > 0 ? (seconds / this.speed) * 1000 : 0));
  }

  private emit(s: Segment): void {
    for (const cb of this.cbs) cb(s);
  }
}
