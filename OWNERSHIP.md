# Ownership

One directory has one owner. Edit only what you own. Everything you need from
someone else's territory comes from `/shared` — the interface, and a mock in
`/shared/mocks` that satisfies it today.

| | Area | Owns |
|---|---|---|
| **A** | Capture | `extension/src/sw`, `extension/src/offscreen/capture`, `extension/src/worklets` |
| **B** | Speech | `extension/src/workers/asr`, `bench/` |
| **C** | Translation | `extension/src/offscreen/translate`, `extension/src/workers/mt` |
| **D** | Overlay / UI | `extension/src/content`, `extension/src/popup` |
| **E** | Integration | `extension/src/offscreen/index.ts`, `e2e/`, `extension/src/debug` |
| **F** | Dubbing | `extension/src/offscreen/dub` |

Repo root config, `/shared`, `extension/manifest.json` and the Vite build
config are owned by the scaffold and are frozen.

## /shared is frozen

`/shared` is the contract every context compiles against. Do not edit it.

If you need a contract change — a new message, a new field, a different
signature — write `CONTRACT_CHANGE_REQUEST.md` at the repo root saying what
you need and why, then keep going against the current contract with a local
adapter. Changing `/shared` unilaterally breaks five other people's builds.

## What each stub gives you today

Every entry file compiles, logs `[subtle] <name> ok`, and is wired to the
mocks. Replace your own; leave the rest alone.

- `workers/asr` — `MockRecognizer`, scripted German segments on a timer
- `workers/mt` — `MockTranslator`, returns `[en] <text>`
- `worklets/resampler` — passthrough, counts blocks
- `sw`, `offscreen`, `content`, `popup` — log and listen, nothing else

## Things nobody owns yet

`web_accessible_resources` is not in the manifest. D will need it if the
overlay loads a font or stylesheet from the extension — that is a manifest
change, so it goes through a contract change request.
