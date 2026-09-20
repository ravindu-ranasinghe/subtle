# Bugs found during integration

Filed by E. Each one is in another worker's directory, found by wiring the
pipeline together and running it in a real browser.

---

## E-1 — the ASR worker crashes at module load: `chrome is not defined`

**Owner:** B (speech) · **File:** `extension/src/workers/asr/index.ts` ·
**Severity:** blocker — no speech recognition at all · **Status:** patched to
unblock, see below

### Repro

1. `pnpm build`
2. Load `extension/dist` unpacked.
3. Start capture on any tab (or run `e2e/pipeline.spec.ts`).
4. Watch the offscreen document's console, or the `error` messages it
   forwards to the service worker.

### Expected

The worker loads, downloads Silero and Whisper, and starts emitting
`segment` messages.

### Actual

```
{"type":"error","stage":"asr","message":"Uncaught ReferenceError: chrome is not defined"}
```

The worker dies before it processes a single message. No `modelProgress`, no
`segment`, no `metrics` — the ASR stage is silently absent and the only
symptom downstream is that no captions ever appear.

### Cause

Top of `workers/asr/index.ts`:

```ts
env.backends.onnx.wasm!.wasmPaths = chrome.runtime.getURL('wasm/');
```

**A dedicated worker does not get the `chrome` namespace**, even when it is
spawned from an extension page. Extension pages and the service worker do;
dedicated workers do not. This is the same context boundary C measured for the
Translator API (SPIKES C.1) — the `chrome` globals stop at the worker edge in
exactly the same way.

It is invisible in unit tests because nothing there loads the worker entry,
and invisible at build time because `@types/chrome` is a global type
declaration with no runtime counterpart.

### Fix

Derive the URL from the worker's own location, which is already a
`chrome-extension://` URL and needs no API:

```ts
-env.backends.onnx.wasm!.wasmPaths = chrome.runtime.getURL('wasm/');
+// A dedicated worker has no `chrome` namespace; its own URL is already
+// chrome-extension://<id>/workers/asr.js, so the extension root is one hop up.
+env.backends.onnx.wasm!.wasmPaths = new URL('/wasm/', self.location.href).href;
```

**Applied by E** so the pipeline could be wired and measured. B: please review
and keep or replace. Nothing else in the file uses `chrome`.

---

## E-2 — the MT worker crashes at module load, same cause

**Owner:** C (translation) · **File:** `extension/src/workers/mt/index.ts` ·
**Severity:** blocker — no local translation · **Status:** patched to unblock

### Repro

As E-1; the error arrives tagged `stage: 'translate'`.

### Expected

The worker loads and answers `mt:translate` requests.

### Actual

```
{"type":"error","stage":"translate","message":"Uncaught ReferenceError: chrome is not defined"}
```

Both workers die together, so a run produces exactly two errors and then
silence.

### Cause and fix

Identical to E-1:

```ts
-env.backends.onnx.wasm!.wasmPaths = chrome.runtime.getURL('wasm/');
+env.backends.onnx.wasm!.wasmPaths = new URL('/wasm/', self.location.href).href;
```

Note this only bites when Chrome's own Translator API is unavailable for the
pair and the local fallback is needed — with `chrome-translator` serving the
pair, the crash is invisible. That makes it a bug that would have shipped and
then appeared for one unlucky language pair.

---

## E-3 — the offscreen document cannot reach content scripts

**Owner:** E (mine) · **File:** `extension/src/offscreen/index.ts` ·
**Severity:** blocker — no captions ever appeared · **Status:** fixed

### Repro

Start capture and watch a video. The ASR and translation stages run (the debug
panel shows `asr 408ms`, `e2e 0ms`), but the overlay stays empty.

### Expected

`chrome.tabs.sendMessage(tabId, caption)` from the offscreen document delivers
the caption to the content script.

### Actual

Nothing arrives. **An offscreen document's API surface is limited to
`chrome.runtime`** — `chrome.tabs` is not available there, so the call was a
silent no-op inside a `.catch(() => {})` that assumed "the tab navigated".

### Fix

