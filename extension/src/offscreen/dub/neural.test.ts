import { afterEach, expect, it, vi } from 'vitest';
import { NeuralDubber } from './neural.js';

const fallback = vi.hoisted(() => ({ speak: vi.fn(), stop: vi.fn(), voices: vi.fn() }));
vi.mock('./dubber.js', () => ({
  DUCK_GAIN: 0.18,
  SpeechDubber: class { speak = fallback.speak; stop = fallback.stop; },
  voicesReady: fallback.voices,
}));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });

it('finishes phrases, synthesizes ahead, and cancels queued or late audio on seek', async () => {
  vi.useFakeTimers();
  const worker = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: vi.fn(), terminate: vi.fn() };
  vi.stubGlobal('Worker', function () { return worker; });
  vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => path } });
  const sources: { onended: (() => void) | null; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }[] = [];
  const ctx = {
    currentTime: 10, state: 'running', destination: {},
    createBuffer: () => ({ copyToChannel() {} }),
    createBufferSource: () => {
      const source = { onended: null, start: vi.fn(), stop: vi.fn(), connect() {}, disconnect() {} };
      sources.push(source); return source;
    },
  };
  const duck = vi.fn();
  const dub = new NeuralDubber({ context: () => ctx as unknown as AudioContext, onDuck: duck, onStatus: vi.fn(), onError: vi.fn() });
  dub.prepare('en');
  worker.onmessage!({ data: { type: 'tts:ready' } });
  const answer = (id: number) => worker.onmessage!({ data: { type: 'tts:audio', id, samples: new Float32Array(44100), sampleRate: 44100 } });

  const first = dub.speak('First phrase.', 'en', 10, 2);
  answer(1);
  await vi.advanceTimersByTimeAsync(0);
  expect(sources[0]!.start).toHaveBeenCalledOnce();
  const second = dub.speak('Second phrase.', 'en', 10, 2);
  expect(worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'tts:speak', text: 'Second phrase.' }));
  answer(2);
  await vi.advanceTimersByTimeAsync(0);
  expect(sources).toHaveLength(1);
  expect(sources[0]!.stop).not.toHaveBeenCalled();
  sources[0]!.onended!();
  await first;
  await vi.advanceTimersByTimeAsync(0);
  expect(sources[1]!.start).toHaveBeenCalledOnce();

  const late = dub.speak('Old timeline.', 'en', 10, 2);
  dub.stop();
  await Promise.all([second, late]);
  answer(3);
  await vi.advanceTimersByTimeAsync(0);
  expect(sources).toHaveLength(2);
  expect(sources[1]!.stop).toHaveBeenCalledOnce();
  expect(duck).toHaveBeenLastCalledWith(1, 0.12);
  dub.dispose();
});

it('does not start the fallback after a stop while local voices are loading', async () => {
  let ready!: () => void;
  fallback.voices.mockReturnValue(new Promise<void>((resolve) => { ready = resolve; }));
  const dub = new NeuralDubber({ context: () => ({ currentTime: 1, state: 'running' }) as AudioContext, onDuck: vi.fn(), onStatus: vi.fn(), onError: vi.fn() });
  const speaking = dub.speak('你好。', 'zh', 1, 2);
  await Promise.resolve();
  dub.stop();
  ready();
  await speaking;
  await Promise.resolve();
  expect(fallback.speak).not.toHaveBeenCalled();
});
