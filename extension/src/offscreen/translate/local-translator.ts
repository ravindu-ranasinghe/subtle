/**
 * Offscreen-side proxy for the MT worker. The models run there; this is the
 * request/response half.
 */

import type { Gloss, Translator as TranslatorContract } from '@subtle/shared';
import type { MtRequest, MtResponse } from '../../workers/mt/index.js';

interface Pending {
  resolve: (value: string) => void;
  reject: (err: Error) => void;
}

export class LocalMTTranslator implements TranslatorContract {
  readonly name = 'local-mt';
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  /** The worker is spawned by the offscreen document and handed in. */
  constructor(private readonly worker: Worker) {
    worker.addEventListener('message', this.onMessage);
  }

  private readonly onMessage = (event: MessageEvent): void => {
    const data = event.data as MtResponse & { type?: string };
    if (data?.type === 'mt:result' || data?.type === 'mt:availability') {
      const waiting = this.pending.get(data.id);
      if (!waiting) return;
      this.pending.delete(data.id);
      waiting.resolve(data.type === 'mt:result' ? data.value : data.value);
      return;
    }
    if (data?.type === 'mt:error') {
      const waiting = this.pending.get(data.id);
      if (!waiting) return;
      this.pending.delete(data.id);
      waiting.reject(new Error(data.message));
    }
  };

  async available(src: string, tgt: string): Promise<'yes' | 'download' | 'no'> {
    const value = await this.request({ type: 'mt:available', id: 0, src, tgt });
    return value as 'yes' | 'download' | 'no';
  }

  translate(text: string, context: string[], src: string, tgt: string): Promise<string> {
    return this.request({ type: 'mt:translate', id: 0, text, context, src, tgt });
  }

  async gloss(word: string, sentence: string, src: string, tgt: string): Promise<Gloss> {
    const translation = await this.request({ type: 'mt:gloss', id: 0, word, sentence, src, tgt });
    // No local model exposes part of speech; see SPIKES.md C.5.
    return { word, translation };
  }

  dispose(): void {
    this.worker.removeEventListener('message', this.onMessage);
    for (const waiting of this.pending.values()) waiting.reject(new Error('translator disposed'));
    this.pending.clear();
  }

  private request(message: MtRequest): Promise<string> {
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id });
    });
  }
}
