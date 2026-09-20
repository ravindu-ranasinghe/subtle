# Measured end to end

Every number here comes from `e2e/pipeline.spec.ts` driving the unpacked
extension in headed Chrome 153. Run it yourself with:

```bash
pnpm build
cd e2e && SUBTLE_MODEL=base pnpm exec playwright test
```

**Machine:** Apple M4, 10 cores, 16 GB, macOS 26.6.2 · **GPU adapter:**
`apple metal-3` · **ASR backend:** WebGPU on all three sizes · **Translation:**
`local-mt` (opus-mt-es-en) on WASM, see BUGS.md E-5.

**Clip:** 4.33 s of Spanish TTS, injected three times with 2 s of silence
between, against the reference
*"Buenos días. Me gustaría aprender español contigo. El tren llega a las siete."*

## Latency

`lag` is the user-facing number: how long after the speech finished the caption
was actually on screen, read off `video.currentTime` in the page. The task's
budget is 3 s.

| model | captions | WER | lag median | lag max | RTF | peak RSS |
|---|---|---|---|---|---|---|
| tiny | 5 | 15.4% | **2.40 s** | 2.75 s | 0.07 | 2693 MB |
| base | 3 | 15.4% | **2.47 s** | 2.82 s | 0.11 | 2763 MB |
| small | 2 | **0.0%** | **2.71 s** | 2.94 s | 0.24 | 3377 MB |

Per stage, in milliseconds:

| model | vad p95 | asr | translate | render |
|---|---|---|---|---|
| tiny | 19 | 346 / 425 / 458 | 441 / 763 | 2–19 |
| base | 27 | 481 / 523 / 632 | 708 / 758 | 0–14 |
| small | 52 | 1130 / 1138 / 1295 | 785 | 5–7 |

**Read the percentiles with suspicion.** Three injections of one clip produce
two to five captions per run, so "p95" over that is a single sample. The
medians and the ranges are worth something; anything finer is not. The RTF
column is the number to trust — it is a ratio over the whole run.

## What the latency is made of

For `tiny`, a 2.40 s median lag against ~450 ms of ASR and ~600 ms of
translation means **most of the delay is not inference**. It is the VAD waiting
to be sure the utterance has ended: `minSilenceMs` is 400 ms, and the clip is
one continuous 4.33 s utterance, so nothing is emitted until the speaker stops
and the whole thing is transcribed at once.

That is the right behaviour for accuracy and the wrong one for feeling live.
The lever is `maxChunkSec` (currently 5 s) — shorter chunks mean captions land
mid-sentence, at some cost in accuracy across the seam. Interim segments exist
for exactly this and are worth turning up before anyone optimises inference.

`small` at RTF 0.24 has four times the headroom it needs, and its WER is 0%
on this clip. The queue guard never fired on any run.

## Network

**0 requests during playback, on every run**, once the weights are cached —
`os 0 asr 0 mt 0` in the debug panel, counting only entries with a non-zero
transfer size. A cold profile (`SUBTLE_CLEAN_PROFILE=1`) downloads ~45 MB for
`tiny` plus ~116 MB for opus-mt-es-en before the first caption.

## Memory

Peak RSS is **every Chrome process belonging to the test profile** — browser,
renderer, GPU and utility — sampled every 2 s. It is not the extension's
footprint; a browser sitting idle on this machine accounts for a large part of
it. The useful figure is the delta between sizes: **+70 MB from tiny to base,
+614 MB from base to small**, which tracks the weights.

## Caveats

- The clip is text-to-speech: clean, evenly paced, no background. WER here is a
  floor. See bench/README.md.
- `chrome.tabCapture` is not exercised — see SPIKES section E.
- `small` at 2.94 s max lag is inside the 3 s budget but not by much. On a
  slower machine, or with a longer utterance, it would exceed it.
