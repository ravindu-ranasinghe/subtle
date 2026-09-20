import { describe, expect, it, vi } from 'vitest';
import { MockTranslator } from '@subtle/shared/mocks';
import type { Gloss, Translator } from '@subtle/shared';
import { LanguagePackRequiredError, TranslationService } from './index.js';

/** A Translator whose availability and failures are scriptable. */
class StubTranslator implements Translator {
  translated: { text: string; context: string[] }[] = [];
  glossed: string[] = [];
  constructor(
    readonly name: string,
    private readonly availability: 'yes' | 'download' | 'no' = 'yes',
    private readonly failWith?: Error,
  ) {}
  async available(): Promise<'yes' | 'download' | 'no'> {
    return this.availability;
  }
  async translate(text: string, context: string[]): Promise<string> {
    if (this.failWith) throw this.failWith;
    this.translated.push({ text, context });
    return `${this.name}:${text}`;
  }
  async gloss(word: string): Promise<Gloss> {
    if (this.failWith) throw this.failWith;
    this.glossed.push(word);
    return { word, translation: `${this.name}:${word}` };
  }
}

describe('backend selection', () => {
  it('prefers Chrome when it can serve the pair without downloading', async () => {
    const chrome = new StubTranslator('chrome-translator', 'yes');
    const local = new StubTranslator('local-mt', 'yes');
    const service = new TranslationService({ chrome, local });

    expect(await service.translate('hola', [], 'es', 'en')).toBe('chrome-translator:hola');
    expect(service.active).toBe('chrome-translator');
    expect(local.translated).toHaveLength(0);
  });

  it('falls back to local MT when Chrome would need a download', async () => {
    const chrome = new StubTranslator('chrome-translator', 'download');
    const local = new StubTranslator('local-mt', 'yes');
    const service = new TranslationService({ chrome, local });

    expect(await service.translate('hola', [], 'es', 'en')).toBe('local-mt:hola');
    expect(service.active).toBe('local-mt');
  });

  it('offers a pack during fallback and switches to Chrome after installation', async () => {
    const chrome = new StubTranslator('chrome-translator', 'download');
    const required = vi.fn();
    const service = new TranslationService({ chrome, local: new StubTranslator('local-mt'), onLanguagePackRequired: required });
    await service.translate('hola', [], 'es', 'en');
    expect(required).toHaveBeenCalledWith('es', 'en');
    vi.spyOn(chrome, 'available').mockResolvedValue('yes');
    service.resetContext();
    expect(await service.translate('adios', [], 'es', 'en')).toBe('chrome-translator:adios');
  });

  it('falls back to local MT when Chrome cannot do the pair at all', async () => {
    const service = new TranslationService({
      chrome: new StubTranslator('chrome-translator', 'no'),
      local: new StubTranslator('local-mt', 'yes'),
    });
    expect(await service.translate('hola', [], 'es', 'ja')).toBe('local-mt:hola');
  });

  it('uses local MT when Chrome is not in this context at all', async () => {
    const service = new TranslationService({ chrome: null, local: new StubTranslator('local-mt') });
    expect(await service.translate('hola', [], 'es', 'en')).toBe('local-mt:hola');
    expect(service.active).toBe('local-mt');
  });

  it('decides once per pair rather than per line', async () => {
    const chrome = new StubTranslator('chrome-translator', 'yes');
    const spy = vi.spyOn(chrome, 'available');
    const service = new TranslationService({ chrome, local: null });

    await service.translate('uno', [], 'es', 'en');
    await service.translate('dos', [], 'es', 'en');
    await service.translate('tres', [], 'es', 'en');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('decides separately for a different pair', async () => {
    const chrome = new StubTranslator('chrome-translator', 'yes');
    const local = new StubTranslator('local-mt', 'yes');
    const service = new TranslationService({ chrome, local });
    await service.translate('hola', [], 'es', 'en');
    await service.translate('hola', [], 'es', 'ja');
    expect(chrome.translated.map((t) => t.text)).toEqual(['hola', 'hola']);
  });

  it('reports availability as the best of both backends', async () => {
    expect(
      await new TranslationService({
        chrome: new StubTranslator('c', 'no'),
        local: new StubTranslator('l', 'download'),
      }).available('es', 'en'),
    ).toBe('download');

    expect(
      await new TranslationService({
        chrome: new StubTranslator('c', 'download'),
        local: new StubTranslator('l', 'yes'),
      }).available('es', 'en'),
    ).toBe('yes');

    expect(
      await new TranslationService({
        chrome: new StubTranslator('c', 'no'),
        local: new StubTranslator('l', 'no'),
      }).available('es', 'en'),
    ).toBe('no');
  });
});

describe('language pack gesture requirement', () => {
  it('reports it and retries on local MT', async () => {
    const chrome = new StubTranslator('chrome-translator', 'yes', new LanguagePackRequiredError('es', 'en'));
    const local = new StubTranslator('local-mt', 'yes');
    const required: [string, string][] = [];
    const service = new TranslationService({
      chrome,
      local,
      onLanguagePackRequired: (src, tgt) => required.push([src, tgt]),
    });

    expect(await service.translate('hola', [], 'es', 'en')).toBe('local-mt:hola');
    expect(required).toEqual([['es', 'en']]);
  });

  it('rethrows when there is nothing to fall back to', async () => {
    const service = new TranslationService({
      chrome: new StubTranslator('chrome-translator', 'yes', new LanguagePackRequiredError('es', 'en')),
      local: null,
    });
    await expect(service.translate('hola', [], 'es', 'en')).rejects.toThrow(LanguagePackRequiredError);
  });

  it('does not swallow other errors', async () => {
    const service = new TranslationService({
      chrome: new StubTranslator('chrome-translator', 'yes', new Error('network is down')),
      local: new StubTranslator('local-mt', 'yes'),
    });
    await expect(service.translate('hola', [], 'es', 'en')).rejects.toThrow('network is down');
  });
});

describe('cache', () => {
  it('serves a repeat of the same text without calling the backend again', async () => {
    const chrome = new StubTranslator('chrome-translator', 'yes');
    const service = new TranslationService({ chrome, local: null });

    expect(await service.translate('hola', [], 'es', 'en')).toBe('chrome-translator:hola');
    expect(await service.translate('hola', [], 'es', 'en')).toBe('chrome-translator:hola');
    expect(chrome.translated).toHaveLength(1);
  });

  it('keys on the language pair as well as the text', async () => {
    const chrome = new StubTranslator('chrome-translator', 'yes');
    const service = new TranslationService({ chrome, local: null });
    await service.translate('hola', [], 'es', 'en');
    await service.translate('hola', [], 'es', 'de');
    expect(chrome.translated).toHaveLength(2);
  });

  it('ignores surrounding whitespace', async () => {
    const chrome = new StubTranslator('chrome-translator', 'yes');
    const service = new TranslationService({ chrome, local: null });
    await service.translate('hola', [], 'es', 'en');
    await service.translate('  hola  ', [], 'es', 'en');
    expect(chrome.translated).toHaveLength(1);
  });

  it('short-circuits when source and target match', async () => {
    const chrome = new StubTranslator('chrome-translator', 'yes');
    const service = new TranslationService({ chrome, local: null });
    expect(await service.translate('hello', [], 'en', 'en')).toBe('hello');
    expect(chrome.translated).toHaveLength(0);
  });

  it('returns empty for empty input without touching a backend', async () => {
    const chrome = new StubTranslator('chrome-translator', 'yes');
    const service = new TranslationService({ chrome, local: null });
    expect(await service.translate('   ', [], 'es', 'en')).toBe('');
    expect(chrome.translated).toHaveLength(0);
  });
});

describe('context', () => {
  it('passes the caller’s context through', async () => {
    const chrome = new StubTranslator('chrome-translator', 'yes');
    const service = new TranslationService({ chrome, local: null });
    await service.translate('tres', ['uno', 'dos'], 'es', 'en');
    expect(chrome.translated[0]!.context).toEqual(['uno', 'dos']);
  });

  it('carries the previous finals when the caller gives none', async () => {
    const chrome = new StubTranslator('chrome-translator', 'yes');
    const service = new TranslationService({ chrome, local: null });
    await service.translate('uno', [], 'es', 'en');
    await service.translate('dos', [], 'es', 'en');
    await service.translate('tres', [], 'es', 'en');
    expect(chrome.translated.at(-1)!.context).toEqual(['uno', 'dos']);
  });

  it('carries at most three lines', async () => {
    const chrome = new StubTranslator('chrome-translator', 'yes');
    const service = new TranslationService({ chrome, local: null });
    for (const t of ['a', 'b', 'c', 'd', 'e']) await service.translate(t, [], 'es', 'en');
    expect(chrome.translated.at(-1)!.context).toEqual(['b', 'c', 'd']);
  });

  it('forgets the context on reset, as after a seek', async () => {
    const chrome = new StubTranslator('chrome-translator', 'yes');
    const service = new TranslationService({ chrome, local: null });
    await service.translate('uno', [], 'es', 'en');
    service.resetContext();
    await service.translate('dos', [], 'es', 'en');
    expect(chrome.translated.at(-1)!.context).toEqual([]);
  });
});

describe('gloss', () => {
  it('goes to the selected backend', async () => {
    const chrome = new StubTranslator('chrome-translator', 'yes');
    const service = new TranslationService({ chrome, local: null });
    expect(await service.gloss('banco', 'El banco está cerrado.', 'es', 'en')).toEqual({
      word: 'banco',
      translation: 'chrome-translator:banco',
    });
  });

  it('falls back to the MockTranslator standing in for local MT', async () => {
    const service = new TranslationService({
      chrome: new StubTranslator('chrome-translator', 'download'),
      local: new MockTranslator({ name: 'local-mt' }),
    });
    expect(await service.gloss('banco', 'El banco está cerrado.', 'es', 'en')).toEqual({
      word: 'banco',
      translation: '[en] banco',
      pos: 'noun',
    });
    expect(service.active).toBe('local-mt');
  });

  it('retries a gloss on local MT when Chrome wants a gesture', async () => {
    const service = new TranslationService({
      chrome: new StubTranslator('chrome-translator', 'yes', new LanguagePackRequiredError('es', 'en')),
      local: new MockTranslator({ name: 'local-mt' }),
    });
    expect((await service.gloss('banco', 'El banco.', 'es', 'en')).translation).toBe('[en] banco');
  });
});

describe('metrics', () => {
  it('times translate and gloss', async () => {
    const seen: { stage: string; ms: number }[] = [];
    const service = new TranslationService({
      chrome: new StubTranslator('chrome-translator', 'yes'),
      local: null,
      onMetrics: (m) => seen.push(m),
    });
    await service.translate('hola', [], 'es', 'en');
    await service.gloss('hola', 'hola mundo', 'es', 'en');
    expect(seen).toHaveLength(2);
    expect(seen.every((m) => m.stage === 'translate')).toBe(true);
    expect(seen.every((m) => m.ms >= 0)).toBe(true);
  });

  it('does not time a cache hit', async () => {
    const seen: unknown[] = [];
    const service = new TranslationService({
      chrome: new StubTranslator('chrome-translator', 'yes'),
      local: null,
      onMetrics: (m) => seen.push(m),
    });
    await service.translate('hola', [], 'es', 'en');
    await service.translate('hola', [], 'es', 'en');
    expect(seen).toHaveLength(1);
  });
});

it('does not retranslate history for a preview or remember its unfinished text', async () => {
  const backend = new StubTranslator('local-mt');
  const service = new TranslationService({ chrome: null, local: backend });
  await service.translate('first', [], 'es', 'en');
  await service.translate('unfinished', ['first'], 'es', 'en', false);
  expect(backend.translated.at(-1)!.context).toEqual([]);
  await service.translate('finished', [], 'es', 'en');
  expect(backend.translated.at(-1)!.context).toEqual(['first']);
});
