/**
 * MT worker entry: message plumbing only. The engine is in ./engine.ts.
 *
 * Spawned by the offscreen document. `LocalMTTranslator` on the offscreen
 * side speaks the `mt:*` request/response protocol below; `modelProgress` and
 * `error` go out in the shapes /shared/messages.ts defines, because those are
 * for the popup rather than for the caller.
 */

import { env } from '@huggingface/transformers';
import { LocalEngine } from './engine.js';
import { NetworkCounter } from '../../debug/network.js';

// MV3 allows no remote code, so ORT's wasm comes from the bundle. A dedicated
// worker has no `chrome` namespace (see BUGS.md E-2), but its own URL is
// chrome-extension://<id>/workers/mt.js, so the root is one hop up.
env.backends.onnx.wasm!.wasmPaths = new URL('/wasm/', self.location.href).href;
// Threaded wasm needs SharedArrayBuffer, which needs cross-origin isolation,
// which extension pages do not have.
env.backends.onnx.wasm!.numThreads = 1;
env.allowLocalModels = false;

/** Request/response over the worker port. Internal to the translation layer. */
export type MtRequest =
  | { type: 'mt:available'; id: number; src: string; tgt: string }
  | { type: 'mt:translate'; id: number; id2?: string; text: string; context: string[]; src: string; tgt: string }
  | { type: 'mt:gloss'; id: number; word: string; sentence: string; src: string; tgt: string };

export type MtResponse =
  | { type: 'mt:result'; id: number; value: string }
  | { type: 'mt:availability'; id: number; value: 'yes' | 'download' | 'no' }
  | { type: 'mt:error'; id: number; message: string };

const engine = new LocalEngine({
  // WASM, not WebGPU: see BUGS.md E-5. Whisper has a working WebGPU export;
  // opus-mt (Marian) appears not to, and asking for it hangs the load with no
  // error rather than falling back.
  device: 'wasm',
  onProgress: (p) => {
    if (p.status === 'progress') {
      self.postMessage({ type: 'modelProgress', model: p.file ?? 'mt', loaded: p.loaded, total: p.total });
    }
  },
});

const reply = (message: MtResponse): void => self.postMessage(message);

async function handle(request: MtRequest): Promise<void> {
  try {
    switch (request.type) {
      case 'mt:available':
        reply({ type: 'mt:availability', id: request.id, value: await engine.available(request.src, request.tgt) });
        return;
      case 'mt:translate':
        reply({
          type: 'mt:result',
          id: request.id,
          value: await engine.translate(request.text, request.context, request.src, request.tgt),
        });
        return;
      case 'mt:gloss':
        reply({
          type: 'mt:result',
          id: request.id,
          value: await engine.gloss(request.word, request.sentence, request.src, request.tgt),
        });
        return;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reply({ type: 'mt:error', id: request.id, message });
    self.postMessage({ type: 'error', stage: 'translate', message });
  }
}

self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as { type?: string };
  if (typeof data?.type === 'string' && data.type.startsWith('mt:')) {
    void handle(event.data as MtRequest);
  }
});

self.postMessage({ type: 'mt:ready', backend: engine.backend });
// Resource timing is per-context: the offscreen document cannot see fetches
// made in here, and model weights are fetched in here. See debug/network.ts.
const network = new NetworkCounter();
network.start();
setInterval(() => self.postMessage({ type: 'network', count: network.count.total }), 1000);

console.log('[subtle] mt worker ok');
