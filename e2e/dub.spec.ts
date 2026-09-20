/**
 * Dubbing, running against the platform's real voices in the offscreen
 * document.
 *
 * Whether sound reaches a speaker cannot be asserted from a harness — the
 * browser is launched with --mute-audio and there is no loopback device — so
 * this covers everything up to and including the call into the synthesiser.
 */

import { expect, test } from '@playwright/test';
import { launch, type Harness } from './harness.js';
import { writeFileSync } from 'node:fs';

let harness: Harness;

interface DubResult {
  available: boolean;
  voices: number;
  ducks?: number[];
  spoken?: { rate: number; voice: string | null; lang: string }[];
  wasSpeaking?: boolean;
  error?: string;
}

async function ensureOffscreen(h: Harness): Promise<void> {
  await h.serviceWorker.evaluate(async () => {
    const existing = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    if (existing.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.AUDIO_PLAYBACK],
        justification: 'dub self-test',
      });
    }
  });
}

const dub = (h: Harness, text: string, lang: string, budget: number): Promise<DubResult> =>
  h.serviceWorker.evaluate(
    async ([t, l, b]) => chrome.runtime.sendMessage({ type: 'debugDubSelfTest', text: t, lang: l, budget: b }),
    [text, lang, budget] as const,
  ) as Promise<DubResult>;

test.beforeAll(async () => {
  harness = await launch();
  await ensureOffscreen(harness);
});
test.afterAll(async () => {
  await harness?.close();
});

test('neural voice generates non-silent multilingual audio inside the extension CSP', async ({}, testInfo) => {
  const page = await harness.context.newPage();
  await page.goto(`chrome-extension://${harness.extensionId}/popup.html`);
  page.on('console', (msg) => { if (msg.text().startsWith('VOICE')) console.log(msg.text()); });
  const results = await page.evaluate(async () => {
    const worker = new Worker(chrome.runtime.getURL('workers/tts.js'), { type: 'module' });
    const replies: { samples: number[]; sampleRate: number; ms: number; lang: string }[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        worker.onerror = (event) => reject(new Error(event.message));
        worker.onmessage = ({ data }) => {
          if (data.type === 'tts:status') console.log('VOICE ' + data.text);
          if (data.type === 'tts:error') reject(new Error(data.message));
          if (data.type === 'tts:ready') { console.log('VOICE backend: ' + data.backend); resolve(); }
        };
        worker.postMessage({ type: 'tts:load' });
      });
      for (const [lang, text] of [['en', 'The train arrives at seven.'], ['es', 'Buenos días. El tren llega a las siete.']]) {
        const audio = await new Promise<{ samples: Float32Array; sampleRate: number; ms: number }>((resolve, reject) => {
          worker.onmessage = ({ data }) => {
            if (data.type === 'tts:error') reject(new Error(data.message));
            if (data.type === 'tts:audio') resolve(data);
          };
          worker.postMessage({ type: 'tts:speak', id: 1, text, lang, budget: 3 });
        });
        replies.push({ ...audio, samples: Array.from(audio.samples), lang: lang! });
      }
      return replies;
    } finally { worker.terminate(); }
  });
  for (const result of results) {
    const duration = result.samples.length / result.sampleRate;
    const rms = Math.sqrt(result.samples.reduce((sum, n) => sum + n * n, 0) / result.samples.length);
    console.log('NEURAL_VOICE ' + JSON.stringify({ lang: result.lang, duration, rms, ms: result.ms, rtf: result.ms / 1000 / duration }));
    expect(result.sampleRate).toBe(44100);
    expect(result.samples.every(Number.isFinite)).toBe(true);
    expect(duration).toBeGreaterThan(1);
    expect(duration).toBeLessThan(8);
    expect(rms).toBeGreaterThan(0.005);
    // Keep a listenable artifact as well as the numeric checks.
    const wav = Buffer.alloc(44 + result.samples.length * 2);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(result.sampleRate, 24); wav.writeUInt32LE(result.sampleRate * 2, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
    result.samples.forEach((value, i) => wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + i * 2));
    const path = testInfo.outputPath(`neural-${result.lang}.wav`);
    writeFileSync(path, wav);
    await testInfo.attach(`neural-${result.lang}`, { path, contentType: 'audio/wav' });
  }
  await page.close();
});

test('speaks a translation through the platform synthesiser', async () => {
  const result = await dub(harness, 'The train arrives at seven.', 'en-US', 2);
  console.log('DUB:', JSON.stringify(result));

  expect(result.error).toBeUndefined();
  expect(result.available, 'speechSynthesis in the offscreen document').toBe(true);
  expect(result.voices, 'platform voices loaded').toBeGreaterThan(0);

  // It reached the synthesiser with a language and a chosen voice.
  expect(result.spoken?.length, 'an utterance was configured').toBeGreaterThan(0);
  expect(result.spoken![0]!.lang).toBe('en-US');
  expect(result.spoken![0]!.voice, 'a voice was matched to the language').not.toBeNull();
  expect(result.wasSpeaking, 'the synthesiser was speaking or queued').toBe(true);
});

test('ducks the original while speaking and restores it after', async () => {
  const result = await dub(harness, 'Hola, buenos días.', 'es-ES', 2);
  console.log('DUCK:', JSON.stringify(result.ducks));

  // Down before the dub, back to full afterwards — hearing both at equal
  // volume is worse than hearing either alone.
  expect(result.ducks?.[0]).toBeLessThan(0.5);
  expect(result.ducks?.at(-1)).toBe(1);
});

test('compresses a long line to fit the gap it has', async () => {
  const long = await dub(
    harness,
    'The train that arrives at seven o clock is the one you want to take today',
    'en-US',
    1.5,
  );
  const short = await dub(harness, 'Hello', 'en-US', 1.5);
  console.log(`rate long ${long.spoken?.[0]?.rate} vs short ${short.spoken?.[0]?.rate}`);

  expect(long.spoken![0]!.rate).toBeGreaterThan(short.spoken![0]!.rate);
  // ...but never past the point of being followable. MAX_RATE is 1.15; Chrome
  // stores rate as a float32, so it comes back as 1.149999976158142.
  expect(long.spoken![0]!.rate).toBeCloseTo(1.15, 5);
});
