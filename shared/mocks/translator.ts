/**
 * Stand-in for the real translators (owned by C). Deterministic: the output
 * is the input tagged with the target language, so a test can assert on it.
 */

import type { Gloss, Translator } from '../interfaces.js';

export interface MockTranslatorOptions {
  /** Fake per-call latency, ms. */
  latencyMs?: number;
  /** What `available` reports, to exercise the download and fallback paths. */
  availability?: 'yes' | 'download' | 'no';
  name?: string;
}

export class MockTranslator implements Translator {
  readonly name: string;
  private readonly latencyMs: number;
  private readonly availability: 'yes' | 'download' | 'no';
  /** Every translate() call, for assertions. */
  readonly calls: { text: string; context: string[]; src: string; tgt: string }[] = [];

  constructor(options: MockTranslatorOptions = {}) {
    this.name = options.name ?? 'mock';
    this.latencyMs = options.latencyMs ?? 0;
    this.availability = options.availability ?? 'yes';
  }

  async available(_src: string, _tgt: string): Promise<'yes' | 'download' | 'no'> {
    return this.availability;
  }

  async translate(text: string, context: string[], src: string, tgt: string): Promise<string> {
    this.calls.push({ text, context, src, tgt });
    await this.wait();
    return `[${tgt}] ${text}`;
  }

  async gloss(word: string, _sentence: string, _src: string, tgt: string): Promise<Gloss> {
    await this.wait();
    return { word, translation: `[${tgt}] ${word}`, pos: 'noun' };
  }

  private wait(): Promise<void> {
    return this.latencyMs > 0
      ? new Promise((r) => setTimeout(r, this.latencyMs))
      : Promise.resolve();
  }
}
