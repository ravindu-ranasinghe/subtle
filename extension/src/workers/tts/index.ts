import { NeuralVoiceEngine } from './engine.js';

let engine: Promise<NeuralVoiceEngine> | null = null;
function load(): Promise<NeuralVoiceEngine> {
  return engine ??= NeuralVoiceEngine.create((text) => self.postMessage({ type: 'tts:status', text }));
}

self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string; id?: number; text?: string; lang?: string; budget?: number };
  if (data.type === 'tts:load') {
    void load().then((voice) => self.postMessage({ type: 'tts:ready', backend: voice.backend }))
      .catch((error: unknown) => self.postMessage({ type: 'tts:error', message: String(error) }));
  } else if (data.type === 'tts:speak' && typeof data.id === 'number' && typeof data.text === 'string' && typeof data.lang === 'string') {
    const { id, text, lang } = data;
    const started = performance.now();
    void load().then((voice) => voice.synthesize(text, lang, data.budget ?? 0))
      .then(({ samples, sampleRate }) => self.postMessage({ type: 'tts:audio', id, samples, sampleRate, ms: performance.now() - started }, [samples.buffer]))
      .catch((error: unknown) => self.postMessage({ type: 'tts:error', id, message: String(error) }));
  }
});
