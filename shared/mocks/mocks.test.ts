import { describe, expect, it, vi } from 'vitest';
import { decodeWav, loadFixture, mockAudioSource } from './audio.js';
import { fakeChrome, listenOnTab } from './chrome.js';
import { MockRecognizer } from './recognizer.js';
import { MockTranslator } from './translator.js';
import { isAudioChunk, isCaption, type Message, type Segment } from '../messages.js';

/** RMS over a window, in seconds. Single samples land on zero crossings. */
function rms(samples: Float32Array, from: number, to: number, rate = 16000): number {
  const a = Math.round(from * rate);
  const b = Math.round(to * rate);
  let sum = 0;
  for (let i = a; i < b; i++) sum += samples[i]! ** 2;
  return Math.sqrt(sum / (b - a));
}

describe('wav fixture', () => {
  it('decodes to 8s of 16 kHz mono', async () => {
    const wav = await loadFixture();
    expect(wav.sampleRate).toBe(16000);
    expect(wav.samples.length).toBe(16000 * 8);
    // Loud inside the first burst, silent in the gap before the second.
    expect(rms(wav.samples, 0.5, 1.5)).toBeGreaterThan(0.1);
    expect(rms(wav.samples, 2.05, 2.35)).toBe(0);
  });

  it('rejects a non-WAV buffer', () => {
    expect(() => decodeWav(new ArrayBuffer(64))).toThrow(/not a WAV/);
  });
});

describe('mockAudioSource', () => {
  it('emits the whole file as audioChunk messages with a continuous clock', async () => {
    const wav = await loadFixture();
    const chunks: Message[] = [];
    mockAudioSource(wav, (m) => chunks.push(m), { speed: 0, chunkMs: 100, startAt: 10 });
    expect(chunks).toHaveLength(80);
    expect(chunks.every(isAudioChunk)).toBe(true);
    const first = chunks[0]!;
    const last = chunks[79]!;
    if (!isAudioChunk(first) || !isAudioChunk(last)) throw new Error('unreachable');
    expect(first.audioStart).toBe(10);
    expect(last.audioStart).toBeCloseTo(10 + 7.9);
    expect(first.samples.length).toBe(1600);
  });
});

describe('MockRecognizer', () => {
  it('emits the script as interim-then-final segments on the audio clock', async () => {
    vi.useFakeTimers();
    try {
      const rec = new MockRecognizer();
      const seen: Segment[] = [];
      rec.onSegment((s) => seen.push(s));
      await rec.load('tiny', () => {});
      rec.pushAudio({ samples: new Float32Array(160), audioStart: 100 });
      await vi.advanceTimersByTimeAsync(8000);

      expect(seen).toHaveLength(6);
      const finals = seen.filter((s) => !s.interim);
      expect(finals.map((s) => s.text)).toEqual([
        'Guten Morgen, wie geht es dir?',
        'Mir geht es gut, danke der Nachfrage.',
        'Wollen wir heute Abend ins Kino gehen?',
      ]);
      // Timestamps are anchored to the first chunk's audioStart.
      expect(finals[0]!.audioStart).toBe(100.2);
      expect(finals[0]!.audioEnd).toBe(102);
      expect(finals[0]!.words?.at(-1)?.end).toBeCloseTo(102);
      rec.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MockTranslator', () => {
  it('tags text with the target language and records calls', async () => {
    const t = new MockTranslator();
    expect(await t.available('de', 'en')).toBe('yes');
    expect(await t.translate('Guten Morgen', [], 'de', 'en')).toBe('[en] Guten Morgen');
    expect(await t.gloss('Morgen', 'Guten Morgen', 'de', 'en')).toEqual({
      word: 'Morgen',
      translation: '[en] Morgen',
      pos: 'noun',
    });
    expect(t.calls[0]?.src).toBe('de');
  });
});

describe('fakeChrome', () => {
  it('routes runtime and per-tab messages and records them', async () => {
    const chrome = fakeChrome();
    const restore = chrome.install();
    try {
      const toSw: Message[] = [];
      chrome.runtime.onMessage.addListener((m) => void toSw.push(m));
      const toTab: Message[] = [];
      listenOnTab(chrome, 42, (m) => void toTab.push(m));

      await chrome.runtime.sendMessage({ type: 'stop', tabId: 42 });
      await chrome.tabs.sendMessage(42, {
        type: 'caption',
        id: 'a',
        original: 'Guten Morgen',
        translation: '[en] Guten Morgen',
        srcLang: 'de',
        tgtLang: 'en',
        videoStart: 1,
        videoEnd: 3,
        interim: false,
      });

      expect(toSw).toHaveLength(1);
      expect(toTab.every(isCaption)).toBe(true);
      expect(chrome.sent.map((s) => s.to)).toEqual(['runtime', 42]);
      expect(chrome.runtime.getURL('workers/asr.js')).toMatch(/^chrome-extension:\/\//);
    } finally {
      restore();
    }
  });

  it('rejects a message to a tab with no listener', async () => {
    const chrome = fakeChrome();
    await expect(chrome.tabs.sendMessage(1, { type: 'stop', tabId: 1 })).rejects.toThrow(/no listener/);
  });
});
