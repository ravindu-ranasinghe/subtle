# Spikes

Findings that are cheaper to write down once than to rediscover. One section
per area owner.

---

# Section A — Tab audio capture

Owner: A · Last updated: 2026-09-19

## A.1 Resampler: measured, in Node

`extension/src/worklets/dsp.ts` is a 128-tap Kaiser-windowed sinc resampler
(512 fractional phases, nearest phase, cutoff 0.45 × 16 kHz = 7.2 kHz, each
phase row normalised to unity DC gain). Measured by running tones through it
in 128-frame render quanta, exactly as the worklet does:

| Input tone | Output gain |
|---|---|
| 100 Hz – 6.5 kHz | 0.0 dB (flat) |
| 6.8 kHz | −0.7 dB |
| 7.0 kHz | −2.4 dB |
| 7.2 kHz | −6.0 dB (design cutoff) |
| 7.8 kHz | −41.9 dB |
| 8.5 kHz | −63.9 dB |
| 9 kHz | −74.7 dB |
| 10 kHz | −71.9 dB |
| 12 kHz | −110.6 dB |

Only content **above** the 8 kHz output Nyquist can alias. Everything there is
down at least 64 dB, so **aliasing suppression is ≥ 64 dB**. A 10 kHz tone,
which naive 3:1 decimation would fold to 6 kHz at full amplitude, arrives at
−72 dB — a 66 dB improvement, asserted in `dsp.test.ts`.

The passband is flat to 6.5 kHz and −3 dB at about 7.05 kHz. Speech energy
above 7 kHz is fricative detail; if Whisper turns out to want it, raise
`cutoffRatio` toward 0.48 and the taps with it.

**Cost:** 60 s of 48 kHz audio resampled in **109 ms** — 0.18% of one audio
thread. The filter table is 512 × 128 floats = **256 KiB**, built once per
capture. There is no per-block allocation except the 6400-byte frame buffer
handed to `postMessage` every 100 ms, which has to be fresh because it is
transferred.

Non-integer ratios work: 44.1 kHz → 16 kHz is covered by the same path and
tested. If the AudioContext already runs at 16 kHz the filter is bypassed.

## A.2 Chunk timestamps

`audioStart` is derived from a running output-sample count
(`t0 + emitted × 1600 / 16000`), not read off `currentTime` per frame. The
resampler emits an uneven number of samples per render quantum — 22 on the
first block, then 42 or 43 — so reading the clock per frame would jitter.
Counting samples gives timestamps that are exactly 100 ms apart with no drift
over 3 s (asserted to 9 decimal places).

A disconnected or channel-less input still advances the clock by feeding
silence, so a gap in the stream does not make every later timestamp early.

## A.3 Browser observations — **NOT RUN**

Everything below needs the extension loaded in Chrome, and two things stop me
from getting there from this session:

1. **Nothing calls `startCapture` yet.** `extension/src/offscreen/index.ts` is
   E's file and is still the scaffold stub. `capture.ts` compiles and
   typechecks but is not in the bundle — `grep chromeMediaSource
   extension/dist/*.js` finds nothing. See A.4 for the three lines E needs.
2. **Loading an unpacked extension cannot be automated.** Extensions cannot
   script `chrome://extensions`, so this is a manual step regardless.

So the four browser questions are open. The protocol below is what to run
once A.4 is done; fill the results in here.

### Protocol

Load `extension/dist` unpacked, open the service worker console **and** the
offscreen document console (`chrome://extensions` → Inspect views → offscreen).

| # | Site | What to check | Result |
|---|---|---|---|
| A.3.1 | youtube.com, any video | chunks arrive, tab stays audible | — |
| A.3.2 | a plain `<video>` page (e.g. a local file or `w3schools` sample) | same | — |
| A.3.3 | a page with an embedded iframe player (YouTube embed on a third-party page) | same — capture is per *tab*, so the iframe should be irrelevant | — |
| A.3.4 | netflix.com, or any EME/Widevine title | **record exactly**: does `getUserMedia` reject, does it resolve and deliver silence, or does it deliver real audio? | — |
| A.3.5 | any of the above, 20 minutes | offscreen document still alive, chunks still arriving, `captureStats().dropped === 0` | — |

For A.3.1–A.3.3, in the offscreen console:

