/**
 * The three swappable engines. Each is owned by a different worker; everyone
 * else codes against the interface and uses ../mocks until it lands.
 */

import type { AudioChunk, Segment } from './messages.js';

export type WhisperSize = 'tiny' | 'base' | 'small';

export interface Gloss {
  word: string;
  translation: string;
  /** Part of speech, if the backend knows it. */
  pos?: string;
}

export type ProgressFn = (loaded: number, total: number) => void;

export interface SpeechRecognizer {
  load(model: WhisperSize, onProgress: ProgressFn): Promise<void>;
  /** Fire and forget: chunks arrive faster than they are consumed. */
  pushAudio(chunk: AudioChunk): void;
  onSegment(cb: (s: Segment) => void): void;
  dispose(): void;
}

export interface Translator {
  /** For logs and metrics: 'chrome-translator', 'opus-mt', ... */
  name: string;
  /** 'download' means usable but a model must be fetched first. */
  available(src: string, tgt: string): Promise<'yes' | 'download' | 'no'>;
  /** `context` is the preceding lines, most recent last. May be ignored. */
  translate(text: string, context: string[], src: string, tgt: string): Promise<string>;
  gloss(word: string, sentence: string, src: string, tgt: string): Promise<Gloss>;
}

export interface Dubber {
  /**
   * Speak `text` starting at `atAudioTime` on the AudioContext clock,
   * compressed to fit `maxDuration` seconds. Resolves when playback ends.
   */
  speak(text: string, lang: string, atAudioTime: number, maxDuration: number): Promise<void>;
  stop(): void;
}

export interface Config {
  /** BCP-47, or 'auto' to let Whisper detect it. */
  srcLang: string | 'auto';
  tgtLang: string;
  whisperModel: WhisperSize;
  showTranslation: boolean;
  /** Caption font size in px. */
  fontSize: number;
  dubbing: boolean;
}

export const DEFAULT_CONFIG: Config = {
  srcLang: 'auto',
  tgtLang: 'en',
  whisperModel: 'base',
  showTranslation: true,
  fontSize: 28,
  dubbing: false,
};
