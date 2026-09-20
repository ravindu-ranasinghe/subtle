import type { Dubber } from '@subtle/shared';
import { SpeechDubber, voicesReady, DUCK_GAIN } from './dubber.js';
import { supportsNeuralVoice } from './speech.js';

interface Audio { samples: Float32Array; sampleRate: number }
interface Line {
  text: string; lang: string; at: number; budget: number; revision: number; done: () => void;
}
interface Options {
  context: () => AudioContext | null;
  onDuck: (gain: number, ramp: number) => void;
  onStatus: (text: string) => void;
  onError: (text: string) => void;
}

/** One playing phrase, one being synthesized, and the latest pending caption.
 * Ordinary updates finish the current phrase; pause/seek/stop cancel it.
 * ponytail: latest pending wins if speech outpaces the voice; no unbounded dub queue.
 */
export class NeuralDubber implements Dubber {
  private worker: Worker | null = null;
  private ready = false;
  private failed = false;
  private revision = 0;
  private nextId = 0;
  private pending: Line | null = null;
  private draining = false;
  private playback: Promise<void> = Promise.resolve();
  private endPlayback: (() => void) | null = null;
  private readonly outstanding = new Set<() => void>();
  private request: { id: number; resolve: (audio: Audio) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly fallback: SpeechDubber;

  constructor(private readonly options: Options) {
    this.fallback = new SpeechDubber({
      now: () => options.context()?.currentTime ?? 0,
      onDuck: options.onDuck, onError: options.onError,
    });
  }

  prepare(lang: string): void {
    if (!supportsNeuralVoice(lang)) {
      this.options.onStatus('System voice for this language.');
      return;
    }
    if (this.ready) { this.options.onStatus('Neural voice ready · Supertonic 3'); return; }
    if (this.worker || this.failed) return;
    this.options.onStatus('Loading neural voice… System voice is available while it loads.');
    this.worker = new Worker(chrome.runtime.getURL('workers/tts.js'), { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'tts:status') this.options.onStatus(data.text);
      if (data.type === 'tts:ready') {
        this.ready = true;
        this.options.onStatus('Neural voice ready · Supertonic 3');
      }
      if (data.type === 'tts:error') this.fail(data.message);
      if (data.type === 'tts:audio' && this.request && data.id === this.request.id) {
        clearTimeout(this.request.timer);
        this.request.resolve(data as Audio);
        this.request = null;
      }
    };
    this.worker.onerror = (event) => this.fail(event.message || 'Neural voice worker failed.');
    this.worker.postMessage({ type: 'tts:load' });
  }

  speak(text: string, lang: string, at: number, budget: number): Promise<void> {
    if (!text.trim()) return Promise.resolve();
    this.prepare(lang);
    this.pending?.done();
    return new Promise((resolve) => {
      const done = (): void => { this.outstanding.delete(done); resolve(); };
      this.outstanding.add(done);
      this.pending = { text, lang, at, budget, revision: this.revision, done };
      void this.drain();
    });
  }

  stop(): void {
    this.revision++;
    this.pending = null;
    this.endPlayback?.();
    this.fallback.stop();
    for (const done of this.outstanding) done();
    this.options.onDuck(1, 0.12);
  }

  dispose(): void {
    this.stop();
    this.worker?.terminate();
    this.worker = null;
    if (this.request) {
      clearTimeout(this.request.timer);
      this.request.reject(new Error('Voice stopped.'));
      this.request = null;
    }
  }

  private valid(line: Line): boolean {
    const ctx = this.options.context();
    return line.revision === this.revision && !!ctx && ctx.state !== 'closed' && ctx.currentTime - line.at < 4;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending) {
        const line = this.pending;
        this.pending = null;
        try {
          let audio: Audio | null = null;
          if (this.ready && supportsNeuralVoice(line.lang)) {
            try { audio = await this.generate(line); } catch { /* fail() selected the system fallback */ }
          }
          await this.playback;
          if (!this.valid(line)) { line.done(); continue; }
          if (audio) this.playback = this.play(audio).finally(line.done);
          else {
            await voicesReady();
            if (!this.valid(line)) { line.done(); continue; }
            this.playback = this.fallback.speak(line.text, line.lang, this.options.context()!.currentTime, line.budget).finally(line.done);
          }
        } catch (error) {
          line.done();
          this.options.onError(String(error));
        }
      }
    } finally { this.draining = false; }
  }

  private generate(line: Line): Promise<Audio> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => this.fail('Neural voice took too long.'), 15_000);
      this.request = { id, resolve, reject, timer };
      this.worker!.postMessage({ type: 'tts:speak', id, text: line.text, lang: line.lang, budget: line.budget });
    });
  }

  private play(audio: Audio): Promise<void> {
    const ctx = this.options.context()!;
    const buffer = ctx.createBuffer(1, audio.samples.length, audio.sampleRate);
    buffer.copyToChannel(Float32Array.from(audio.samples), 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    return new Promise((resolve) => {
      let ended = false;
      const done = (): void => {
        if (ended) return;
        ended = true;
        source.disconnect();
        this.endPlayback = null;
        this.options.onDuck(1, 0.12);
        resolve();
      };
      source.onended = done;
      this.endPlayback = () => { source.stop(); done(); };
      this.options.onDuck(DUCK_GAIN, 0.12);
      try { source.start(); } catch (error) { done(); this.options.onError(String(error)); }
    });
  }

  private fail(message: string): void {
    this.ready = false;
    this.failed = true;
    this.worker?.terminate();
    this.worker = null;
    if (this.request) {
      clearTimeout(this.request.timer);
      this.request.reject(new Error(message));
      this.request = null;
    }
    this.options.onStatus(`Using a system voice: ${message}`);
  }
}
