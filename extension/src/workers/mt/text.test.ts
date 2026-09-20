import { describe, expect, it } from 'vitest';
import {
  CONTEXT_SEPARATOR,
  MAX_CONTEXT,
  glossDifference,
  prependContext,
  removeWord,
  sentences,
  stripContext,
} from './text.js';

describe('prependContext', () => {
  it('joins context ahead of the sentence with the separator', () => {
    expect(prependContext('Estaban muy ricas.', ['Ayer fui al mercado.', 'Compré manzanas.'])).toBe(
      `Ayer fui al mercado. Compré manzanas.${CONTEXT_SEPARATOR}Estaban muy ricas.`,
    );
  });

  it('keeps only the most recent lines', () => {
    const many = ['a.', 'b.', 'c.', 'd.', 'e.'];
    const out = prependContext('target.', many);
    expect(out.startsWith('c. d. e.')).toBe(true);
    expect(out.split(' ').filter((w) => w.length === 2)).toHaveLength(MAX_CONTEXT);
  });

  it('returns the text untouched when there is no context', () => {
    expect(prependContext('solo.', [])).toBe('solo.');
    expect(prependContext('solo.', ['  ', ''])).toBe('solo.');
  });
});

describe('stripContext', () => {
  it('returns the last sentence when the count matches', () => {
    const output = 'Yesterday I went to the market. I bought some red apples. They were very good.';
    expect(stripContext(output, 2)).toEqual({ text: 'They were very good.', trusted: true });
  });

  it('removes a separator that leaked through', () => {
    // Observed: opus-mt sometimes emits the marker verbatim.
    const output = 'I have a dog. His name is Max. <sep> It’s very big.';
    expect(stripContext(output, 2)).toEqual({ text: 'It’s very big.', trusted: true });
  });

  it('flags the result as untrusted when a sentence went missing', () => {
    // The real failure: opus-mt dropped the first sentence entirely.
    const output = 'I bought some red apples, they were very good.';
    expect(stripContext(output, 2).trusted).toBe(false);
  });

  it('flags the result as untrusted when the model added a sentence', () => {
    expect(stripContext('One. Two. Three. Four.', 2).trusted).toBe(false);
  });

  it('passes text through when no context was sent', () => {
    expect(stripContext('They were very good.', 0)).toEqual({
      text: 'They were very good.',
      trusted: true,
    });
  });

  it('handles CJK sentence enders', () => {
    expect(stripContext('昨日は市場に行きました。りんごを買いました。とても美味しかったです。', 2)).toEqual({
      text: 'とても美味しかったです。',
      trusted: true,
    });
  });
});

describe('sentences', () => {
  it('splits on terminators and drops empties', () => {
    expect(sentences('One. Two! Three?  ')).toEqual(['One.', 'Two!', 'Three?']);
  });
});

describe('removeWord', () => {
  it('removes a whole word only', () => {
    expect(removeWord('Voy a sentarme en el banco del parque.', 'banco')).toBe(
      'Voy a sentarme en el del parque.',
    );
  });

  it('does not touch a word that merely contains it', () => {
    expect(removeWord('El bancario abrió el banco.', 'banco')).toBe('El bancario abrió el .');
  });

  it('is case insensitive', () => {
    expect(removeWord('Banco está cerrado.', 'banco')).toBe('está cerrado.');
  });
});

describe('glossDifference', () => {
  // All three pairs are real opus-mt output, captured in SPIKES.md C.4.
  it('finds the sense the sentence gives a word', () => {
    expect(glossDifference('They were very good.', 'They were very.')).toBe('good');
  });

  it('picks the content word out of a diff that also moved function words', () => {
    expect(glossDifference("I'm gonna sit on the park bench.", "I'm gonna sit in the park.")).toBe('bench');
  });

  it('disambiguates the other sense of the same source word', () => {
    expect(glossDifference('The bank is closed.', "He's closed.")).toBe('bank');
  });

  it('returns null when nothing was added', () => {
    expect(glossDifference('same words here', 'same words here')).toBeNull();
  });

  it('returns null when removing the word reshaped the whole sentence', () => {
    expect(glossDifference('a completely different sentence appeared out of nowhere', 'x')).toBeNull();
  });
});
