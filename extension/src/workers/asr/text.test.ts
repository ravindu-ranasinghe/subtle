import { describe, expect, it } from 'vitest';
import {
  LOW_ENERGY_RMS,
  appendDeduped,
  classifySegment,
  dedupeOverlap,
  hasRepetitionLoop,
  rms,
} from './text.js';

describe('dedupeOverlap', () => {
  it('strips a repeated tail of words', () => {
    expect(dedupeOverlap('I went to the shop yesterday', 'the shop yesterday and bought milk')).toBe(
      'and bought milk',
    );
  });

  it('ignores case and punctuation when matching', () => {
    expect(dedupeOverlap('we should go home.', 'Go home, it is late')).toBe('it is late');
  });

  it('prefers the longest overlap', () => {
    // "the" alone also matches, but the four-word match is the real overlap.
    expect(dedupeOverlap('a b c the quick brown fox', 'the quick brown fox jumped')).toBe('jumped');
  });

  it('returns the text unchanged when nothing overlaps', () => {
    expect(dedupeOverlap('completely different', 'nothing in common here')).toBe(
      'nothing in common here',
    );
  });

  it('handles empty input on either side', () => {
    expect(dedupeOverlap('', 'hello there')).toBe('hello there');
    expect(dedupeOverlap('hello there', '')).toBe('');
  });

  it('falls back to characters for text without spaces', () => {
    expect(dedupeOverlap('今日はいい天気ですね', 'いい天気ですね散歩しましょう')).toBe('散歩しましょう');
  });

  it('does not strip a coincidental single word', () => {
    // "the" repeats, but one short token is not evidence of an overlap...
    const out = dedupeOverlap('I saw the', 'the cat');
    expect(out).toBe('cat');
    // ...whereas an unrelated continuation is left alone.
    expect(dedupeOverlap('I saw a bird', 'the cat ran')).toBe('the cat ran');
  });
});

describe('appendDeduped', () => {
  it('joins two overlapping chunks into one sentence', () => {
    expect(appendDeduped('the quick brown fox', 'brown fox jumps over')).toBe(
      'the quick brown fox jumps over',
    );
  });

  it('joins CJK without inserting a space', () => {
    expect(appendDeduped('今日はいい天気', 'いい天気ですね')).toBe('今日はいい天気ですね');
  });

  it('survives a chunk that was entirely overlap', () => {
    expect(appendDeduped('hello world', 'hello world')).toBe('hello world');
  });
});

describe('hasRepetitionLoop', () => {
  it.each([
    ['you you you you'],
    ['la la la la la la'],
    ['thank you thank you thank you thank you'],
    ['the cat the cat the cat the cat the cat'],
  ])('catches %s', (text) => {
    expect(hasRepetitionLoop(text.split(' '))).toBe(true);
  });

  it.each([
    ['the cat sat on the mat'],
    ['very very very good'],
    ['no no no I disagree with that'],
    ['she sells seashells by the sea shore'],
  ])('leaves %s alone', (text) => {
    expect(hasRepetitionLoop(text.split(' '))).toBe(false);
  });
});

describe('classifySegment', () => {
  const loud = { meanProb: 0.9, energy: 0.08 };
  const quiet = { meanProb: 0.3, energy: 0.001 };

  it('keeps ordinary speech', () => {
    expect(classifySegment({ text: 'Guten Morgen, wie geht es dir?', audioSeconds: 2, ...loud })).toEqual({
      keep: true,
    });
  });

  it('drops empty and punctuation-only text', () => {
    expect(classifySegment({ text: '   ', audioSeconds: 2, ...loud }).reason).toBe('empty');
    expect(classifySegment({ text: '...', audioSeconds: 2, ...loud }).reason).toBe('empty');
  });

  it.each([
    ['Thank you.'],
    ['Thanks for watching!'],
    ['ご視聴ありがとうございました'],
    ['Subtitles by the Amara.org community'],
    ['Sous-titres réalisés par la communauté d\'Amara.org'],
    ['[MUSIC]'],
  ])('drops the idle phrase %s on quiet audio', (text) => {
    expect(classifySegment({ text, audioSeconds: 2, ...quiet }).reason).toBe('idle-phrase');
  });

  it('keeps the same phrase when the audio is actually loud speech', () => {
    // Someone really can say "Thank you." — only believe it with energy behind it.
    expect(classifySegment({ text: 'Thank you.', audioSeconds: 1, ...loud }).keep).toBe(true);
  });

  it('drops a repetition loop regardless of energy', () => {
    expect(classifySegment({ text: 'you you you you you', audioSeconds: 3, ...loud }).reason).toBe(
      'repetition-loop',
    );
  });

  it('drops text far longer than the audio could contain', () => {
    const long = 'the quick brown fox jumps over the lazy dog and keeps on running for miles';
    expect(classifySegment({ text: long, audioSeconds: 1, ...loud }).reason).toBe('impossible-rate');
  });

  it('keeps dense but plausible speech', () => {
    // Measured from a macOS TTS clip: 82 chars / 4.7 s.
    const text = 'The quick brown fox jumps over the lazy dog. She sells seashells by the sea shore.';
    expect(classifySegment({ text, audioSeconds: 4.7, ...loud }).keep).toBe(true);
  });

  it('applies a tighter character rate to CJK', () => {
    const ja = 'これはとても長い日本語の文章でありまして実際の音声よりもずっと長いのです';
    expect(classifySegment({ text: ja, audioSeconds: 1, ...loud }).reason).toBe('impossible-rate');
    expect(classifySegment({ text: ja, audioSeconds: 6, ...loud }).keep).toBe(true);
  });
});

describe('rms', () => {
  it('is zero for silence and above the gate for speech-level audio', () => {
    expect(rms(new Float32Array(100))).toBe(0);
    const loud = new Float32Array(1000);
    for (let i = 0; i < loud.length; i++) loud[i] = Math.sin(i / 3) * 0.2;
    expect(rms(loud)).toBeGreaterThan(LOW_ENERGY_RMS);
  });
});
