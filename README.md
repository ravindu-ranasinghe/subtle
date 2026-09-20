# subtle

Live translated captions and optional spoken dubbing over video, running on-device.
Chrome MV3, no backend, no API keys, no network after the one-time model
download.

## Pipeline

```
tab audio (offscreen doc) → AudioWorklet resample to 16 kHz mono
  → asr-worker (Silero VAD + Whisper, Transformers.js, WebGPU)
  → offscreen main thread: Chrome Translator API, else mt-worker
  → chrome.tabs.sendMessage → content script overlay on <video>
```

The service worker only coordinates; it gets killed when idle. The offscreen
document owns the AudioContext and the models, and spawns the workers.

## Layout

```
shared/       the contract: messages, interfaces, timing, mocks. Frozen.
extension/    the extension itself. src/<area> per OWNERSHIP.md.
bench/        ASR benchmarks (owner B).
```

## Running it

```bash
pnpm install
pnpm build        # → extension/dist
pnpm test
pnpm typecheck
```

Then load the unpacked extension: `chrome://extensions` → Developer mode →
**Load unpacked** → pick `extension/dist`. Open the service worker's console
and a page with a video; you should see `[subtle] sw ok`, `[subtle] content
ok` and nothing red.

`pnpm dev` is the same build in watch mode. Chrome does not hot-reload an
unpacked extension: hit reload on the extension card after a rebuild.

## Captions and dubbing

Choose the spoken language (or Detect) and the target language, then start
captions. Translation is the main caption line, with the original underneath.
Translated previews begin on roughly 640 ms snapshots of captured speech, plus
recognition and translation time, and refine in place as more speech arrives.
Finished captions keep up to 2.5 seconds of context for accuracy and dubbing.
Previews automatically yield to finished captions if recognition falls behind. Tiny is the fastest recognition model; larger models
trade speed for accuracy. The first run needs model downloads.

Enable **Dub audio** in the popup to hear the selected target language using the
on-device Supertonic 3 neural voice. It supports the listed target languages
except Chinese, which falls back to the best installed local system voice.
The first neural-voice use downloads about 400 MB and is then cached locally.
Dubbing also works with the translation line hidden. Original audio is lowered
while each phrase speaks at a natural maximum 1.15× rate and is restored
afterwards. Pausing, seeking, changing languages, stopping capture, or
disabling dubbing cancels outdated speech.

If Chrome offers a language-pack download, use the popup button to install it.
Subsequent captions can then use Chrome's translator instead of the local model.

## Build shape

MV3 needs three different output formats, so `pnpm build` runs Vite three
times over one config (`extension/vite.config.ts`):

| Pass | Format | Entries |
|---|---|---|
| main | ESM | `sw.js`, `offscreen.html`, `popup.html`, `workers/asr.js`, `workers/mt.js`, `workers/tts.js` |
| content | IIFE | `content.js` — content scripts cannot be modules |
| worklet | IIFE | `worklets/resampler.js` — `addModule()` takes no module graph |

`node extension/check-dist.mjs` runs after the build and fails if the manifest
points at something that is not there, or if a classic script picked up an
`import`.

No remote code: `onnxruntime-web`'s wasm and glue are copied into `dist/wasm`
at build time. It is pinned to the exact build `@huggingface/transformers`
depends on — two copies of ORT means the JS and the `.wasm` disagree.
Model *weights* are the exception: they are fetched from Hugging Face once and
cached with the Cache API.

## Contributing

See [OWNERSHIP.md](./OWNERSHIP.md). `/shared` is frozen; contract changes go
through `CONTRACT_CHANGE_REQUEST.md`.