Captions, gloss responses and debug snapshots now go
offscreen → `chrome.runtime.sendMessage` → service worker →
`chrome.tabs.sendMessage`, under an internal `relayToTab` envelope. The
service worker has the `tabs` API; the offscreen document does not.

The `catch` that hid this now only covers the service worker being asleep,
which is a real and recoverable case.

---

## E-4 — a partial write to `ui` in storage turns captions off

**Owner:** D (overlay/UI) · **File:** `extension/src/content/index.ts` ·
**Severity:** low, but it bit the e2e · **Status:** not fixed, reported

### Repro

From any extension context:

```js
await chrome.storage.local.set({ ui: { debug: true } });
```

### Expected

Only `debug` changes; captions keep rendering.

### Actual

Captions stop. The overlay renders nothing until `ui` is written in full
again.

### Cause

On load the content script merges, but on change it replaces:

```ts
void chrome.storage.local.get(['config', 'ui']).then((stored) => {
  ui = { ...ui, ...(stored['ui'] ?? {}) };        // merges
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes['ui']?.newValue) ui = changes['ui'].newValue as UiState;   // replaces
});
```

So `captionsOn` becomes `undefined`, which is falsy, and `tick()` renders
`caption: null` forever.

### Suggested fix

Merge on change too, the same way the initial load does:

```ts
-if (changes['ui']?.newValue) ui = changes['ui'].newValue as UiState;
+if (changes['ui']?.newValue) ui = { ...ui, ...(changes['ui'].newValue as Partial<UiState>) };
```

The popup writes the whole object today, so nothing is broken in the shipping
paths — but any future partial write silently disables the product's main
feature, which is a sharp edge worth filing off.

---

## E-5 — the MT worker hangs forever when it asks for WebGPU

**Owner:** C (translation) · **File:** `extension/src/workers/mt/engine.ts` and
`extension/src/workers/mt/index.ts` · **Severity:** blocker for local
translation · **Status:** worked around, root cause not fixed

### Repro

1. Load the extension on a machine with WebGPU (any recent Mac).
2. Caption a Spanish video with a target Chrome cannot serve without a
   language-pack download, so selection falls to `local-mt`.
3. Watch the debug panel.

### Expected

`translate` latency appears within a few seconds of the first final segment.

### Actual

Nothing. The debug panel shows `translator local-mt`, four network requests
from the mt worker, and then silence — **no error, no progress, no timeout**.
`stats` never records a `translate` sample. Waited 420 s.

The `translate` promise never settles, so the caption never gets its
translation. Before I changed the offscreen document to publish the original
first, this also meant **no caption at all**.

### Cause

`LocalEngine.build()` takes the device from `pickBackend()`, which returns
`'webgpu'` whenever an adapter answers — the same choice Whisper makes. Whisper
has a working WebGPU export; opus-mt (Marian) appears not to, and asking for it
neither succeeds nor throws.

Two things make it silent rather than loud:

- `build()` swallows the opus-mt attempt with a bare `catch {}`, so if the load
  *did* fail there is no way to know it happened or why.
- There is no timeout on a model load, so a hang is indistinguishable from a
  slow download.

### Workaround applied

`extension/src/workers/mt/index.ts` now pins `device: 'wasm'`:

```ts
const engine = new LocalEngine({
  device: 'wasm',
  onProgress: ...
});
```

With that, translation works: 708–785 ms per line, measured in RESULTS.md.

### What C should do

1. Confirm whether Marian/NLLB have usable WebGPU exports in the pinned
   Transformers.js. If they do, find out why the load hangs; if they do not,
   keep the pin and say so in a comment.
2. Replace the bare `catch {}` in `build()` with something that reports which
   model failed and why — a translation that silently never arrives is the
   worst failure mode this pipeline has.
3. Consider a timeout on model load so a hang surfaces as an `error` message
   the popup can show.

---

## E-6 — orphaned content scripts spam `Extension context invalidated` forever

**Owner:** D (overlay/UI), found and fixed by E · **File:**
`extension/src/content/index.ts` · **Severity:** high — console noise, wasted
work, and a second overlay · **Status:** fixed

### Repro

1. Load the extension, open any page with a video.
2. Reload the extension at `chrome://extensions` without reloading the page.

### Expected

