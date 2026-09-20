/**
 * ASR worker entry: message plumbing only. Everything real is in
 * ./recognizer.ts.
 *
 * Spawned by the offscreen document as a module worker. Audio arrives as
 * audioChunk messages; segments, metrics, progress and errors go back on the
 * same port in the shapes /shared/messages.ts defines.
 */

import { env } from '@huggingface/transformers';
import {
  DEFAULT_CONFIG,
  isAudioChunk,
  isDeleteModels,
  isSetConfig,
  isStart,
  isStop,
  type Config,
} from '@subtle/shared';
import { WorkerRecognizer } from './recognizer.js';
import { deleteCachedModels, gpuAdapterName } from './whisper.js';
import { SILERO_MODEL_ID } from './silero.js';
import { NetworkCounter } from '../../debug/network.js';

// MV3 allows no remote code, and Transformers.js otherwise pulls the ORT
// wasm from a CDN. Point it at the copy the build put in dist/wasm.
// A dedicated worker has no `chrome` namespace (see BUGS.md E-1), but its own
// URL is chrome-extension://<id>/workers/<name>.js, so the root is one hop up.
env.backends.onnx.wasm!.wasmPaths = new URL('/wasm/', self.location.href).href;
// Threaded wasm needs SharedArrayBuffer, which needs cross-origin isolation,
// which extension pages do not have. Asking for threads here fails at load.
env.backends.onnx.wasm!.numThreads = 1;
// Weights come from Hugging Face and are cached; there are no local ones.
env.allowLocalModels = false;

let config: Config = DEFAULT_CONFIG;
let recognizer: WorkerRecognizer | null = null;
let loading: Promise<void> | null = null;

const post = (message: unknown, transfer: Transferable[] = []): void => {
  self.postMessage(message, transfer);
};

function build(): WorkerRecognizer {
  const r = new WorkerRecognizer({
    srcLang: config.srcLang,
    onMetrics: (m) => post({ type: 'metrics', ...m }),
    onError: (message) => post({ type: 'error', stage: 'asr', message }),
    onBackend: (backend) => {
      // 'cpu' only happens under Node in bench/; in the worker it is one of two.
      const reported = backend === 'webgpu' ? 'webgpu' : 'wasm';
      void gpuAdapterName().then((adapter) => {
        post({ type: 'backend', backend: reported, ...(adapter ? { adapter } : {}) });
      });
    },
    onLanguage: (lang) => post({ type: 'detectedLanguage', lang }),
  });
  r.onSegment((segment) => post({ type: 'segment', ...segment }));
  return r;
}

async function start(next: Config): Promise<void> {
  config = next;
  recognizer?.dispose();
  recognizer = build();
  const r = recognizer;
  loading = r
    .load(config.whisperModel, (loaded, total) => {
      post({ type: 'modelProgress', model: config.whisperModel, loaded, total });
    })
    .catch((err: unknown) => {
      post({
        type: 'error',
        stage: 'model',
        message: err instanceof Error ? err.message : String(err),
      });
    });
  await loading;
}

self.addEventListener('message', (event: MessageEvent) => {
  const message: unknown = event.data;

  if (isStart(message)) {
    void start(message.config);
    return;
  }

  if (isAudioChunk(message)) {
    // Audio keeps arriving while the model downloads; the segmenter is not
    // there yet, so those chunks are simply lost. Dropping the first few
    // seconds of a video beats queueing 400 MB worth of them.
    recognizer?.pushAudio(message);
    return;
  }

  if (isStop(message)) {
    // Do not let an old flush dispose a newly started recognizer.
    recognizer?.dispose();
    recognizer = null;
    return;
  }

  if (isSetConfig(message)) {
    const changed =
      message.config.whisperModel !== config.whisperModel || message.config.srcLang !== config.srcLang;
    config = message.config;
    // Only a model or language change needs a reload; font size does not.
    if (changed && recognizer) void start(config);
    return;
  }

  if (isDeleteModels(message)) {
    recognizer?.dispose();
    recognizer = null;
    void deleteCachedModels([SILERO_MODEL_ID]).then((deleted) => {
      post({ type: 'modelsDeleted', caches: deleted });
    });
  }
});

post({ type: 'ready' });
// Resource timing is per-context: the offscreen document cannot see fetches
// made in here, and model weights are fetched in here. See debug/network.ts.
const network = new NetworkCounter();
network.start();
setInterval(() => self.postMessage({ type: 'network', count: network.count.total }), 1000);

console.log('[subtle] asr worker ok');
