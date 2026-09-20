# Contract change requests

> **All eight are resolved.** E applied them to `/shared`,
> `extension/manifest.json` and `extension/vite.config.ts`, and updated every
> caller, before wiring the pipeline. The entries are kept as the record of
> why each shape is the way it is. Integration bugs found afterwards are in
> [BUGS.md](./BUGS.md).


Open requests against `/shared` and `extension/manifest.json`. Each one names
the adapter in place so nothing is blocked while it waits.

---

## A-1 — `action.onClicked` never fires, so there is no way to start capture

**Raised by:** A (capture) · **Blocks:** the whole start path · **Status:** resolved

### What is wrong

The task for A is "on action click → create the offscreen document → start".
`extension/manifest.json` sets:

```json
"action": { "default_title": "Subtle captions", "default_popup": "popup.html" }
```

Chrome does not fire `chrome.action.onClicked` when the action has a
`default_popup` — the click opens the popup instead. The listener in
`extension/src/sw/index.ts` is correct and simply never runs.

This is documented Chrome behaviour, not a bug: "This event will not fire if
the action has a popup." Verifying it needs no repro beyond loading the
extension and clicking the icon; the popup opens and no `[subtle]` log
appears in the service worker console.

### Why it cannot be fixed locally

Only one of the two can own the click. D needs the popup for the language and
model settings, so the popup should keep it — but then the popup needs a way
to ask the service worker to toggle capture, and `/shared/messages.ts` has no
message for that. `start` is the wrong shape: it carries `streamId`, which
only the service worker can mint (`chrome.tabCapture.getMediaStreamId`
requires the `activeTab` grant the icon click just produced).

### Requested change

Add to `/shared/messages.ts`:

```ts
/** Popup -> service worker: start capture on this tab, or stop it if running. */
export interface ToggleCaptureMsg {
  type: 'toggleCapture';
  tabId: number;
}
```

...in the union, in `REQUIRED` as `['tabId']`, and `export const isToggleCapture`.

### Adapter in place until then

`extension/src/sw/index.ts` treats a `start` message with an **empty
`streamId`** as a toggle request:

```ts
if (isStart(message) && message.streamId === '') {
  void toggle(message.tabId).then(() => respond({ ok: true }));
  return true;
}
```

**D:** to start or stop capture from the popup today, send

```ts
await chrome.runtime.sendMessage({ type: 'start', tabId, streamId: '', config });
```

It toggles: send it again to stop, or send `{ type: 'stop', tabId }` to stop
explicitly. When `toggleCapture` lands, the adapter branch goes away and the
call becomes `{ type: 'toggleCapture', tabId }`.

### Alternative, if the popup should not own the click

Drop `default_popup` from the manifest and open the popup from
`chrome.action.onClicked` — but MV3 has no API to open the action popup
programmatically, so this means rebuilding the popup as an injected panel.
Not recommended.

---

## B-1 — no message for deleting cached model weights

**Raised by:** B (speech) · **Blocks:** D's "delete models" button · **Status:** resolved

Whisper `small` is 259 MB on disk and `base` is 77 MB. The popup is specified
to offer a delete, and the ASR worker is the only context that can do it, but
`/shared/messages.ts` has nothing for asking or for reporting the result.

### Requested change

```ts
/** Popup -> ASR worker: drop every cached model weight. */
export interface DeleteModelsMsg {
  type: 'deleteModels';
}

/** ASR worker -> popup: which Cache API buckets were removed. */
export interface ModelsDeletedMsg {
  type: 'modelsDeleted';
  caches: string[];
}
```

...in the union, in `REQUIRED` as `[]` and `['caches']`, plus the two guards.

### Adapter in place until then

`extension/src/workers/asr/index.ts` declares both shapes locally and handles
`deleteModels` on the worker port today. The exported
`deleteCachedModels(extra?: string[])` in `workers/asr/whisper.ts` can also be
called directly. When the contract lands, the local interfaces are deleted and
the guards come from `/shared`.

**Note for D:** the delete tears down the loaded recognizer, so capture has to
be restarted afterwards. There is no partial delete — it is all sizes at once,
because Transformers.js keeps them in one Cache bucket.

---

## B-2 — no message for reporting the active backend or detected language

**Raised by:** B (speech) · **Blocks:** nothing; degrades D's error surface · **Status:** resolved

Two things the task asks the ASR worker to report have nowhere to go:

- **Which backend is in use.** WebGPU or WASM is the difference between
  comfortably real-time and dropping chunks, and it is the first question
  anyone asks when captions lag. `pickBackend()` decides it at load.
- **The detected language**, when `srcLang` is `'auto'`. The popup shows a
  source-language picker; leaving it on "auto" with no indication of what auto
  resolved to is a worse experience than not detecting at all.

`modelProgress`, `error` and `metrics` all exist, but none of them carries
this, and overloading `error` for "we fell back to WASM" would be wrong —
falling back is not an error.

