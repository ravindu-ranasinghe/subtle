import { describe, expect, it } from 'vitest';
import { NLLB_MODEL, nllbCode, opusModelId } from './engine.js';

describe('opusModelId', () => {
  it('builds the ordinary pair id', () => {
    expect(opusModelId('es', 'en')).toBe('Xenova/opus-mt-es-en');
    expect(opusModelId('fr', 'en')).toBe('Xenova/opus-mt-fr-en');
  });

  it('uses opus-mt’s own spelling for Japanese', () => {
    // Checked against the hub: Xenova/opus-mt-en-ja is 404, -en-jap is 200.
    expect(opusModelId('en', 'ja')).toBe('Xenova/opus-mt-en-jap');
    expect(opusModelId('ja', 'en')).toBe('Xenova/opus-mt-jap-en');
  });
});

describe('nllbCode', () => {
  it('maps the languages we target', () => {
    expect(nllbCode('es')).toBe('spa_Latn');
    expect(nllbCode('fr')).toBe('fra_Latn');
    expect(nllbCode('ja')).toBe('jpn_Jpan');
    expect(nllbCode('en')).toBe('eng_Latn');
    expect(nllbCode('zh')).toBe('zho_Hans');
  });

  it('accepts a region subtag and ignores case', () => {
    expect(nllbCode('es-MX')).toBe('spa_Latn');
    expect(nllbCode('PT-BR')).toBe('por_Latn');
  });

  it('returns null for a language NLLB cannot do', () => {
    expect(nllbCode('xx')).toBeNull();
  });

  it('names the fallback model', () => {
    expect(NLLB_MODEL).toBe('Xenova/nllb-200-distilled-600M');
  });
});
