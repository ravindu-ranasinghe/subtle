import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG } from '@subtle/shared';

const mocks = vi.hoisted(() => ({
  translate: vi.fn(), speak: vi.fn(), stop: vi.fn(), voices: vi.fn(), send: vi.fn(),
}));
vi.mock('./capture/capture.js', () => ({
  captureStats: () => null, setPassthroughGain: vi.fn(), startCapture: vi.fn(),
  startCaptureFromStream: vi.fn(), stopCapture: vi.fn(),
}));
vi.mock('./translate/index.js', () => ({
  TranslationService: class { translate = mocks.translate; resetContext() {} async prepare() {} },
  LocalMTTranslator: class {}, ChromeTranslator: class {}, chromeTranslatorSupported: () => false,
}));
vi.mock('./dub/dubber.js', () => ({
  SpeechDubber: class { available = true; speak = mocks.speak; stop = mocks.stop; },
  voicesReady: mocks.voices,
}));
vi.mock('./dub/neural.js', () => ({
  NeuralDubber: class { prepare() {} speak = mocks.speak; stop = mocks.stop; },
}));

let receive: (message: unknown, sender?: unknown, respond?: unknown) => unknown;
let asr: EventTarget;
let now = 10;
const config = { ...DEFAULT_CONFIG, srcLang: 'es', dubbing: true };
const settle = () => vi.advanceTimersByTimeAsync(0);
const segment = (id: string, interim = false, text = id) => asr.dispatchEvent(new MessageEvent('message', { data: {
  type: 'segment', id, text, lang: 'es', audioStart: now - 2, audioEnd: now, interim,
} }));
const captions = () => mocks.send.mock.calls.map(([m]) => m.payload).filter((m) => m?.type === 'caption' && m.translation);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  now = 10;
  mocks.send.mockResolvedValue(undefined);
  mocks.translate.mockImplementation(async (text: string) => `translated ${text}`);
  mocks.voices.mockResolvedValue(1);
  vi.stubGlobal('self', {});
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('chrome', { runtime: {
    sendMessage: mocks.send, getURL: (p: string) => p,
    onMessage: { addListener: (fn: typeof receive) => { receive = (m, sender = {}, respond = () => {}) => fn(m, sender, respond); } },
  } });
  vi.stubGlobal('Worker', class extends EventTarget {
    constructor(url: string) { super(); if (url.includes('asr')) asr = this; }
    postMessage() {}
  });
  vi.stubGlobal('AudioContext', class { get currentTime() { return now; } async close() {} });
  await import('./index.js');
  receive({ type: 'debugStart', tabId: 1, config });
  await settle();
});
afterEach(async () => {
  receive({ type: 'stop', tabId: 1 });
  await settle();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('translates and dubs even with the translation line hidden', async () => {
  receive({ type: 'setConfig', config: { ...config, showTranslation: false } });
  now = 13;
  segment('hola');
  await settle();
  expect(captions()[0]?.translation).toBe('translated hola');
  expect(mocks.speak).toHaveBeenCalledWith('translated hola', 'en', 13, 2);
});

it('keeps only the newest pending translation when a model is slow', async () => {
  const first = deferred<string>();
  mocks.translate.mockReturnValueOnce(first.promise);
  segment('first'); segment('second'); segment('third');
  expect(mocks.translate).toHaveBeenCalledTimes(1);
  first.resolve('translated first');
  await settle();
  expect(mocks.translate.mock.calls.map(([text]) => text)).toEqual(['first', 'third']);
});

it('rejects old-language results after changing the target', async () => {
  const pending = deferred<string>();
  mocks.translate.mockReturnValueOnce(pending.promise);
  segment('hola');
  receive({ type: 'setConfig', config: { ...config, tgtLang: 'fr' } });
  pending.resolve('old English');
  await settle();
  expect(captions()).toEqual([]);
  expect(mocks.speak).not.toHaveBeenCalled();
  now = 13;
  segment('new');
  await settle();
  expect(mocks.translate).toHaveBeenLastCalledWith('new', [], 'es', 'fr', true);
});

it('does not speak after dubbing is disabled while translation loads', async () => {
  const pending = deferred<string>();
  mocks.translate.mockReturnValueOnce(pending.promise);
  segment('hola');
  await settle();
  receive({ type: 'setConfig', config: { ...config, dubbing: false } });
  pending.resolve('translated hola');
  await settle();
  expect(mocks.speak).not.toHaveBeenCalled();
});

it('cancels speech and in-flight translations on pause and seek', async () => {
  const sync = (videoTime: number, paused = false) => receive({
    type: 'videoSync', tabId: 1, audioTime: now, videoTime, paused, playbackRate: 1,
  });
  sync(10);
  segment('speaking');
  await settle();
  expect(mocks.speak).toHaveBeenCalledTimes(1);
  const stops = mocks.stop.mock.calls.length;
  const pending = deferred<string>();
  mocks.translate.mockReturnValueOnce(pending.promise);
  segment('old');
  sync(10, true);
  sync(100);
  pending.resolve('stale');
  await settle();
  expect(mocks.stop.mock.calls.length).toBeGreaterThan(stops);
  expect(captions().some((c) => c.translation === 'stale')).toBe(false);
  expect(mocks.speak).toHaveBeenCalledTimes(1);
});

it('discards a translation that arrives long after its audio', async () => {
  const pending = deferred<string>();
  mocks.translate.mockReturnValueOnce(pending.promise);
  segment('old');
  now = 20;
  pending.resolve('stale');
  await settle();
  expect(captions()).toEqual([]);
  expect(mocks.speak).not.toHaveBeenCalled();
});

it('translates previews immediately, but only dubs the finished line', async () => {
  segment('a', true, 'hola');
  await settle();
  expect(captions()[0]).toMatchObject({ id: 'a', translation: 'translated hola', interim: true });
  expect(mocks.translate).toHaveBeenLastCalledWith('hola', [], 'es', 'en', false);
  expect(mocks.speak).not.toHaveBeenCalled();
  segment('a', false, 'hola mundo');
  await settle();
  expect(captions().at(-1)).toMatchObject({ id: 'a', translation: 'translated hola mundo', interim: false });
  expect(mocks.speak).toHaveBeenCalledTimes(1);
});

it('never publishes an obsolete preview over its newer final', async () => {
  const preview = deferred<string>();
  mocks.translate.mockReturnValueOnce(preview.promise);
  segment('a', true, 'hola');
  segment('a', false, 'hola mundo');
  preview.resolve('outdated');
  await settle();
  expect(captions().map((c) => c.translation)).toEqual(['translated hola mundo']);
});
