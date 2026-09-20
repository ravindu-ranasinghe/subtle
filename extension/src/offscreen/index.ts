/**
 * The offscreen document: the only place that owns audio, models and the
 * clock. The service worker coordinates and gets killed; this does the work.
 *
 * Flow for one line of speech:
 *
 *   tabCapture → resampler worklet → 16 kHz chunks
 *     → asr worker (VAD + Whisper)      → segment on the audio clock
 *     → TranslationService (bounded finals) → translation
 *     → /shared/timing against the latest videoSync → video clock
 *     → chrome.tabs.sendMessage → the overlay
 */

import {
  DEFAULT_CONFIG,
  isAudioChunk,
  isBackend,
  isCaption,
  isDeleteModels,
  isDetectedLanguage,
  isError,
  isGlossRequest,
  isMetrics,
  isModelProgress,
  isModelsDeleted,
  isSeek,
  isSegment,
  isSetConfig,
  isStart,
  isStop,
  isVideoSync,
  toVideoRange,
  type Caption,
  type Clock,
  type Config,
  type Segment,
} from '@subtle/shared';
import {
  captureStats,
  setPassthroughGain,
  startCapture,
  startCaptureFromStream,
  stopCapture,
} from './capture/capture.js';
import { SpeechDubber, voicesReady } from './dub/dubber.js';
import { NeuralDubber } from './dub/neural.js';
import {
  ChromeTranslator,
  LocalMTTranslator,
  TranslationService,
  chromeTranslatorSupported,
} from './translate/index.js';
import { NetworkCounter } from '../debug/network.js';
import { StageStats, type DebugSnapshot, type Environment } from '../debug/stats.js';

/** How often the debug snapshot goes to the tab. */
const DEBUG_INTERVAL_MS = 500;
/** Context carried into translation: the previous finals. */
const CONTEXT_LINES = 3;

interface Session {
  tabId: number;
  config: Config;
  ctx: AudioContext;
  /** Null for an injected session, which has no capture stream to drain. */
  reader: ReadableStreamDefaultReader<{ samples: Float32Array; audioStart: number }> | null;
  stopped: boolean;
  /** True when audio arrives as messages rather than from tabCapture. */
  injected: boolean;
  /**
   * Injected chunks are stamped from zero, but every clock downstream is the
   * AudioContext's. Without rebasing, `audioToVideo` maps a segment at 2 s
   * against a sync at 30 s and clamps every caption to the start of the video.
   */
  injectOrigin: number | null;
}

let session: Session | null = null;
let asr: Worker | null = null;
let mt: Worker | null = null;
let translation: TranslationService | null = null;
/** Built lazily: no point loading voices for a user who never turns dubbing on. */
let dubber: NeuralDubber | null = null;
let dubStatus = '';

/** Latest videoSync, with the two receiver-owned fields already corrected. */
let clock: Clock | null = null;
const context: string[] = [];
let generation = 0;
let audioCutoff = 0;
let translating = false;
const revisions = new Map<string, Segment>();
let pendingSegment: { segment: Segment; startedAt: number } | null = null;
/** Drop stale work instead of letting model downloads create a growing delay. */
const MAX_CAPTION_AGE_SEC = 4;

function resetTimeline(): void {
  generation++;
  audioCutoff = session?.ctx.currentTime ?? 0;
  pendingSegment = null;
  revisions.clear();
  context.length = 0;
  translation?.resetContext();
  dubber?.stop();
}

const stats = new StageStats();
const network = new NetworkCounter();
const workerNetwork = { asr: 0, mt: 0 };
let backendInfo: { backend: string; adapter: string | null } = { backend: '—', adapter: null };
let rtf: number | null = null;
let queueSeconds = 0;
let debugTimer: ReturnType<typeof setInterval> | null = null;

// ------------------------------------------------------------------ output

function toSw(message: unknown): void {
  void chrome.runtime.sendMessage(message).catch(() => {
    // The service worker is asleep and the popup is closed. Nothing to do.
  });
}