```js
const { chunks } = await startCapture(streamId);
const reader = chunks.getReader();
let n = 0, last = -1;
for (;;) {
  const { value, done } = await reader.read();
  if (done) break;
  if (last >= 0) console.assert(Math.abs(value.audioStart - last - 0.1) < 1e-6, 'gap', value.audioStart);
  last = value.audioStart;
  if (++n % 50 === 0) console.log(n, 'chunks', value.audioStart.toFixed(2), 's');
}
```

Non-silence check: `value.samples.reduce((a, b) => a + b * b, 0)` should be
well above zero while the video is playing.

For A.3.5, leave it running and check `captureStats()` at the end:

```js
captureStats();  // { dropped, delivered, inputRate, startedAt }
```

`delivered` should be within a chunk or two of `(Date.now() - startedAt) / 100`.

### What I expect, and why it still needs checking

- **A.3.4 (DRM)** is the one worth real attention. `chromeMediaSource: 'tab'`
  captures the tab's audio output rather than the media element, so protected
  audio has historically come through. Netflix also has its own detection.
  Whatever happens, record the exact error string or the exact RMS of the
  captured samples — "it didn't work" is not a finding.
- **A.3.5 (20 min)** should hold: an offscreen document created with reason
  `USER_MEDIA` and an active `MediaStream` is exempt from the idle teardown
  that closes other offscreen documents after 30 s. The service worker dying
  in the meantime is expected and harmless — session state is in
  `chrome.storage.session`, which survives it.

## A.4 What E needs to wire

