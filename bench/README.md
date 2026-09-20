# bench

Whisper accuracy and speed over a folder of clips, out as a markdown table.

It drives `extension/src/workers/asr/whisper.ts` directly rather than a copy,
so what is measured is what ships. The only difference is `device`: Node has
no WebGPU, so `--device cpu` runs onnxruntime-node.

## Running it

```bash
node make-clips.mjs ./clips                          # macOS only, see below
node run.ts --clips ./clips --models tiny,base,small
```

Options: `--clips <dir>` `--models tiny,base,small` `--device cpu|wasm|webgpu`
`--out RESULTS.md`. Weights are cached in `./.cache` and downloads are slow the
first time — `small` is 259 MB.

## Clip folder layout

```
clips/
  en/en-01.wav   en/en-01.txt     ← 16 kHz mono WAV + reference transcript
  es/es-01.wav   es/es-01.txt
  fr/…  ja/…
```

The directory name is the language code. It picks the metric from it: **CER**
for `ja`/`zh`/`ko`, **WER** for everything else. Both are Levenshtein over
normalized text — lowercased, punctuation stripped, whitespace collapsed.

## About the generated clips

`make-clips.mjs` synthesises the clips with macOS `say`. They are clean,
evenly paced and free of background noise, and there are three per language.

**The error rates from them are a floor, not a forecast.** Ranking languages
off three TTS clips is meaningless. What they are good for is the RTF column
and for smoke-testing the harness without shipping audio. Point `--clips` at
real recordings before quoting any number.

Neither `clips/` nor `.cache/` is committed.
