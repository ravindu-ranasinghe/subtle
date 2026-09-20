/**
 * Spoken translation over the original audio, using the platform's own
 * voices. No model download, no network — `speechSynthesis` is available in an
 * offscreen document (measured, see e2e/env.spec.ts).
 *
 * While a dub plays the original is ducked rather than silenced, so the
 * speaker's rhythm and emotion are still audible underneath.
 */

import type { Dubber } from '@subtle/shared';
import { compressionRate, estimateSpeechSeconds, pickVoice, schedule } from './speech.js';

/** How far the original is pulled down while a dub is speaking. */
export const DUCK_GAIN = 0.18;
/** Ramp either side of a dub, so the level change is not a click. */
const DUCK_RAMP_SEC = 0.12;

export interface DubberOptions {
  /** The AudioContext clock the caller schedules against. */
  now: () => number;
  /** Ducks the original. Called with DUCK_GAIN before speaking and 1 after. */
  onDuck?: (gain: number, rampSeconds: number) => void;
  /** Injected by tests; defaults to the platform's. */
  synth?: SpeechSynthesis;
  onError?: (message: string) => void;
  makeUtterance?: (text: string) => SpeechSynthesisUtterance;
}

export class SpeechDubber implements Dubber {
  private readonly options: DubberOptions;
  private readonly synth: SpeechSynthesis | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  /** Resolves the in-flight speak() if it is cancelled. */
  private finish: (() => void) | null = null;

  constructor(options: DubberOptions) {
    this.options = options;
    this.synth = options.synth ?? (typeof speechSynthesis !== 'undefined' ? speechSynthesis : null);
  }

  get available(): boolean {
    return this.synth !== null;
  }

  get speaking(): boolean {
    return this.active;
  }

  /**
   * Speaks `text` starting at `atAudioTime`, compressed to fit `maxDuration`.
   * Resolves when playback ends, is cancelled, or is judged too late to be
   * worth starting — never rejects, because a missed dub must not take the
   * caption down with it.
   */
  speak(text: string, lang: string, atAudioTime: number, maxDuration: number): Promise<void> {
    this.stop();
    const synth = this.synth;
    const trimmed = text.trim();
    if (!synth || !trimmed) return Promise.resolve();

    const { delay, worthSpeaking } = schedule(atAudioTime, this.options.now(), maxDuration);
    if (!worthSpeaking) return Promise.resolve();

    return new Promise<void>((resolve) => {
      // Settled is per-promise rather than read off instance state: stop()
      // clears that state before calling in, so an instance-level guard would
      // swallow its own resolve and leave the caller awaiting forever.
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        this.active = false;
        if (this.finish === done) this.finish = null;
        this.options.onDuck?.(1, DUCK_RAMP_SEC);
        resolve();
      };
      this.finish = done;

      this.timer = setTimeout(() => {
        this.timer = null;
        const utterance = this.options.makeUtterance
          ? this.options.makeUtterance(trimmed)
          : new SpeechSynthesisUtterance(trimmed);
        utterance.lang = lang;
        utterance.rate = compressionRate(estimateSpeechSeconds(trimmed), maxDuration);
        const voice = pickVoice(synth.getVoices(), lang);
        if (!voice) {
          done();
          this.options.onError?.(`No on-device ${lang} voice is installed. Add a voice in your system speech settings.`);
          return;
        }
        utterance.voice = voice;
        utterance.onend = done;
        utterance.onerror = (event) => {
          done();
          if (event.error !== 'canceled' && event.error !== 'interrupted') {
            this.options.onError?.(`Speech playback failed: ${event.error}`);
          }
        };

        this.active = true;
        this.options.onDuck?.(DUCK_GAIN, DUCK_RAMP_SEC);
        try {
          synth.speak(utterance);
        } catch (err) {
          done();
          this.options.onError?.(err instanceof Error ? err.message : String(err));
        }
      }, delay * 1000);
    });
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.synth?.cancel();
    const finish = this.finish;
    this.finish = null;
    this.active = false;
    // done() unducks and resolves; it is idempotent.
    finish?.();
  }
}

/**
 * Voices load asynchronously and `getVoices()` is empty until they do, which
 * is why a first dub often has the wrong accent. Resolves once they arrive.
 */
export function voicesReady(synth: SpeechSynthesis = speechSynthesis, timeoutMs = 3000): Promise<number> {
  if (synth.getVoices().length > 0) return Promise.resolve(synth.getVoices().length);
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      synth.removeEventListener('voiceschanged', done);
      resolve(synth.getVoices().length);
    };
    synth.addEventListener('voiceschanged', done);
    const timer = setTimeout(done, timeoutMs);
  });
}