`extension/src/offscreen/index.ts` (E's file). Capture is inert until this
lands:

```ts
import { startCapture, stopCapture } from './capture/capture.js';
import { isStart, isStop } from '@subtle/shared';

chrome.runtime.onMessage.addListener((message) => {
  if (isStart(message)) {
    void startCapture(message.streamId).then(({ chunks }) => pumpToAsrWorker(chunks));
  } else if (isStop(message)) {
    void stopCapture();
  }
});
```

`chunks` is a `ReadableStream<AudioChunk>`; each chunk is
`{ samples: Float32Array, audioStart: number }`, 1600 samples, 100 ms apart.
Transfer `samples.buffer` when forwarding to the ASR worker.

Two things to know when consuming it:

- **It cannot be back-pressured.** The audio thread does not wait. If the
  reader falls more than 100 chunks (~10 s) behind, `capture.ts` drops chunks
  and counts them in `captureStats().dropped` rather than growing memory
  without bound.
- **Cancelling the stream stops the capture.** `reader.cancel()` calls
  `stopCapture()`.

## A.5 Manifest conflict: the action click never arrives

`default_popup` suppresses `chrome.action.onClicked` entirely, so the start
path in the service worker has no trigger. Written up with the requested
contract change and the adapter that unblocks D in
[CONTRACT_CHANGE_REQUEST.md](./CONTRACT_CHANGE_REQUEST.md#a-1--actiononclicked-never-fires-so-there-is-no-way-to-start-capture).

---

# Section B — Speech recognition

Owner: B · Last updated: 2026-09-19 · Machine: Apple M4, 10 cores, 16 GB, macOS 26.6.2

## B.1 Transformers.js does not implement Whisper language detection

Not a subtlety — it is a `TODO` in the shipped code. From
`@huggingface/transformers/dist/transformers.js`, in
`WhisperForConditionalGeneration._retrieve_init_tokens`:

```js
if (!language) {
    // TODO: Implement language detection
    console.warn('No language specified - defaulting to English (en).');
    language = 'en';
}
```

So `srcLang: 'auto'` silently transcribes everything as English. Observed on a
Spanish clip: *"Buenos días, ¿cómo estás hoy?"* came back as
**"Good morning! How are you?"** — Whisper forced into English decodes as a
loose translation, and nothing in the result says the language was wrong.

**What we do instead.** `WhisperEngine.detectLanguage` runs the detection
Whisper itself does: one decoder step from `<|startoftranscript|>`, then argmax
over the language tokens in `generation_config.lang_to_id`. Verified on the
same Spanish clip:

```
<|es|>=20.93  <|gl|>=16.68  <|la|>=15.75  <|it|>=15.53  <|en|>=15.17
```

Comfortably separated, and it costs one encoder pass plus one decoder step.
The result is locked for the session — re-detecting per chunk makes the
language flap mid-sentence on short or noisy audio.

## B.2 Word timestamps need the `_timestamped` model exports

`onnx-community/whisper-tiny` with `return_timestamps: 'word'` throws:

```
Model outputs must contain cross attentions to extract timestamps.
This is most likely because the model was not exported with `output_attentions=True`.
```

The `onnx-community/whisper-*_timestamped` repos are exported with them and
work. Confirmed on `whisper-base_timestamped`:

```json
[{"text":" Buenos","timestamp":[0,0.3]},{"text":" días,","timestamp":[0.3,0.6]},
 {"text":" como","timestamp":[0.92,1.1]},{"text":" estás","timestamp":[1.1,1.32]}]
```

`MODEL_IDS` points at the `_timestamped` variants for all three sizes (all
three exist; checked). So word timestamps are always available and the
segment-level fallback never fires — worth knowing before anyone builds one.

## B.3 Silero VAD

Graph checked against the downloaded file rather than assumed:

| | |
|---|---|
| inputs | `input` [1,512] f32 · `state` [2,1,128] f32 · `sr` int64 scalar |
| outputs | `output` [1,1] f32 · `stateN` [2,1,128] f32 |
| size | 2.1 MB |
| cost | **RTF 0.0026** — 8 s of audio scored in 21 ms |

Loaded through Transformers.js (`AutoModel.from_pretrained` with
`config: { model_type: 'custom' }`) rather than importing `onnxruntime-web`
directly: one ORT instance in the worker instead of two, one weight cache, and
download progress for free. Scores are identical either way — 92% of frames
above 0.5 and mean 0.909 on the same clip, both paths.

Measured probabilities, which is where the thresholds come from:

| Audio | frames > 0.5 | mean |
|---|---|---|
| Real speech (en, es) | 92–93% | 0.909 |
| `shared/mocks/fixtures/speech-16k.wav` | 1% | 0.036 |

**The mock fixture is not speech.** It is an amplitude-modulated tone stack,
and Silero correctly refuses it. It is a good negative fixture and it cannot
exercise the positive path at all — which is why `bench/make-clips.mjs`
generates real speech with macOS `say` instead.

## B.4 Measured accuracy and speed

Full sweep, `bench/run.ts`, Node + onnxruntime-node on CPU, q8 weights:

| model | lang | metric | error rate | median latency | RTF |
|---|---|---|---|---|---|
| tiny | en | WER | 2.9% | 293 ms | 0.10 |
| tiny | es | WER | 17.4% | 253 ms | 0.10 |
| tiny | fr | WER | 9.1% | 248 ms | 0.10 |
| tiny | ja | CER | 7.7% | 264 ms | 0.08 |
| base | en | WER | 5.9% | 448 ms | 0.16 |
| base | es | WER | 8.7% | 386 ms | 0.15 |
| base | fr | WER | 9.1% | 396 ms | 0.16 |
| base | ja | CER | 3.8% | 406 ms | 0.12 |
| small | en | WER | 5.9% | 1068 ms | 0.33 |
| small | es | WER | 8.7% | 948 ms | 0.36 |
| small | fr | WER | 4.5% | 938 ms | 0.38 |
| small | ja | CER | 1.9% | 985 ms | 0.30 |

**Read these carefully.** The clips are macOS text-to-speech: clean, evenly
paced, no background, three clips per language. Error rates are a best case
and the sample is far too small to rank languages — `tiny`/es at 17.4% is two
bad clips, not a finding. What the table is good for is the **RTF column**,
which is the shape of the cost, and it is the same shape real audio will have.

Every size runs comfortably faster than real time **on CPU alone**: `small` at
RTF 0.33 leaves two thirds of a core spare. The 3 s queue guard in
`recognizer.ts` should therefore never fire on this machine — it is there for
weaker hardware and for WASM without SIMD.

Downloads and memory:

| model | download (q8) | peak process RSS |
|---|---|---|
| Silero VAD | 2.1 MB | — |
| tiny | 43 MB | 678 MB |
| base | 77 MB | 1239 MB |
| small | 259 MB | 1572 MB |

RSS is process-wide and includes the Node runtime and ORT, so it is an upper
bound on what the worker costs, not the weight footprint.

## B.5 Bundle and runtime wiring

Bundling Transformers.js into the worker costs **2.0 MB raw / 342 kB gzip**
(`dist/workers/asr.js`). It has to be bundled: MV3 permits no remote code.
Webpack's browser build already stubs out `onnxruntime-node`, so nothing
Node-only leaks in — checked in the built file.

Two settings that are silent failures if missed, both set in
`workers/asr/index.ts`:

- `env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('wasm/')`.
  Otherwise Transformers.js fetches the ORT wasm from a CDN, which MV3 blocks.
- `env.backends.onnx.wasm.numThreads = 1`. Threaded wasm wants
  `SharedArrayBuffer`, which wants cross-origin isolation, which extension
  pages do not have.

## B.6 **NOT RUN** — everything that needs a browser

Three of section B's questions cannot be answered from Node, and loading an
unpacked extension is not automatable (same wall as section A.3):

| # | Question | Status |
|---|---|---|
| B.6.1 | Is WebGPU available in a worker spawned from the offscreen document? | open |
| B.6.2 | RTF per model size on WebGPU | open — only CPU numbers above |
| B.6.3 | GPU memory and adapter name | open |
| B.6.4 | WebGPU download sizes (fp32 encoder + q4 decoder, not q8) | open |

**What I expect.** WebGPU has been available in dedicated workers since Chrome
113, and an offscreen document is an ordinary extension page, so
`navigator.gpu` should be there. It is not guaranteed: extension pages have
their own permissions surface, and a worker two levels down from the service
worker is exactly where an assumption like this breaks. `pickBackend()` falls
back to WASM either way and `onBackend` reports which one won, so a wrong
guess degrades rather than fails.

**Protocol**, once the offscreen document spawns the worker (E's wiring — see
SPIKES A.4). In the worker console:

```js
console.log('gpu?', 'gpu' in navigator);
const adapter = await navigator.gpu?.requestAdapter();
console.log('adapter', adapter?.info ?? await adapter?.requestAdapterInfo?.());
```

Then watch for the `backend` message the worker posts on load, and read RTF
off the `metrics` messages (`stage: 'asr'`). For the browser equivalent of the
table above, run `bench/run.ts --device webgpu` — it drives the same
`WhisperEngine`, so only the device differs — but it needs a browser host to
run in, which does not exist yet.

## B.7 Contract gaps

The worker posts `backend`, `language`, `ready` and `modelsDeleted` messages
that `/shared/messages.ts` does not define, and accepts a `deleteModels` it
does not define either. Written up as B-1 and B-2 in
[CONTRACT_CHANGE_REQUEST.md](./CONTRACT_CHANGE_REQUEST.md).

---

# Section C — Translation

Owner: C · Last updated: 2026-09-19 · Verified in Chrome 153 and Node on Apple M4

## C.1 Where the Translator API is callable

The question the task asks. Measured by running the check in each context
rather than reading the docs:

| Context | `Translator` | `LanguageDetector` | Verified |
|---|---|---|---|
| Window (page main world) | `function` | `function` | **yes**, Chrome 153 |
| Dedicated Worker | `undefined` | `undefined` | **yes**, Chrome 153 |
| Offscreen document | expected `function` | expected `function` | **no** — see C.6 |
| Content script | expected `function` | expected `function` | **no** — isolated world untested |

The worker result is the one that shapes the code. A `Worker` created from a
page — the same way the offscreen document creates the MT worker — has
neither global:

```js
const w = new Worker(URL.createObjectURL(new Blob([
  `self.postMessage({ Translator: typeof self.Translator,
                      LanguageDetector: typeof self.LanguageDetector });`
])));
// → { Translator: "undefined", LanguageDetector: "undefined" }
```

So the two backends **cannot live in the same place**: `ChromeTranslator` runs
on the offscreen document's main thread, and the Transformers.js fallback runs
in `workers/mt`. That is why `TranslationService` composes two objects rather
than switching inside one.

Availability on this machine, all packs not yet fetched:

```
es→en: downloadable   ja→en: downloadable   de→fr: downloadable
LanguageDetector: available
```

## C.2 The user-gesture wall, and why it is structural

`Translator.create()` refuses to fetch a language pack without transient user
activation. The exact rejection:

```
NotAllowedError: Requires a user gesture when availability is
"downloading" or "downloadable".
```

**An offscreen document can never satisfy this.** It is not a surface the user
can click, so `navigator.userActivation.isActive` is false there forever. The
gesture has to happen somewhere the user actually is — the popup.

Language packs are stored per browser profile, so this works out: the popup
downloads the pack once inside a click handler, and from then on every context
sees `availability: 'available'` and can call `create()` with no gesture at
all. The flow is therefore:

1. Offscreen tries `ChromeTranslator`, gets `LanguagePackRequiredError`.
2. It reports the pair, and **falls back to local MT immediately** so captions
   keep flowing rather than stopping on a modal.
3. The popup shows a "Download language pack" button. D calls
   `downloadLanguagePack(src, tgt, onProgress)` from
   `offscreen/translate/chrome-translator.ts` inside the click handler.
4. Next line picks Chrome up automatically — selection is per pair and the
   fallback is re-evaluated when the service is rebuilt.

The message for step 2 is filed as
[C-1](./CONTRACT_CHANGE_REQUEST.md); `error` carries it in the meantime.

## C.3 LanguageDetector

Already `available` with no download, and confident on single caption lines:

| Input | Top result |
|---|---|
| "Buenos días, ¿cómo estás hoy?" | `es` 1.000 |
| "おはようございます、今日はいい天気ですね" | `ja` 0.997 |
| "Guten Morgen, wie geht es dir?" | `de` 1.000 |

`detect()` returns a descending list and always includes an `und` entry, so
callers want the first non-`und` result above a confidence floor. Used only
when `srcLang` is `'auto'` **and** Whisper reported nothing — B's detector
works off the audio, which is better evidence than the text it produced.

## C.4 Local MT: what the models actually do

### Model resolution

opus-mt ids are built and tried, not looked up in a table — a hardcoded list
would be wrong as soon as someone publishes another pair. Checked against the
hub: `es-en`, `fr-en`, `de-en`, `ja-en`, `zh-en`, `ko-en`, `ru-en`, `it-en`,
`en-es`, `en-fr`, `en-de`, `en-zh`, `mul-en` all exist; `pt-en` does not;
`es-ja` and `fr-ja` do not. Japanese is spelled `jap` as a target
(`opus-mt-en-jap`, not `-en-ja`). Anything that 404s falls through to NLLB.

### Prepending context silently loses sentences

The finding that shaped the design. Feeding opus-mt
`"Ayer fui al mercado. Compré unas manzanas rojas. Estaban muy ricas."`:

| Separator | Output |
|---|---|
| `" "` | "I bought some red apples, they were very good." |
| `" \|\|\| "` | "I bought some red apples, they were very good." |
| `"\n"` | "I bought some red apples, they were very good." |
| `" <sep> "` | "Yesterday I went to the market. I bought some red apples. They were very good." |

The first sentence is **gone** in three of four. You cannot strip what the
model never emitted, so "prepend and strip" is not reliable on its own.

What works is prepend, strip, and then *check*: the output must come back with
exactly `contextCount + 1` sentences, or the result is discarded and the
sentence is translated again on its own. Across 5 cases the check passed 5/5
and no second pass was needed — and the context earned its keep at least once:

```
with context: "It's very big."      (context: "Tengo un perro. Se llama Max.")
alone:        "It's too big."
```

The `<sep>` marker sometimes survives into the output and sometimes does not,
so it is stripped unconditionally.

Also: **do not batch**. Passing an array to the opus-mt pipeline produces
runaway trailing dots — `"I went to the market yesterday......................."`.
One string per call.

### gloss() by difference

Translating a word alone loses the sense the sentence gives it. Translating
the sentence with and without the word, then taking the difference, recovers
it. Real output:

| Sentence | Word | Alone | By difference |
|---|---|---|---|
| "Estaban muy ricas." | ricas | rich | **good** |
| "Voy a sentarme en el banco del parque." | banco | bank | **bench** |
| "El banco está cerrado." | banco | bank | **bank** |
| "Compré unas manzanas rojas." | manzanas | apples | **apples** |

Two translations instead of one, and it gets both senses of *banco* right.
When the difference is empty or larger than five tokens — removing the word
reshaped the sentence — it falls back to the word alone.

### NLLB fallback works, and it is expensive

`Xenova/nllb-200-distilled-600M` handles the pairs opus-mt lacks:

```
es→ja  "Buenos días, ¿cómo estás hoy?"   → "こんばんは 今日はどうですか?"
es→ja  "Me gustaría aprender japonés."   → "日本語を学びたい."
fr→ja  "Bonjour, comment allez-vous ?"   → "こんにちは どうですか?"
```

| Model | Disk (q8) | Per-sentence latency (CPU) |
|---|---|---|
| `opus-mt-es-en` | 116 MB | ~0.2 s |
| `nllb-200-distilled-600M` | **881 MB** | 0.3–1.0 s |

881 MB is more than three times Whisper `small`, for one fallback. Worth
surfacing in the popup before a user picks a pair that lands on it.

## C.5 Part of speech is not obtainable

`Gloss.pos` is optional, and none of the three backends can fill it. Chrome's
Translator API returns a string and nothing else. opus-mt and NLLB are
seq2seq translators with no tagging head. Getting POS would mean shipping a
fourth model purely to label one word in a popover.

So `pos` is left `undefined` everywhere except `MockTranslator`, which sets it
so D can build the popover against a populated field. If it turns out to
matter, a small POS tagger is its own task, not a tweak to this one.

## C.6 **NOT RUN** — the offscreen document itself

| # | Question | Status |
|---|---|---|
| C.6.1 | Are `Translator`/`LanguageDetector` present in an offscreen document? | open |
| C.6.2 | Are they present in a content script's isolated world? | open |
| C.6.3 | Does a pack downloaded from the popup really make the offscreen document's `create()` succeed? | open |

Same wall as sections A and B: this needs the extension loaded, which is not
automatable. An offscreen document is an ordinary extension page, so C.6.1
should be a yes — but it is exactly the kind of assumption that breaks, and
the whole `ChromeTranslator` path rests on it. If it is a no, the API has to
move to the content script and the adapter plan in
[C-1](./CONTRACT_CHANGE_REQUEST.md) covers it.

`chromeTranslatorSupported()` is checked at construction, so a no degrades to
local MT rather than throwing.

**Protocol.** In the offscreen document's console:

```js
console.log('Translator' in self, 'LanguageDetector' in self);
await Translator.availability({ sourceLanguage: 'es', targetLanguage: 'en' });
```

For C.6.3, download a pack from the popup, then re-run the above and call
`Translator.create({sourceLanguage:'es', targetLanguage:'en'})` in the
offscreen console — it must resolve without a gesture.

## C.7 A build regression I caused

Both workers now import Transformers.js, so Rollup hoists it into a shared
chunk (`dist/chunks/transformers.web-*.js`, 2.0 MB / 333 kB gzip) rather than
duplicating it — good. But the hoist also made Vite emit
`dist/assets/ort-wasm-simd-threaded.jsep.wasm`, **21.6 MB**, byte-identical to
the copy the build plugin already puts in `dist/wasm/`. `dist` is now 58 MB,
about 21 MB of which is dead: both workers set
`env.backends.onnx.wasm.wasmPaths` to `dist/wasm/`, so the emitted asset is
never loaded.

The fix belongs in `extension/vite.config.ts`, which is frozen, so it is filed
as [C-3](./CONTRACT_CHANGE_REQUEST.md). Nothing is broken in the meantime —
it is package size, not behaviour.

---

# Section D — Overlay and popup

Owner: D · Last updated: 2026-09-19

## D.1 Caption timing: lateness is the whole problem

Recognition takes a second or two, so a caption usually arrives **after** the
audio it describes has played. Showing only lines whose
`[videoStart, videoEnd]` window contains the playhead leaves the overlay blank
most of the time, which reads as broken.

`pickActive` in `content/captions.ts` therefore resolves in this order:

1. A line whose window covers the playhead. Latest start wins, so a short line
   inside a long one takes over.
2. Otherwise the line that ended most recently, for `LINGER_SEC` (2.5 s) of
   video time — the way a subtitle track holds the last cue.
3. Otherwise nothing.

A line whose `videoStart` is more than 0.25 s ahead of the playhead never
shows. That is the rule that makes seeking backwards behave: captions for
later in the video are in the store but must not appear.

All of it is a pure function over an array, so the rules are tested without a
clock, a DOM or a video. Seventeen cases in `captions.test.ts`.

## D.2 Interim handling

Interim segments carry the same `id` as the final that replaces them, so the
store is a `Map` keyed on id and the replacement is an upsert. Interim text is
greyed and italic; the final clears the class.

The overlay only rebuilds its word spans when the id, the interim flag, the
original or the translation actually change. Rebuilding on every frame would
drop an open gloss popover and destroy any text selection — the render loop
runs at 60 Hz, the captions do not.

## D.3 Fullscreen re-parenting, including the case that cannot work

Nothing outside `document.fullscreenElement` is rendered in fullscreen, so the
overlay has to move inside it. `overlayParent(doc)` returns:

| State | Parent |
|---|---|
| Not fullscreen | `document.body` |
| A wrapper element is fullscreen (what real players do) | that element |
| **The bare `<video>` is fullscreen** | **null — cannot overlay** |

The third case is a genuine dead end, not an oversight: a `<video>` element
renders no children, so there is nowhere to put anything. `reparent()` returns
false and detaches rather than leaving the overlay stranded behind the
fullscreen layer, and recovers when fullscreen exits. YouTube, Vimeo and the
HTML5 players I know of fullscreen a container, so this should be rare — but a
page that calls `video.requestFullscreen()` directly will have no captions,
and the only fixes are invasive (wrapping the video, or exiting and re-entering
fullscreen on our own element).

Tested against jsdom with `document.fullscreenElement` stubbed, including the
round trip back out and re-parenting while a caption is on screen.

## D.4 What is verified, and what is not

### D.4.1 Verified in a real browser

Loaded `src/content/dev/index.html` through the Vite dev server in Chrome 153
and inspected the live DOM:

```
hostParent:          BODY
shadowMode:          open
styleInsideShadow:   true
styleLeakedToPage:   false
overlayBox:          left: 130px; top: 102.056px; width: 900px; height: 150px;
```

The overlay mounts, the shadow root is open, the stylesheet is inside it and
has not leaked into the page, and the box tracks the video's bounding rect.

### D.4.2 **NOT RUN**

| # | Question | Status |
|---|---|---|
| D.4.2.1 | Live caption rendering during playback | open — see below |
| D.4.2.2 | Does a strict-CSP site (YouTube) block the shadow-root `<style>`? | open |
| D.4.2.3 | Popup rendering and its message round trips | open — needs the extension loaded |
| D.4.2.4 | Overlay behaviour on a real player's fullscreen | open |

**Why D.4.2.1 could not be automated.** The render loop is
`requestAnimationFrame`, and Chrome pauses rAF in a tab that is not in the
foreground. Driving the harness from automation leaves the tab backgrounded,
so the loop never runs and the overlay never updates — `currentTime` stayed at
0 across four probes. This is correct product behaviour (there is nothing to
draw for a tab nobody is looking at) and it is a real limit on automated
checking. The rendering rules are covered by the 22 jsdom tests in
`overlay.test.ts` instead.

D.4.2.2 is the one with teeth. Content scripts are generally exempt from the
host page's CSP for what they inject, but "generally" is doing work in that
sentence and the overlay is unusable if `style-src` blocks its stylesheet. If
it does, the styles move to `content_scripts[].css` in the manifest — noted in
[D-1](./CONTRACT_CHANGE_REQUEST.md).

**Protocol.** Load `extension/dist` unpacked, open a YouTube video, and in the
page console:

```js
const host = document.querySelector('[data-subtle="overlay"]');
getComputedStyle(host.shadowRoot.querySelector('.root')).position; // want "fixed"
```

`"static"` means the stylesheet was blocked. Check the console for a CSP
violation naming `style-src`.

## D.5 The dev harness

`src/content/dev/index.html` runs the **real** `Overlay` and `CaptionStore`
against `MockRecognizer` and `MockTranslator` from `/shared/mocks`, so the
caption stream has the timing and the interim-then-final shape the real
pipeline produces. No audio, no models, no extension.

```bash
pnpm --filter @subtle/extension exec vite
# → http://localhost:5173/src/content/dev/index.html
```

It records an 8 s canvas clip so there is a seekable video to sit on, with a
"Use a local video…" button for a real one. Buttons toggle translation,
immersion and captions, replay the last line, and fullscreen the wrapper —
which is the case D.3 cares about.

The clip is generated on `setInterval` rather than `requestAnimationFrame`:
rAF is paused in a background tab, and the first version silently never
finished loading if the tab was not focused.

## D.6 Contract gaps

Two, both filed:

- **[D-1](./CONTRACT_CHANGE_REQUEST.md)** — `chrome.commands` needs a
  `commands` block in the frozen manifest. Alt+Shift chords on `keydown` stand
  in; they work, but they cannot be rebound and a player that swallows keydown
  first will beat them.
- **[D-2](./CONTRACT_CHANGE_REQUEST.md)** — `videoSync` asks the content
  script for `audioTime` (the offscreen AudioContext clock) and `tabId`,
  neither of which a content script can know. Both are filled by the receiver;
  **E has to overwrite them on receipt** or every caption lands on a clock with
  an arbitrary offset and `isSeek()` fires on every sync.

---

# Section E — Integration

Owner: E · Last updated: 2026-09-19 · Chrome 153, Apple M4

## E.1 The pipeline runs end to end

`e2e/pipeline.spec.ts` drives the unpacked extension in headed Chrome and
passes on all three model sizes. Numbers in [RESULTS.md](./RESULTS.md).

Wiring it together turned up five bugs, four of them invisible to unit tests
because every one lives at a context boundary that only exists in a real
browser. They are written up in [BUGS.md](./BUGS.md); the two findings worth
repeating here are E-1/E-2 and E-3, because both are about the same thing:
**the extension APIs available to you depend on which context you are in, and
nothing warns you.**

| Context | `chrome.runtime` | `chrome.tabs` | `Translator` | WebGPU |
|---|---|---|---|---|
| Service worker | yes | yes | — | — |
| Offscreen document | yes | **no** | expected yes | yes |
| Dedicated worker | **no** | **no** | **no** | **yes** |
| Content script | yes | no | expected yes | — |

The `chrome` row for dedicated workers is E-1: both workers called
`chrome.runtime.getURL()` at module scope and died with
`ReferenceError: chrome is not defined` before handling a single message. The
`chrome.tabs` row is E-3: the offscreen document's `chrome.tabs.sendMessage`
was a silent no-op, so captions were produced and then thrown away. Both
typecheck cleanly, because `@types/chrome` is a global declaration with no
runtime counterpart.

Captions now go offscreen → `chrome.runtime` → service worker →
`chrome.tabs.sendMessage`, under an internal `relayToTab` envelope.

## E.2 WebGPU **is** available in a worker spawned from the offscreen document

This was SPIKES B.6.1, open since section B. Answered:

```
asr backend  webgpu
gpu          apple metal-3
```

read live from the debug panel during a run. Whisper runs on WebGPU in the ASR
worker at RTF 0.07 (tiny) to 0.24 (small).

The translation worker is a different story — see BUGS.md E-5. opus-mt asked
for WebGPU and the load hung forever with no error and no progress. Pinned to
WASM, where it does 708–785 ms per line.

So: **WebGPU in an extension worker works, but per model, not per platform.**
Whisper has a working export; Marian does not. Anything new should be proven on
WebGPU before it is given `pickBackend()`.

## E.3 Captions must not wait on translation

The first wiring translated before emitting, which meant the first caption of a
session waited for the MT weights to download — minutes, for text the user
could already have been reading. Worse, when translation hung (E-5) no caption
appeared at all and the failure looked like a broken recognizer.

The offscreen document now emits the original immediately and re-emits the same
id once the translation lands. The overlay upserts by id, so the line fills in
where it already is. Cost: two messages per caption instead of one.

## E.4 Where the 2.4 s of latency actually goes

ASR is ~450 ms and translation ~600 ms on `tiny`, but a caption reaches the
screen 2.4 s after the speech ends. The rest is the VAD: `minSilenceMs` is
400 ms and the test clip is one unbroken 4.33 s utterance, so nothing is
emitted until the speaker stops.

Faster inference will not move this number. Shorter `maxChunkSec` and interim
segments will. Worth knowing before anyone optimises the wrong stage.

## E.5 Network during playback is 0

The debug panel counts `PerformanceObserver` resource entries with a non-zero
transfer size, in the offscreen document and in both workers — each context has
its own resource timeline, so the workers report their own counts up.

Every warm run reads `requests 0 (os 0 asr 0 mt 0)`. Cache API hits produce no
entry, so a cached model load is correctly invisible and the zero means what it
should: nothing went out over the wire while captioning.

## E.6 **NOT RUN** — `chrome.tabCapture`

The one part of the pipeline the e2e cannot reach.

`chrome.tabCapture.getMediaStreamId` needs an `activeTab` grant, and an
`activeTab` grant needs a genuine click on the extension's action. Playwright
can dispatch input to a page; it cannot click browser chrome, and there is no
API to grant `activeTab` directly. Declared `commands` do grant it, but a
command is handled by the browser and CDP's synthesised key events do not
trigger one.

So the e2e injects the clip into the offscreen document with `debugStart`
instead. Everything downstream is the shipping code path — same workers, same
timing, same messages, same overlay. What is untested is `startCapture` itself:
`getUserMedia` with `chromeMediaSource: 'tab'`, the worklet, and the
`ReadableStream` plumbing. Section A.3 already had those as manual steps, and
they stay manual.

**Protocol.** Load `extension/dist`, click the action, press Start in the
popup, and confirm the badge reads `ON` and the debug panel's `capture` row
reads `running` with `dropped` at 0. Then work through SPIKES A.3.
