import { describe, expect, it } from 'vitest';
import { toAnki, toCSV, type SavedWord } from './saved.js';

const base: SavedWord = {
  word: 'Morgen',
  sentence: 'Guten Morgen, wie geht es dir?',
  translation: 'morning',
  pos: 'noun',
  url: 'https://example.com/watch?v=1',
  videoTime: 92.5,
  savedAt: Date.UTC(2026, 8, 19, 12, 0, 0),
};

describe('toCSV', () => {
  it('writes a header and one CRLF-terminated row per word', () => {
    const lines = toCSV([base]).split('\r\n');
    expect(lines[0]).toBe('word,translation,pos,sentence,url,videoTime,savedAt');
    expect(lines[1]).toBe(
      'Morgen,morning,noun,"Guten Morgen, wie geht es dir?",https://example.com/watch?v=1,92.50,2026-09-19T12:00:00.000Z',
    );
  });

  it('quotes a field containing a comma', () => {
    expect(toCSV([base]).includes('"Guten Morgen, wie geht es dir?"')).toBe(true);
  });

  it('doubles embedded quotes', () => {
    const row = toCSV([{ ...base, sentence: 'He said "hello" loudly' }]).split('\r\n')[1]!;
    expect(row).toContain('"He said ""hello"" loudly"');
  });

  it('quotes a field containing a newline rather than breaking the row', () => {
    const csv = toCSV([{ ...base, sentence: 'first line\nsecond line' }]);
    expect(csv.split('\r\n')).toHaveLength(2);
    expect(csv).toContain('"first line\nsecond line"');
  });

  it('leaves a missing part of speech empty', () => {
    const { pos: _pos, ...withoutPos } = base;
    expect(toCSV([withoutPos]).split('\r\n')[1]).toContain('Morgen,morning,,');
  });

  it('emits just the header for no words', () => {
    expect(toCSV([])).toBe('word,translation,pos,sentence,url,videoTime,savedAt');
  });
});

describe('toAnki', () => {
  it('writes four tab-separated fields and no header', () => {
    const fields = toAnki([base]).split('\t');
    expect(fields).toHaveLength(4);
    expect(fields[0]).toBe('Morgen');
    expect(fields[1]).toBe('morning (noun)');
    expect(fields[2]).toBe('Guten Morgen, wie geht es dir?');
    expect(fields[3]).toBe('https://example.com/watch?v=1#t=93');
  });

  it('omits the part of speech when there is none', () => {
    const { pos: _pos, ...withoutPos } = base;
    expect(toAnki([withoutPos]).split('\t')[1]).toBe('morning');
  });

  it('replaces a tab inside a field so the columns do not shift', () => {
    const line = toAnki([{ ...base, sentence: 'has\ta tab' }]);
    expect(line.split('\t')).toHaveLength(4);
    expect(line).toContain('has a tab');
  });

  it('replaces a newline with a break so one note stays one line', () => {
    const line = toAnki([{ ...base, sentence: 'first\nsecond' }]);
    expect(line.split('\n')).toHaveLength(1);
    expect(line).toContain('first<br>second');
  });

  it('writes one line per word', () => {
    expect(toAnki([base, { ...base, word: 'Abend' }]).split('\n')).toHaveLength(2);
  });

  it('is empty for no words', () => {
    expect(toAnki([])).toBe('');
  });
});
