import { describe, expect, it } from 'vitest';
import { MAX_RATE, MIN_RATE, compressionRate, estimateSpeechSeconds, pickVoice, schedule } from './speech.js';

describe('estimateSpeechSeconds', () => {
  it('scales with word count for latin scripts', () => {
    const short = estimateSpeechSeconds('Good morning');
    const long = estimateSpeechSeconds('Good morning, how are you today my friend');
    expect(long).toBeGreaterThan(short * 2);
  });

  it('uses characters for CJK, which has no spaces to count', () => {
    expect(estimateSpeechSeconds('おはようございます')).toBeGreaterThan(1);
    expect(estimateSpeechSeconds('おはよう')).toBeLessThan(estimateSpeechSeconds('おはようございます'));
  });

  it('is zero for nothing to say', () => {
    expect(estimateSpeechSeconds('')).toBe(0);
    expect(estimateSpeechSeconds('   ')).toBe(0);
  });

  it('lands in the right ballpark for a real line', () => {
    // "The train arrives at seven" is about six words: roughly two seconds.
    const seconds = estimateSpeechSeconds('The train arrives at seven o clock');
    expect(seconds).toBeGreaterThan(1.5);
    expect(seconds).toBeLessThan(4);
  });
});

describe('compressionRate', () => {
  it('speeds up a translation that would overrun its gap', () => {
    expect(compressionRate(4, 2)).toBe(1.15);
  });

  it('never slows below natural pace to fill a gap', () => {
    expect(compressionRate(1, 10)).toBe(MIN_RATE);
  });

  it('refuses to go faster than a listener can follow', () => {
    // Better to overrun than to gabble.
    expect(compressionRate(20, 1)).toBe(MAX_RATE);
  });

  it('treats a missing budget as no constraint', () => {
    expect(compressionRate(3, 0)).toBe(MIN_RATE);
    expect(compressionRate(3, -1)).toBe(MIN_RATE);
  });
});

describe('pickVoice', () => {
  const voices = [
    { lang: 'en-US', name: 'Samantha' },
    { lang: 'en-GB', name: 'Daniel' },
    { lang: 'es-ES', name: 'Mónica' },
    { lang: 'ja-JP', name: 'Kyoko' },
  ];

  it('prefers an exact tag', () => {
    expect(pickVoice(voices, 'en-GB')?.name).toBe('Daniel');
  });

  it('falls back to the base language', () => {
    expect(pickVoice(voices, 'es')?.name).toBe('Mónica');
    expect(pickVoice(voices, 'es-MX')?.name).toBe('Mónica');
  });

  it('tolerates underscore tags from the platform', () => {
    expect(pickVoice([{ lang: 'ja_JP', name: 'Kyoko' }], 'ja-JP')?.name).toBe('Kyoko');
  });

  it('returns null rather than the wrong language', () => {
    // Speaking German with a Japanese voice is worse than not dubbing.
    expect(pickVoice(voices, 'de')).toBeNull();
    expect(pickVoice([], 'en')).toBeNull();
  });
  it('prefers a natural installed voice over an old novelty voice', () => {
    expect(pickVoice([{ lang: 'en-US', name: 'Albert' }, { lang: 'en-US', name: 'Samantha' }], 'en')?.name).toBe('Samantha');
  });
  it('never chooses a remote voice for on-device dubbing', () => {
    expect(pickVoice([{ lang: 'en-US', name: 'Cloud Neural', localService: false }], 'en')).toBeNull();
  });
});

describe('schedule', () => {
  it('waits for a moment still ahead', () => {
    expect(schedule(12, 10, 2)).toEqual({ delay: 2, worthSpeaking: true });
  });

  it('starts immediately when the moment has just passed', () => {
    expect(schedule(9.5, 10, 2)).toEqual({ delay: 0, worthSpeaking: true });
  });

  it('gives up once it would play over the next line', () => {
    expect(schedule(4, 10, 2).worthSpeaking).toBe(false);
  });

  it('allows at least a second of lateness even for a tiny budget', () => {
    expect(schedule(9.2, 10, 0.1).worthSpeaking).toBe(true);
    expect(schedule(8.5, 10, 0.1).worthSpeaking).toBe(false);
  });
});
