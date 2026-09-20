import { describe, expect, it, vi } from 'vitest';
import { DUCK_GAIN, SpeechDubber } from './dubber.js';

/** Enough of the Web Speech API to drive the dubber without a voice installed. */
function fakeSynth() {
  const spoken: { text: string; lang: string; rate: number; voice: string | null }[] = [];
  let pending: { onend?: () => void; onerror?: () => void } | null = null;
  const synth = {
    spoken,
    cancelled: 0,
    getVoices: () => [{ lang: 'en-US', name: 'Samantha' }] as unknown as SpeechSynthesisVoice[],
    speak(u: SpeechSynthesisUtterance) {
      spoken.push({
        text: u.text,
        lang: u.lang,
        rate: u.rate,
        voice: (u.voice as unknown as { name?: string } | null)?.name ?? null,
      });
      pending = u as unknown as { onend?: () => void; onerror?: () => void };
    },
    cancel() {
      synth.cancelled++;
      pending = null;
    },
    finish() {
      pending?.onend?.();
    },
  };
  return synth;
}

const makeUtterance = (text: string) =>
  ({ text, lang: '', rate: 1, voice: null }) as unknown as SpeechSynthesisUtterance;

function dubber(now: () => number, synth = fakeSynth(), ducks: number[] = []) {
  const d = new SpeechDubber({
    now,
    synth: synth as unknown as SpeechSynthesis,
    makeUtterance,
    onDuck: (g) => ducks.push(g),
  });
  return { d, synth, ducks };
}

describe('SpeechDubber', () => {
  it('speaks at the scheduled moment, ducking the original around it', async () => {
    vi.useFakeTimers();
    try {
      const { d, synth, ducks } = dubber(() => 10);
      const done = d.speak('The train arrives at seven', 'en-US', 12, 2);

      // Nothing yet: the line it belongs to has not come round.
      expect(synth.spoken).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(2000);
      expect(synth.spoken).toHaveLength(1);
      expect(ducks[0]).toBe(DUCK_GAIN);
      expect(d.speaking).toBe(true);

      synth.finish();
      await done;
      expect(ducks.at(-1)).toBe(1);
      expect(d.speaking).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('compresses a long translation into the gap it has', async () => {
    vi.useFakeTimers();
    try {
      const { d, synth } = dubber(() => 0);
      void d.speak('one two three four five six seven eight nine ten', 'en-US', 0, 1);
      await vi.advanceTimersByTimeAsync(10);
      expect(synth.spoken[0]!.rate).toBe(1.15);
    } finally {
      vi.useRealTimers();
    }
  });

  it('picks a voice for the language', async () => {
    vi.useFakeTimers();
    try {
      const { d, synth } = dubber(() => 0);
      void d.speak('hello', 'en-US', 0, 2);
      await vi.advanceTimersByTimeAsync(10);
      expect(synth.spoken[0]!.voice).toBe('Samantha');
      expect(synth.spoken[0]!.lang).toBe('en-US');
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips a dub whose moment has long passed', async () => {
    vi.useFakeTimers();
    try {
      const { d, synth } = dubber(() => 100);
      await d.speak('too late', 'en-US', 90, 2);
      await vi.advanceTimersByTimeAsync(5000);
      // Playing this now would land over a completely different sentence.
      expect(synth.spoken).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says nothing for empty text', async () => {
    const { d, synth } = dubber(() => 0);
    await d.speak('   ', 'en-US', 0, 2);
    expect(synth.spoken).toHaveLength(0);
  });

  it('a new line cancels the one still queued', async () => {
    vi.useFakeTimers();
    try {
      const { d, synth } = dubber(() => 0);
      const first = d.speak('first', 'en-US', 5, 2);
      void d.speak('second', 'en-US', 0, 2);
      await first; // the replaced dub resolves rather than hanging
      await vi.advanceTimersByTimeAsync(50);
      expect(synth.spoken.map((s) => s.text)).toEqual(['second']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop cancels playback and restores the original volume', async () => {
    vi.useFakeTimers();
    try {
      const { d, synth, ducks } = dubber(() => 0);
      const done = d.speak('hello', 'en-US', 0, 2);
      await vi.advanceTimersByTimeAsync(10);
      expect(d.speaking).toBe(true);

      d.stop();
      await done;
      expect(synth.cancelled).toBeGreaterThan(0);
      expect(ducks.at(-1)).toBe(1);
      expect(d.speaking).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not speak in the wrong language when its voice is missing', async () => {
    vi.useFakeTimers();
    try {
      const synth = fakeSynth();
      const onError = vi.fn();
      const d = new SpeechDubber({ now: () => 0, synth: synth as unknown as SpeechSynthesis, makeUtterance, onError });
      const done = d.speak('bonjour', 'fr', 0, 2);
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(synth.spoken).toHaveLength(0);
      expect(onError).toHaveBeenCalledWith(expect.stringContaining('No on-device fr voice'));
    } finally { vi.useRealTimers(); }
  });

  it('restores audio if the platform throws during playback', async () => {
    vi.useFakeTimers();
    try {
      const synth = fakeSynth();
      synth.speak = () => { throw new Error('unavailable'); };
      const { d, ducks } = dubber(() => 0, synth);
      const done = d.speak('hello', 'en', 0, 2);
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(ducks.at(-1)).toBe(1);
      expect(d.speaking).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('reports itself unavailable when the platform has no synthesiser', async () => {
    const d = new SpeechDubber({ now: () => 0, synth: undefined as unknown as SpeechSynthesis });
    // Constructed without a global speechSynthesis in this environment.
    await expect(d.speak('hello', 'en', 0, 1)).resolves.toBeUndefined();
  });
});