The old content script notices it has been orphaned and retires.

### Actual

```
Uncaught Error: Extension context invalidated.
  content.js:560 (anonymous function)   ← sendSync()
```

Every two seconds, forever, on every tab that was open. The orphan also keeps
its `requestAnimationFrame` loop and its MutationObserver running, and once the
service worker injects a fresh content script (E-7), the page has two overlays.

### Cause

Reloading an extension orphans the content scripts already in its pages: the
DOM survives, `chrome.runtime` does not. The heartbeat did:

```ts
void chrome.runtime.sendMessage({ type: 'videoSync', ... }).catch(() => {});
```

`chrome.runtime.sendMessage` throws **synchronously** on an invalidated
context, so the `.catch()` on the returned promise is never reached and the
error escapes. The same trap applies to `chrome.storage.local.set`.

### Fix

- `alive()` checks `chrome.runtime?.id`, which is `undefined` once the context
  is gone.
- `send()` and `persist()` wrap every call in try/catch and call `teardown()`
  when the context has died.
- `teardown()` clears the heartbeat, cancels the animation frame, stops the
  video watcher and removes the overlay. Idempotent.
- On boot, any `[data-subtle="overlay"]` left by a previous instance is
  removed, so a fresh injection cannot leave two overlays fighting.

---

## E-7 — the extension does nothing on tabs that were already open

**Owner:** A (capture / service worker), found and fixed by E · **File:**
`extension/src/sw/index.ts`, `extension/manifest.json` · **Severity:** high —
looks completely broken to a new user · **Status:** fixed

### Repro

1. Open a YouTube video.
2. Install or reload the extension.
3. Click the action, press Start.

### Expected

Captions.

### Actual

Nothing. No overlay, no captions, no error — and the tab's own audio keeps
playing, which makes it look like capture failed rather than like the UI is
absent. Confirmed live:

```js
document.querySelector('[data-subtle="overlay"]')   // → null
```

After a manual page reload the same check returns the host element and the
overlay works.

### Cause

Chrome injects declared content scripts on page load only. Every tab open at
install or reload time has none, and nothing says so. The first tab a user
tries is, by definition, one that was already open.

### Fix

`scripting` added to the manifest, and the service worker injects `content.js`
into every open http(s) tab on `onInstalled` and `onStartup`. Injection into
restricted pages is expected to fail and is ignored.

---

## E-8 — Whisper `small` dies with `memory access out of bounds`

**Owner:** B (speech), found and fixed by E · **File:**
`extension/src/workers/asr/whisper.ts` · **Severity:** high — one of the three
offered models cannot load · **Status:** fixed

### Repro

1. Start captions with WebGPU available.
2. In the popup, switch the model to **small**.

### Expected

The model downloads and captions resume.

### Actual

The popup shows:

```
memory access out of bounds
```

The model downloads and initialises, then dies on the first inference:

```
An error occurred during model execution: "RuntimeError: memory access out of bounds".
Inputs given to model: [object Object]
```

The debug panel keeps `capture running` with every stage row empty, so audio
is being captured and thrown away. `tiny` and `base` are unaffected.

### Cause

`WhisperEngine.create` asked for an fp32 encoder on every WebGPU load:

```ts
dtype: backend === 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8'
```

That mirrors the official Transformers.js WebGPU demo, which uses
`whisper-base`. `small`'s encoder is roughly 350 MB at fp32. It loads, and then the first
encoder pass allocates past the end of the ONNX Runtime wasm heap — WebGPU
still routes a good deal through wasm — and aborts with a bounds error that
names neither the model nor the real problem.

`MODEL_MB` in the same file already carried a note that the WebGPU download
sizes were unmeasured. They are measured now: this is what happens.

### Fix

Precision is chosen per size, not just per backend:

```ts
export function dtypeFor(size: WhisperSize, backend: Backend) {
  if (backend !== 'webgpu') return 'q8';
  if (size === 'small') return { encoder_model: 'q8', decoder_model_merged: 'q4' };
  return { encoder_model: 'fp32', decoder_model_merged: 'q4' };
}
```

`tiny` and `base` keep the fp32 encoder and their accuracy; `small` gets a
quantized one, which it can actually load.