### Requested change

```ts
/** ASR worker -> everyone: which inference backend actually loaded. */
export interface BackendMsg {
  type: 'backend';
  backend: 'webgpu' | 'wasm';
  /** GPU adapter description when on WebGPU. */
  adapter?: string;
}

/** ASR worker -> everyone: what 'auto' resolved to. Sent once per session. */
export interface DetectedLanguageMsg {
  type: 'detectedLanguage';
  lang: string;
}
```

### Adapter in place until then

The worker posts `{ type: 'backend', backend }` and `{ type: 'language', lang }`
on its port. They fail `isMessage`, so anything routing strictly through the
contract drops them — which is the correct behaviour and why this is filed
rather than worked around. Nothing depends on them yet.

---

## C-1 — no message for "this language pair needs a click"

**Raised by:** C (translation) · **Blocks:** D's download button · **Status:** resolved

Chrome will not download a translation language pack without transient user
activation:

```
NotAllowedError: Requires a user gesture when availability is
"downloading" or "downloadable".
```

An offscreen document can never have one — it is not a surface the user can
click. So the gesture has to come from the popup, and the offscreen document
needs a way to say *which pair* is waiting on it. `error {stage, message}` can
carry the words, but the popup cannot tell an actionable pack request from a
genuine failure, and it needs the two language codes to make the call.

### Requested change

```ts
/**
 * Offscreen -> popup: Chrome can translate this pair, but only after a
 * download it will not start without a click. The popup shows a button.
 */
export interface LanguagePackRequiredMsg {
  type: 'languagePackRequired';
  src: string;
  tgt: string;
}
```

...in the union, in `REQUIRED` as `['src', 'tgt']`, plus `isLanguagePackRequired`.

### Adapter in place until then

`TranslationService` takes an `onLanguagePackRequired(src, tgt)` callback; E
wires it to an `error` message with `stage: 'translate'`. Captions are not
blocked either way — the service falls back to local MT on the spot and
retries, so the button is an upgrade rather than a gate.

**Note for D:** the download must be started from inside the click handler, or
Chrome rejects it again. Import `downloadLanguagePack` from
`extension/src/offscreen/translate/chrome-translator.ts`:

```ts
button.addEventListener('click', async () => {
  await downloadLanguagePack(src, tgt, (loaded, total) => showProgress(loaded / total));
});
```

Packs are per browser profile, so one download makes every context see
`availability: 'available'`.

### If C.6.1 turns out badly

If the offscreen document does **not** expose `Translator` (SPIKES C.6, not yet
run), translation has to move to the content script, which is a window context
and can also hold a gesture. `ChromeTranslator` already runs in any window
context — it reads its globals off `self` and checks
`chromeTranslatorSupported()` — so the move is a wiring change, not a rewrite:
the content script would own a `ChromeTranslator`, and the offscreen document
would route `caption` text through `chrome.tabs.sendMessage` for translation
before rendering. That needs a request/response message pair, which would be
filed then rather than speculatively now.

---

## C-2 — no way to report which translator is serving captions

**Raised by:** C (translation) · **Blocks:** nothing; degrades the popup · **Status:** resolved

Task item 3 says "expose which is active". `TranslationService.active` returns
it in-process, but nothing carries it to the popup, and the difference matters
to a user: Chrome's translator is instant and local MT may have just
downloaded 881 MB of NLLB to do the same job.

This is the same gap B filed as **B-2** for the ASR backend. Rather than a
second message, extend that one:

```ts
export interface BackendMsg {
  type: 'backend';
  backend: 'webgpu' | 'wasm';
  adapter?: string;
  /** Which translator is serving the current language pair. */
  translator?: 'chrome-translator' | 'local-mt';
  /** Model id when translator is 'local-mt' — opus-mt or the 881 MB NLLB. */
  translationModel?: string;
}
```

### Adapter in place until then

`TranslationService.active` and `LocalEngine.modelFor(src, tgt)` expose both
values synchronously to whoever holds the service. Nothing is sent anywhere.

---

## C-3 — the build emits a 21.6 MB duplicate of the ORT wasm

**Raised by:** C (translation) · **Blocks:** nothing; 21 MB of package size · **Status:** resolved

Both workers now import Transformers.js, so Rollup hoists it into one shared
chunk instead of bundling it twice — a win. The hoist also made Vite emit
`dist/assets/ort-wasm-simd-threaded.jsep.wasm` (21,596,019 bytes), which is
byte-identical (sha256 `c46655e8…`) to what the build plugin already copies to
`dist/wasm/`. `dist` is 58 MB, ~21 MB of it dead: both workers set
`env.backends.onnx.wasm.wasmPaths` to `dist/wasm/`, so the emitted asset is
never fetched.

`extension/vite.config.ts` is frozen, hence this request rather than a patch.

### Requested change