/**
 * An offscreen document only gets `chrome.runtime` — `chrome.tabs` is not
 * part of its API surface, so it cannot talk to a content script directly
 * (BUGS.md E-3). Everything for the tab goes through the service worker,
 * which can. The envelope is internal to this pair and never leaves it.
 */
function toTab(message: unknown): void {
  const tabId = session?.tabId;
  if (tabId === undefined) return;
  void chrome.runtime.sendMessage({ type: 'relayToTab', tabId, payload: message }).catch(() => {
    // The service worker is starting up; the next snapshot will get through.
  });
}

/**
 * What this offscreen document can actually reach. Each of these was an
 * assumption that turned out to matter; the debug panel shows them so the
 * next surprise is visible rather than silent.
 */
const ENVIRONMENT: Environment = {
  tabs: typeof chrome.tabs?.sendMessage === 'function',
  translator: typeof (self as { Translator?: unknown }).Translator === 'function',
  languageDetector: typeof (self as { LanguageDetector?: unknown }).LanguageDetector === 'function',
  speechSynthesis: typeof speechSynthesis !== 'undefined',
  webgpu: typeof (navigator as { gpu?: unknown }).gpu !== 'undefined',
};

function fail(stage: 'capture' | 'model' | 'vad' | 'asr' | 'translate' | 'render', err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[subtle] ${stage}:`, err);
  toSw({ type: 'error', stage, message });
}

// ------------------------------------------------------------------ workers

function spawnWorkers(): void {
  if (asr && mt) return;
  asr = new Worker(chrome.runtime.getURL('workers/asr.js'), { type: 'module' });
  mt = new Worker(chrome.runtime.getURL('workers/mt.js'), { type: 'module' });
  asr.addEventListener('message', onAsrMessage);
  asr.addEventListener('error', (e) => fail('asr', e.message));
  mt.addEventListener('error', (e) => fail('translate', e.message));
  mt.addEventListener('message', (e: MessageEvent) => {
    const data = e.data as { type?: string; count?: number };
    if (isModelProgress(e.data) || isError(e.data)) toSw(e.data);
    if (data?.type === 'network') workerNetwork.mt = data.count ?? 0;
  });

  translation = new TranslationService({
    local: new LocalMTTranslator(mt),
    onMetrics: (m) => {
      stats.record('translate', m.ms);
      toSw({ type: 'metrics', ...m });
    },
    onLanguagePackRequired: (src, tgt) => toSw({ type: 'languagePackRequired', src, tgt }),
  });
}

function onAsrMessage(event: MessageEvent): void {
  const message: unknown = event.data;

  if (isSegment(message)) {
    void onSegment(message);
    return;
  }
  if (isMetrics(message)) {
    stats.record(message.stage, message.ms);
    if (message.rtf !== undefined) rtf = message.rtf;
    toSw(message);
    return;
  }
  if (isBackend(message)) {
    backendInfo = { backend: message.backend, adapter: message.adapter ?? null };
    toSw({ ...message, ...describeTranslator() });
    return;
  }
  if (isModelProgress(message) || isDetectedLanguage(message) || isModelsDeleted(message)) {
    if (isDetectedLanguage(message) && session) void translation?.prepare(message.lang, session.config.tgtLang).catch(() => {});
    toSw(message);
    return;
  }
  if (isError(message)) {
    toSw(message);
    return;
  }
  const data = message as { type?: string; count?: number; seconds?: number };
  if (data?.type === 'network') workerNetwork.asr = data.count ?? 0;
  if (data?.type === 'queue') queueSeconds = data.seconds ?? 0;
}

/**
 * Speaks a finished translation over the original. Fire and forget: a dub that
 * cannot play must never hold up the caption that goes with it.
 */
function prepareDub(config: Config): void {
  if (!config.dubbing) return;
  dubber ??= new NeuralDubber({
    context: () => session?.ctx ?? null,
    onDuck: (gain, ramp) => setPassthroughGain(gain, ramp),
    onStatus: (text) => { dubStatus = text; toSw({ type: 'dubStatus', text }); },
    onError: (message) => fail('render', `Dubbing: ${message}`),
  });
  dubber.prepare(config.tgtLang);
}

function dub(caption: Caption, config: Config, audioEnd: number): void {
  const active = session;
  if (!config.dubbing || !caption.translation.trim() || !active || clock?.paused) return;
  if (active.ctx.currentTime - audioEnd > MAX_CAPTION_AGE_SEC) return;
  prepareDub(config);
  const budget = Math.max(1, (caption.videoEnd - caption.videoStart) / (clock?.playbackRate || 1));
  void dubber!.speak(caption.translation, config.tgtLang, active.ctx.currentTime, budget);
}

function describeTranslator(): { translator?: 'chrome-translator' | 'local-mt'; translationModel?: string } {
  const active = translation?.active;
  if (active === 'chrome-translator' || active === 'local-mt') return { translator: active };
  return {};
}

// ----------------------------------------------------------------- captions

/** One translation in flight and one latest pending line: never queue a video behind a download. */
async function onSegment(segment: Segment): Promise<void> {
  if (!session || session.stopped || clock?.paused || segment.audioStart < audioCutoff) return;
  if (session.ctx.currentTime - segment.audioEnd > MAX_CAPTION_AGE_SEC) return;
  const startedAt = performance.now();
  emit(segment, '', startedAt);
  if (!session.config.showTranslation && (!session.config.dubbing || segment.interim)) return;
  revisions.set(segment.id, segment);
  if (revisions.size > 300) revisions.delete(revisions.keys().next().value!);
  // Keep a pending final ahead of an optional preview, so dubbing still gets
  // completed lines when translation runs slower than recognition.
  if (segment.interim && pendingSegment && !pendingSegment.segment.interim) return;
  pendingSegment = { segment, startedAt };
  if (translating) return;
  translating = true;
  try {
    while (pendingSegment && session) {
      const job = pendingSegment;
      pendingSegment = null;
      const active: Session = session;
      const config = active.config;
      const version = generation;
      const src = config.srcLang === 'auto' ? job.segment.lang : config.srcLang;
      try {
        const translated = await translation?.translate(
          job.segment.text, context.slice(-CONTEXT_LINES), src, config.tgtLang, !job.segment.interim,
        );
        if (session !== active || version !== generation || clock?.paused) continue;
        if (active.ctx.currentTime - job.segment.audioEnd > MAX_CAPTION_AGE_SEC) continue;
        if (revisions.get(job.segment.id) !== job.segment) continue;
        if (!job.segment.interim) {
          context.push(job.segment.text);
          if (context.length > CONTEXT_LINES) context.shift();
          revisions.delete(job.segment.id);
        }
        if (translated) emit(job.segment, translated, job.startedAt);
      } catch (err) {
        if (session === active && version === generation) fail('translate', err);
      }
    }
  } finally {
    translating = false;
  }
}

function emit(segment: Segment, translated: string, startedAt: number): void {
  if (!session || session.stopped) return;
  const config = session.config;

  // Without a videoSync the page clock is unknown. Falling back to the audio
  // clock keeps captions flowing; they land on the video clock as soon as the
  // first sync arrives, which is within 2 s of the content script loading.
  const range = clock
    ? toVideoRange(clock, segment.audioStart, segment.audioEnd)
    : { videoStart: segment.audioStart, videoEnd: segment.audioEnd };

  const caption: Caption = {
    id: segment.id,
    original: segment.text,
    translation: translated,
    srcLang: config.srcLang === 'auto' ? segment.lang : config.srcLang,
    tgtLang: config.tgtLang,
    videoStart: range.videoStart,
    videoEnd: range.videoEnd,
    interim: segment.interim,
    ...(segment.words ? { words: segment.words } : {}),
  };
  toTab({ type: 'caption', ...caption });
  if (!segment.interim && translated) dub(caption, config, segment.audioEnd);

  if (!segment.interim) {
    // End to end: the moment the segment landed here through to handing the
    // caption to the tab. The render leg is measured in the content script.
    stats.record('e2e', performance.now() - startedAt);
  }
}

// -------------------------------------------------------------------- sync

/**
 * `tabId` and `audioTime` are the receiver's to fill — see the note on
 * VideoSyncMsg. Using what the content script sent would put every caption on
 * a clock with an arbitrary offset and make isSeek fire on every heartbeat.
 */
function onVideoSync(raw: { videoTime: number; paused: boolean; playbackRate: number }): void {
  if (!session) return;
  const next: Clock = {
    videoTime: raw.videoTime,
    audioTime: session.ctx.currentTime,
    paused: raw.paused,
    playbackRate: raw.playbackRate,
  };
  // A seek invalidates the captions in flight and the translation context:
  // they belong to a timeline the user just left.
  if (clock && (isSeek(clock, next) || clock.paused !== next.paused || clock.playbackRate !== next.playbackRate)) {
    resetTimeline();
  }
  clock = next;
}

// ------------------------------------------------------------ start / stop

/**
 * `stream` is only ever supplied by the capture self-test. Everything else in
 * this function is the production path — the point is that the wiring below
 * gets exercised, since `chrome.tabCapture.getMediaStreamId` cannot be reached
 * from a harness.
 */
async function start(tabId: number, streamId: string, config: Config, stream?: MediaStream): Promise<void> {
  await stop();
  spawnWorkers();
  network.reset();
  workerNetwork.asr = 0;
  workerNetwork.mt = 0;
  stats.reset();
  context.length = 0;
  clock = null;

  asr?.postMessage({ type: 'start', tabId, streamId, config });
  void translation?.prepare(config.srcLang, config.tgtLang).catch(() => {});

  let capture;
  try {
    capture = stream ? await startCaptureFromStream(stream) : await startCapture(streamId);
  } catch (err) {
    asr?.postMessage({ type: 'stop', tabId });
    throw err;
  }

  session = {
    tabId,
    config,
    ctx: capture.ctx,
    reader: capture.chunks.getReader(),
    stopped: false,
    injected: false,
    injectOrigin: null,
  };
  toTab({ type: 'setConfig', config });
  prepareDub(config);
  void pump(session);
  if (debugTimer === null) debugTimer = setInterval(publishDebug, DEBUG_INTERVAL_MS);
}

/** Drains the capture stream into the recognizer, transferring each buffer. */
async function pump(active: Session): Promise<void> {
  if (!active.reader) return;
  for (;;) {
    let next;
    try {
      next = await active.reader.read();
    } catch (err) {
      if (!active.stopped) fail('capture', err);
      return;
    }
    if (next.done || active.stopped) return;
    const chunk = next.value;
    asr?.postMessage({ type: 'audioChunk', samples: chunk.samples, audioStart: chunk.audioStart }, [
      chunk.samples.buffer,
    ]);
  }
}

async function stop(): Promise<void> {
  toTab({ type: 'clearCaptions' });
  const active = session;
  session = null;
  if (active) {
    active.stopped = true;
    asr?.postMessage({ type: 'stop', tabId: active.tabId });
    void active.reader?.cancel().catch(() => {});
  }
  resetTimeline();
  if (active?.injected) await active.ctx.close();
  await stopCapture();
  clock = null;
  context.length = 0;
  translation?.resetContext();
  if (debugTimer !== null) {
    clearInterval(debugTimer);
    debugTimer = null;
  }
  publishDebug();
}

/**
 * A model change must not interrupt capture: the audio keeps flowing into the
 * worker, which reloads underneath and picks up where it is when ready.
 */
function reconfigure(config: Config): void {
  const previous = session?.config;
  if (session) session.config = config;
  if (previous && previous.whisperModel !== config.whisperModel) {
    asr?.postMessage({ type: 'setConfig', config });
  } else if (previous && previous.srcLang !== config.srcLang) {
    asr?.postMessage({ type: 'setConfig', config });
  }
  if (previous && (
    previous.tgtLang !== config.tgtLang || previous.srcLang !== config.srcLang ||
    previous.whisperModel !== config.whisperModel || previous.dubbing !== config.dubbing ||
    previous.showTranslation !== config.showTranslation
  )) resetTimeline();
  if (session) prepareDub(config);
  if (session) void translation?.prepare(config.srcLang, config.tgtLang).catch(() => {});
}

// ------------------------------------------------------------------- debug

function publishDebug(): void {
  const capture = captureStats();
  const snapshot: DebugSnapshot = {
    env: ENVIRONMENT,
    model: session?.config.whisperModel ?? DEFAULT_CONFIG.whisperModel,
    backend: backendInfo.backend,
    adapter: backendInfo.adapter,
    translator: translation?.active ?? null,
    translationModel: null,
    rtf,
    queueSeconds,
    droppedChunks: capture?.dropped ?? 0,
    contextState: capture?.contextState ?? null,
    inputLevel: capture?.inputLevel ?? 0,
    channels: capture?.channels ?? 0,
    outputLevel: capture?.outputLevel ?? 0,
    capturing: session !== null,
    network: { offscreen: network.count.total, asr: workerNetwork.asr, mt: workerNetwork.mt },
    stages: stats.snapshot(),
  };
  toTab({ type: 'debugStats', snapshot });
}

// ------------------------------------------------------- injected audio

/**
 * Starts a session whose audio arrives as `audioChunk` messages instead of
 * from tabCapture.
 *
 * This exists because `chrome.tabCapture.getMediaStreamId` needs an
 * `activeTab` grant, and an `activeTab` grant needs a real click on the
 * extension's action — which no automation harness can produce. Everything
 * downstream of capture is identical: same workers, same timing, same
 * messages to the overlay. e2e/ uses it; the debug page can too.
 *
 * Only extension contexts can reach it (`externally_connectable` is off), and
 * it is inert unless something starts one.
 */
async function startInjected(tabId: number, config: Config): Promise<void> {
  await stop();
  spawnWorkers();
  network.reset();
  workerNetwork.asr = 0;
  workerNetwork.mt = 0;
  stats.reset();
  context.length = 0;
  clock = null;

  asr?.postMessage({ type: 'start', tabId, streamId: '', config });
  void translation?.prepare(config.srcLang, config.tgtLang).catch(() => {});
  // A real context, only for its clock: videoSync needs something to map onto.
  session = {
    tabId,
    config,
    ctx: new AudioContext(),
    reader: null,
    stopped: false,
    injected: true,
    injectOrigin: null,
  };
  toTab({ type: 'setConfig', config });
  prepareDub(config);
  if (debugTimer === null) debugTimer = setInterval(publishDebug, DEBUG_INTERVAL_MS);
}

/**
 * Runs the real capture graph against a synthetic stream and reports what came
 * out. `chrome.tabCapture.getMediaStreamId` needs an `activeTab` grant that no
 * test harness can produce, so this covers everything after it: the worklet,
 * the node graph, the chunk stream, the clock and the teardown.
 */
async function captureSelfTest(seconds: number, toneHz: number): Promise<unknown> {
  await stop();
  const source = new AudioContext();
  const osc = source.createOscillator();
  osc.frequency.value = toneHz;
  const sink = source.createMediaStreamDestination();
  osc.connect(sink);
  osc.start();

  try {
    const capture = await startCaptureFromStream(sink.stream);
    const reader = capture.chunks.getReader();
    const chunks: { length: number; audioStart: number; rms: number }[] = [];
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      const next = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((r) =>
          setTimeout(() => r({ done: true, value: undefined }), Math.max(0, deadline - Date.now())),
        ),
      ]);
      if (next.done || !next.value) break;
      let energy = 0;
      for (const v of next.value.samples) energy += v * v;
      chunks.push({
        length: next.value.samples.length,
        audioStart: next.value.audioStart,
        rms: Math.sqrt(energy / next.value.samples.length),
      });
    }
    const stats = captureStats();
    const runningState = capture.ctx.state;
    await stopCapture();
    return {
      inputRate: capture.inputRate,
      runningState,
      contextState: capture.ctx.state,
      chunks,
      delivered: stats?.delivered ?? 0,
      dropped: stats?.dropped ?? 0,
      statsAfterStop: captureStats(),
    };
  } finally {
    osc.stop();
    await source.close();
  }
}

/**
 * Exercises the Chrome Translator wrapper from the context that actually uses
 * it. The API is present in an offscreen document (measured, see SPIKES C.6),
 * but a download here can never be authorised — an offscreen document has no
 * user activation and never will.
 */
async function translatorSelfTest(src: string, tgt: string, text: string): Promise<unknown> {
  const translator = new ChromeTranslator();
  const availability = await translator.available(src, tgt);
  let translated: string | null = null;
  let error: string | null = null;
  try {
    translated = await translator.translate(text, [], src, tgt);
  } catch (err) {
    error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  // Reported separately: ChromeTranslator.detectLanguage swallows failures and
  // returns null by design, which hides whether the detector is missing or the
  // text was simply ambiguous.
  const detector = (self as { LanguageDetector?: { availability(): Promise<string> } }).LanguageDetector;
  const detectorAvailability = detector ? await detector.availability().catch(() => 'error') : 'absent';
  const detected = await translator.detectLanguage(text);
  const gloss = availability === 'yes' ? await translator.gloss('tren', text, src, tgt) : null;
  translator.destroy();
  return {
    supported: chromeTranslatorSupported(),
    availability,
    detectorAvailability,
    translated,
    error,
    detected,
    gloss,
  };
}

function isTranslatorSelfTest(
  m: unknown,
): m is { type: 'debugTranslatorSelfTest'; src: string; tgt: string; text: string } {
  return typeof m === 'object' && m !== null && (m as { type?: string }).type === 'debugTranslatorSelfTest';
}

/**
 * Plays `samples` into a MediaStream and runs the real `start()` against it,
 * so the whole chain — capture graph, worklet, pump, recognizer, translation,
 * timing, relay to the tab — runs exactly as it does in production. Only the
 * two lines that fetch a tabCapture stream are skipped.
 */
async function startFromSamples(
  tabId: number,
  config: Config,
  samples: number[],
  sampleRate: number,
): Promise<void> {
  const source = new AudioContext({ sampleRate });
  const buffer = source.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(Float32Array.from(samples), 0);
  const node = source.createBufferSource();
  node.buffer = buffer;
  node.loop = true;
  const sink = source.createMediaStreamDestination();
  node.connect(sink);
  node.start();
  await start(tabId, '__selftest__', config, sink.stream);
}

function isStartFromSamples(
  m: unknown,
): m is { type: 'debugStartCapture'; tabId: number; config?: Config; samples: number[]; sampleRate: number } {
  return typeof m === 'object' && m !== null && (m as { type?: string }).type === 'debugStartCapture';
}

/**
 * Runs the real dubber against the platform's own voices, reporting what it
 * did. Whether sound reaches a speaker cannot be asserted from a harness, but
 * everything up to `speechSynthesis.speak` can.
 */
async function dubSelfTest(text: string, lang: string, budget: number): Promise<unknown> {
  const voices = await voicesReady().catch(() => 0);
  const ducks: number[] = [];
  const spoken: { rate: number; voice: string | null; lang: string }[] = [];
  const clock = { t: 0 };
  const instance = new SpeechDubber({
    now: () => clock.t,
    onDuck: (gain) => ducks.push(gain),
    makeUtterance: (body) => {
      const utterance = new SpeechSynthesisUtterance(body);
      // Record what was actually configured, after the dubber sets it.
      queueMicrotask(() =>
        spoken.push({
          rate: utterance.rate,
          voice: utterance.voice?.name ?? null,
          lang: utterance.lang,
        }),
      );
      return utterance;
    },
  });
  if (!instance.available) return { available: false, voices };

  const speaking = instance.speak(text, lang, 0, budget);
  await new Promise((r) => setTimeout(r, 400));
  const wasSpeaking = speechSynthesis.speaking || speechSynthesis.pending || instance.speaking;
  instance.stop();
  await speaking;
  return { available: true, voices, ducks, spoken, wasSpeaking };
}

function isDubSelfTest(m: unknown): m is { type: 'debugDubSelfTest'; text: string; lang: string; budget: number } {
  return typeof m === 'object' && m !== null && (m as { type?: string }).type === 'debugDubSelfTest';
}

function isCaptureSelfTest(m: unknown): m is { type: 'debugCaptureSelfTest'; seconds?: number; toneHz?: number } {
  return typeof m === 'object' && m !== null && (m as { type?: string }).type === 'debugCaptureSelfTest';
}

function isInjectStart(m: unknown): m is { type: 'debugStart'; tabId: number; config?: Config } {
  return typeof m === 'object' && m !== null && (m as { type?: string }).type === 'debugStart';
}

// -------------------------------------------------------------------- boot

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (isDubSelfTest(message)) {
    void dubSelfTest(message.text, message.lang, message.budget)
      .then(respond)
      .catch((err: unknown) => respond({ error: err instanceof Error ? err.message : String(err) }));
    return true;
  }
  if (isStartFromSamples(message)) {
    void startFromSamples(
      message.tabId,
      { ...DEFAULT_CONFIG, ...message.config },
      message.samples,
      message.sampleRate,
    )
      .then(() => respond({ ok: true }))
      .catch((err: unknown) => respond({ error: err instanceof Error ? err.message : String(err) }));
    return true;
  }
  if (isTranslatorSelfTest(message)) {
    void translatorSelfTest(message.src, message.tgt, message.text)
      .then(respond)
      .catch((err: unknown) => respond({ error: err instanceof Error ? err.message : String(err) }));
    return true;
  }
  if (isCaptureSelfTest(message)) {
    void captureSelfTest(message.seconds ?? 2, message.toneHz ?? 1000)
      .then(respond)
      .catch((err: unknown) => respond({ error: err instanceof Error ? err.message : String(err) }));
    return true;
  }
  if (isInjectStart(message)) {
    void startInjected(message.tabId, { ...DEFAULT_CONFIG, ...message.config });
    return;
  }
  if (isAudioChunk(message)) {
    // Only for an injected session; capture audio never travels this way.
    if (session?.injected) {
      session.injectOrigin ??= session.ctx.currentTime - message.audioStart - message.samples.length / 16000;
      asr?.postMessage({
        type: 'audioChunk',
        samples: Float32Array.from(message.samples),
        audioStart: session.injectOrigin + message.audioStart,
      });
    }
    return;
  }
  if (isStart(message)) {
    void start(message.tabId, message.streamId, message.config)
      .then(() => respond({ ok: true }))
      .catch((err: unknown) => respond({ error: err instanceof Error ? err.message : String(err) }));
    return true;
  }
  if (isStop(message)) {
    void stop();
    return;
  }
  if (isVideoSync(message)) {
    // Trust the sender's tab, not the tabId in the message.
    if (sender.tab?.id !== undefined && sender.tab.id !== session?.tabId) return;
    onVideoSync(message);
    return;
  }
  if (isSetConfig(message)) {
    reconfigure(message.config);
    return;
  }
  if (isGlossRequest(message)) {
    void onGloss(message.word, message.sentence, message.srcLang, message.tgtLang);
    return;
  }
  if (isDeleteModels(message)) {
    dubber?.dispose();
    dubber = null;
    dubStatus = '';
    void caches.delete('subtle-neural-voice');
    asr?.postMessage(message);
    return;
  }
  if (typeof message === 'object' && message?.type === 'getDubStatus') {
    respond({ text: dubStatus });
    return;
  }
  // The overlay reports how long it took to paint; it belongs in the same
  // percentiles as every other stage.
  if (isMetrics(message) && message.stage === 'render') {
    stats.record('render', message.ms);
    return;
  }
  if (typeof message === 'object' && message?.type === 'languagePackReady') {
    translation?.resetContext();
    return;
  }
  if (isCaption(message)) return;
});

async function onGloss(word: string, sentence: string, src: string, tgt: string): Promise<void> {
  if (!translation) return;
  try {
    const gloss = await translation.gloss(word, sentence, src === 'auto' ? 'en' : src, tgt);
    toTab({ type: 'glossResponse', word: gloss.word, translation: gloss.translation, ...(gloss.pos ? { pos: gloss.pos } : {}) });
  } catch (err) {
    fail('translate', err);
    toTab({ type: 'glossResponse', word, translation: '—' });
  }
}

network.start();
spawnWorkers();
console.log('[subtle] offscreen ok ·', JSON.stringify(ENVIRONMENT));
