import { describe, expect, it } from 'vitest';
import type { Caption } from '@subtle/shared';
import { CaptionStore, LINGER_SEC, bareWord, pickActive, splitWords } from './captions.js';

function caption(id: string, start: number, end: number, patch: Partial<Caption> = {}): Caption {
  return {
    id,
    original: `line ${id}`,
    translation: `translated ${id}`,
    srcLang: 'de',
    tgtLang: 'en',
    videoStart: start,
    videoEnd: end,
    interim: false,
    ...patch,
  };
}

describe('pickActive', () => {
  const a = caption('a', 10, 12);
  const b = caption('b', 12.5, 15);

  it('shows the line whose window covers the playhead', () => {
    expect(pickActive([a, b], 11)?.id).toBe('a');
    expect(pickActive([a, b], 13)?.id).toBe('b');
  });

  it('keeps the last line up after its window ends', () => {
    // Captions arrive late, so a blank overlay between lines reads as broken.
    expect(pickActive([a, b], 12.2)?.id).toBe('a');
    expect(pickActive([a, b], 14.9)?.id).toBe('b');
  });

  it('gives up once the linger window passes', () => {
    expect(pickActive([a], 12 + LINGER_SEC - 0.1)?.id).toBe('a');
    expect(pickActive([a], 12 + LINGER_SEC + 0.1)).toBeNull();
  });

  it('never shows a line from later in the video', () => {
    // The user seeked back; b belongs to a part they have not reached again.
    expect(pickActive([a, b], 5)).toBeNull();
    expect(pickActive([a, b], 11)?.id).toBe('a');
  });

  it('prefers the later line when two windows overlap', () => {
    const long = caption('long', 10, 20);
    const short = caption('short', 14, 16);
    expect(pickActive([long, short], 15)?.id).toBe('short');
  });

  it('prefers a covering line over a lingering one', () => {
    expect(pickActive([a, caption('c', 12.1, 14)], 12.2)?.id).toBe('c');
  });

  it('tolerates a line starting a fraction ahead of the playhead', () => {
    expect(pickActive([caption('x', 10.2, 12)], 10)?.id).toBe('x');
    expect(pickActive([caption('x', 11, 12)], 10)).toBeNull();
  });

  it('returns null for an empty store', () => {
    expect(pickActive([], 10)).toBeNull();
  });
});

describe('CaptionStore', () => {
  it('replaces an interim line with the final carrying the same id', () => {
    const store = new CaptionStore();
    store.upsert(caption('u1', 10, 11, { original: 'Guten', interim: true }));
    store.upsert(caption('u1', 10, 12, { original: 'Guten Morgen', interim: false }));

    expect(store.size).toBe(1);
    const active = store.activeAt(11);
    expect(active?.original).toBe('Guten Morgen');
    expect(active?.interim).toBe(false);
  });

  it('keeps separate lines apart', () => {
    const store = new CaptionStore();
    store.upsert(caption('u1', 10, 12));
    store.upsert(caption('u2', 13, 15));
    expect(store.size).toBe(2);
    expect(store.activeAt(14)?.id).toBe('u2');
  });

  it('keeps a ready translation visible while the next original is translating', () => {
    const store = new CaptionStore();
    store.upsert(caption('a', 10, 12));
    store.upsert(caption('b', 12, 14, { translation: '' }));
    expect(store.activeAt(14, true)?.id).toBe('a');
    expect(store.activeAt(14, false)?.id).toBe('b');
    store.upsert(caption('b', 12, 14));
    expect(store.activeAt(14, true)?.id).toBe('b');
    expect(store.activeAt(19, true)).toBeNull();
  });

  it('reports the latest line for replay', () => {
    const store = new CaptionStore();
    store.upsert(caption('u1', 10, 12));
    store.upsert(caption('u2', 20, 22));
    store.upsert(caption('u3', 15, 17));
    expect(store.latest()?.id).toBe('u2');
  });

  it('clears, as on a seek', () => {
    const store = new CaptionStore();
    store.upsert(caption('u1', 10, 12));
    store.clear();
    expect(store.size).toBe(0);
    expect(store.activeAt(11)).toBeNull();
    expect(store.latest()).toBeNull();
  });
});

describe('splitWords', () => {
  it('keeps the spacing so the line rebuilds exactly', () => {
    const text = 'Guten  Morgen, wie geht es dir?';
    expect(splitWords(text).map((w) => w.word + w.after).join('')).toBe(text);
  });

  it('handles a single word and an empty string', () => {
    expect(splitWords('Morgen')).toEqual([{ word: 'Morgen', after: '' }]);
    expect(splitWords('')).toEqual([]);
  });
});

describe('bareWord', () => {
  it('strips punctuation from either end', () => {
    expect(bareWord('Morgen,')).toBe('Morgen');
    expect(bareWord('"dir?"')).toBe('dir');
    expect(bareWord('¿cómo')).toBe('cómo');
  });

  it('leaves letters and digits inside intact', () => {
    expect(bareWord("don't")).toBe("don't");
    expect(bareWord('COVID-19')).toBe('COVID-19');
  });

  it('returns empty for punctuation only', () => {
    expect(bareWord('—')).toBe('');
  });
});

it('keeps a coherent translated preview while the final source awaits translation', () => {
  const store = new CaptionStore();
  store.upsert(caption('a', 10, 11, { original: 'hola', translation: 'hello', interim: true }));
  store.upsert(caption('a', 10, 12, { original: 'hola mundo', translation: '' }));
  expect(store.activeAt(12, true)).toMatchObject({ original: 'hola', translation: 'hello' });
  expect(store.activeAt(12, false)?.original).toBe('hola mundo');
  store.upsert(caption('a', 10, 12, { original: 'hola mundo', translation: 'hello world' }));
  expect(store.activeAt(12, true)).toMatchObject({ original: 'hola mundo', translation: 'hello world' });
  store.clear();
  expect(store.activeAt(12, true)).toBeNull();
});

it('lets a finished line be read before advancing to the next preview', () => {
  const store = new CaptionStore();
  store.upsert(caption('a', 10, 12));
  expect(store.activeAt(12.5, true)?.id).toBe('a');
  store.upsert(caption('b', 12, 13.5, { interim: true }));
  expect(store.activeAt(13, true)?.id).toBe('a');
  expect(store.activeAt(13.6, true)?.id).toBe('b');
  store.upsert(caption('b', 12, 14));
  expect(store.activeAt(13.7, true)).toMatchObject({ id: 'b', interim: false });
});