Either drop the `copyExtensionAssets` wasm copy and point `wasmPaths` at
Vite's emitted assets, or stop Vite emitting the duplicate:

```ts
build: {
  rollupOptions: {
    // ORT's wasm is copied explicitly into dist/wasm; let the import-time
    // URL reference resolve there instead of emitting a second copy.
    external: [/ort-wasm.*\.wasm$/],
  },
},
```

The first is tidier — one copy, Vite-managed, hashed — but changes the path
the workers point at, so both files move together. Whoever owns the build
config should pick; C will follow with the `wasmPaths` change.

### Adapter in place until then

None needed. Behaviour is correct; only the unpacked size is wrong.

---

## D-1 — keyboard shortcuts need a `commands` block in the manifest

**Raised by:** D (overlay/UI) · **Blocks:** proper shortcuts · **Status:** resolved

`chrome.commands` only exists if the manifest declares the commands, and
`extension/manifest.json` is frozen. The task assigns D three shortcuts:
toggle captions, toggle translation, replay the last line. A fourth —
immersion mode — falls out of the same mechanism.

### Requested change

```json
"commands": {
  "toggle-captions":    { "suggested_key": { "default": "Alt+Shift+C" },
                          "description": "Show or hide captions" },
  "toggle-translation": { "suggested_key": { "default": "Alt+Shift+T" },
                          "description": "Show or hide the translation line" },
  "toggle-immersion":   { "suggested_key": { "default": "Alt+Shift+I" },
                          "description": "Immersion mode: original only" },
  "replay-line":        { "suggested_key": { "default": "Alt+Shift+R" },
                          "description": "Jump back to the start of the last caption" }
}
```

MV3 allows four commands with suggested keys, which is exactly what this
needs. The service worker (A) would relay `chrome.commands.onCommand` to the
content script, since commands do not reach content scripts directly.

### Adapter in place until then

`extension/src/content/index.ts` listens for the same chords on `keydown`
with capture, on Alt+Shift so no major player conflicts. Two things this does
not give us, and why the manifest entry is still worth having:

- The shortcuts do not work when focus is in an iframe the content script did
  not get into, or on a page where a player swallows keydown first.
- The user cannot rebind them. `chrome://extensions/shortcuts` only lists
  declared commands.

### Also worth considering at the same time

`content_scripts[].css`. The overlay injects a `<style>` into its shadow root
from script. Content scripts are generally exempt from the page's CSP for what
they inject, but this has not been verified on a strict-CSP site (SPIKES
D.4.2). If it turns out to be blocked, the styles have to move to a manifest
CSS file, which is the same frozen file.

---

## D-2 — `videoSync` asks the content script for two things it cannot know

**Raised by:** D (overlay/UI) · **Blocks:** nothing; silently wrong data · **Status:** resolved

```ts
export interface VideoSyncMsg {
  type: 'videoSync';
  tabId: number;
  videoTime: number;
  audioTime: number;   // "the offscreen AudioContext currentTime observed
  paused: boolean;     //  when videoTime was read"
  playbackRate: number;
}
```

`videoSync` is sent by the content script, and the content script can supply
neither of the first two fields:

- **`audioTime`** is defined as the offscreen document's `AudioContext.currentTime`.
  A content script has no handle on that context and no way to read its clock.
  Any value it puts there is a fiction.
- **`tabId`** is not knowable from inside a content script. There is no
  `chrome.tabs.getCurrent()` for content scripts.

Both are knowable at the *receiving* end, which is the point: the offscreen
document owns the AudioContext, and `chrome.runtime.onMessage` hands the
receiver `sender.tab.id`.

### Requested change

Make both fields the receiver's to fill, and say so in the type:

```ts
export interface VideoSyncMsg {
  type: 'videoSync';
  /** Filled by the receiver from `sender.tab.id`; senders pass -1. */
  tabId: number;
  videoTime: number;
  /**
   * Offscreen AudioContext time. Filled by the offscreen document on
   * receipt — the sender cannot read that clock. Senders pass their own
   * monotonic reading, which is only good for ordering.
   */
  audioTime: number;
  paused: boolean;
  playbackRate: number;
}
```

No shape change, so nothing breaks; this is a documented contract of who owns
which field, which is what is missing.

### Adapter in place until then

The content script sends `tabId: -1` and `audioTime: performance.now() / 1000`.

**E, this is the important half:** on receiving a `videoSync`, overwrite both
before using it —

```ts
chrome.runtime.onMessage.addListener((message, sender) => {
  if (isVideoSync(message)) {
    applySync({ ...message, tabId: sender.tab?.id ?? -1, audioTime: ctx.currentTime });
  }
});
```

The error is one message hop, well under the 0.25 s seek tolerance in
`shared/timing.ts`. Using the content script's `audioTime` as-is would put
every caption on a clock with an arbitrary offset, and `isSeek()` would fire
on every single sync.
