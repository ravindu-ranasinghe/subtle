/**
 * Every message that crosses a context boundary in Subtle.
 *
 * Boundaries: service worker <-> offscreen <-> workers <-> content script.
 * All of them are `postMessage`/`chrome.runtime.sendMessage` shaped, so the
 * union below is the single source of truth and `isMessage` is the only
 * thing allowed to widen `unknown` into it.
 */

import type { Config, Gloss, WhisperSize } from './interfaces.js';

// ---------------------------------------------------------------- control

/** Begin capture for a tab. `streamId` comes from chrome.tabCapture.getMediaStreamId. */
export interface StartMsg {
  type: 'start';
  tabId: number;
  streamId: string;
  config: Config;
}

export interface StopMsg {
  type: 'stop';
  tabId: number;
}

/**
 * Popup -> service worker: start capture on this tab, or stop it if it is
 * already running. The popup owns the action click (the action has a
 * `default_popup`, which suppresses `chrome.action.onClicked`), and only the
 * service worker can mint a tabCapture stream id.
 */
export interface ToggleCaptureMsg {
  type: 'toggleCapture';
  tabId: number;
}

export interface SetConfigMsg {
  type: 'setConfig';
  config: Config;
}

/**
 * Content script -> offscreen heartbeat tying the <video> clock to the
 * capture clock. See ./timing.ts.
 *
 * Two fields are the *receiver's* to fill, because the sender cannot know
 * them. Senders pass the placeholders below and the offscreen document
 * overwrites both on receipt; using what the content script sent would put
 * every caption on a clock with an arbitrary offset.
 */
export interface VideoSyncMsg {
  type: 'videoSync';
  /** Filled by the receiver from `sender.tab.id`. Senders pass -1. */
  tabId: number;
  videoTime: number;
  /**
   * Offscreen AudioContext `currentTime`, filled by the offscreen document on
   * receipt — a content script has no handle on that clock. Senders pass
   * their own monotonic reading, which is only good for ordering.
   */
  audioTime: number;
  paused: boolean;
  playbackRate: number;
}

// ------------------------------------------------------------------ audio

/** One block of 16 kHz mono PCM. `audioStart` is seconds on the AudioContext clock. */
export interface AudioChunkMsg {
  type: 'audioChunk';
  samples: Float32Array;
  audioStart: number;
}

/** The payload half of {@link AudioChunkMsg}, for APIs that take audio without the envelope. */
export type AudioChunk = Omit<AudioChunkMsg, 'type'>;

// -------------------------------------------------------------------- asr

export interface Word {
  w: string;
  /** Seconds on the AudioContext clock. */
  start: number;
  end: number;
}

/**
 * A recognized span of speech. `interim` segments may be replaced by a later
 * segment carrying the same `id`; a non-interim segment is final.
 */
export interface SegmentMsg {
  type: 'segment';
  id: string;
  text: string;
  lang: string;
  audioStart: number;
  audioEnd: number;
  words?: Word[];
  interim: boolean;
}

export type Segment = Omit<SegmentMsg, 'type'>;

// ----------------------------------------------------------------- output

/** What the overlay renders. Times are on the <video> clock, not the audio clock. */
export interface CaptionMsg {
  type: 'caption';
  id: string;
  original: string;
  translation: string;
  srcLang: string;
  tgtLang: string;
  videoStart: number;
  videoEnd: number;
  words?: Word[];
  interim: boolean;
}

export type Caption = Omit<CaptionMsg, 'type'>;

// ---------------------------------------------------------------- learner

export interface GlossRequestMsg {
  type: 'glossRequest';
  word: string;
  sentence: string;
  srcLang: string;
  tgtLang: string;
}

export interface GlossResponseMsg {
  type: 'glossResponse';
  word: string;
  translation: string;
  pos?: string;
}

// ----------------------------------------------------------------- status

/** Popup -> ASR worker: drop every cached model weight. */
export interface DeleteModelsMsg {
  type: 'deleteModels';
}

/** ASR worker -> popup: which Cache API buckets were removed. */
export interface ModelsDeletedMsg {
  type: 'modelsDeleted';
  caches: string[];
}

/**
 * Which engines actually loaded. WebGPU or WASM is the difference between
 * comfortably real-time and dropping chunks, and Chrome's translator versus a
 * local model is the difference between instant and an 881 MB download — both
 * are the first thing anyone asks when something feels wrong.
 */
export interface BackendMsg {
  type: 'backend';
  backend: 'webgpu' | 'wasm';
  /** GPU adapter description when on WebGPU. */
  adapter?: string;
  /** Which translator is serving the current language pair. */
  translator?: 'chrome-translator' | 'local-mt';
  /** Model id when `translator` is 'local-mt' — opus-mt, or the 881 MB NLLB. */
  translationModel?: string;
}

/** ASR worker -> everyone: what `srcLang: 'auto'` resolved to. Once per session. */
export interface DetectedLanguageMsg {
  type: 'detectedLanguage';
  lang: string;
}

/**
 * Offscreen -> popup: Chrome can translate this pair, but only after a
 * download it will not start without a user gesture. An offscreen document
 * can never have one, so the popup shows a button and does it there.
 */
export interface LanguagePackRequiredMsg {
  type: 'languagePackRequired';
  src: string;
  tgt: string;
}

export interface ModelProgressMsg {
  type: 'modelProgress';
  model: WhisperSize | string;
  loaded: number;
  total: number;
}

export type Stage = 'vad' | 'asr' | 'translate' | 'render';

export interface ErrorMsg {
  type: 'error';
  stage: Stage | 'capture' | 'model';
  message: string;
}

export interface MetricsMsg {
  type: 'metrics';
  stage: Stage;
  ms: number;
  /** Real-time factor: processing seconds per audio second. ASR only. */
  rtf?: number;
  segmentId?: string;
}

// ------------------------------------------------------------------ union

export type Message =
  | StartMsg
  | StopMsg
  | ToggleCaptureMsg
  | SetConfigMsg
  | VideoSyncMsg
  | AudioChunkMsg
  | SegmentMsg
  | CaptionMsg
  | GlossRequestMsg
  | GlossResponseMsg
  | DeleteModelsMsg
  | ModelsDeletedMsg
  | BackendMsg
  | DetectedLanguageMsg
  | LanguagePackRequiredMsg
  | ModelProgressMsg
  | ErrorMsg
  | MetricsMsg;

export type MessageType = Message['type'];

// ----------------------------------------------------------------- guards

/**
 * Required keys per message type. Guards check presence, not deep shape:
 * enough to reject a stale or foreign message, cheap enough to run on every
 * audio chunk. Senders are all first-party contexts in this extension.
 */
const REQUIRED = {
  start: ['tabId', 'streamId', 'config'],
  stop: ['tabId'],
  toggleCapture: ['tabId'],
  setConfig: ['config'],
  videoSync: ['tabId', 'videoTime', 'audioTime', 'paused', 'playbackRate'],
  audioChunk: ['samples', 'audioStart'],
  segment: ['id', 'text', 'lang', 'audioStart', 'audioEnd', 'interim'],
  caption: ['id', 'original', 'translation', 'srcLang', 'tgtLang', 'videoStart', 'videoEnd', 'interim'],
  glossRequest: ['word', 'sentence', 'srcLang', 'tgtLang'],
  glossResponse: ['word', 'translation'],
  deleteModels: [],
  modelsDeleted: ['caches'],
  backend: ['backend'],
  detectedLanguage: ['lang'],
  languagePackRequired: ['src', 'tgt'],
  modelProgress: ['model', 'loaded', 'total'],
  error: ['stage', 'message'],
  metrics: ['stage', 'ms'],
} as const satisfies Record<MessageType, readonly string[]>;

/** True for any well-formed Subtle message. The only sanctioned `unknown` widener. */
export function isMessage(m: unknown): m is Message {
  if (typeof m !== 'object' || m === null) return false;
  const rec = m as Record<string, unknown>;
  const required = REQUIRED[rec['type'] as MessageType] as readonly string[] | undefined;
  if (!required) return false;
  return required.every((k) => rec[k] !== undefined);
}

function guard<T extends Message>(type: T['type']) {
  return (m: unknown): m is T => isMessage(m) && m.type === type;
}

export const isStart = guard<StartMsg>('start');
export const isStop = guard<StopMsg>('stop');
export const isToggleCapture = guard<ToggleCaptureMsg>('toggleCapture');
export const isSetConfig = guard<SetConfigMsg>('setConfig');
export const isVideoSync = guard<VideoSyncMsg>('videoSync');
export const isAudioChunk = guard<AudioChunkMsg>('audioChunk');
export const isSegment = guard<SegmentMsg>('segment');
export const isCaption = guard<CaptionMsg>('caption');
export const isGlossRequest = guard<GlossRequestMsg>('glossRequest');
export const isGlossResponse = guard<GlossResponseMsg>('glossResponse');
export const isDeleteModels = guard<DeleteModelsMsg>('deleteModels');
export const isModelsDeleted = guard<ModelsDeletedMsg>('modelsDeleted');
export const isBackend = guard<BackendMsg>('backend');
export const isDetectedLanguage = guard<DetectedLanguageMsg>('detectedLanguage');
export const isLanguagePackRequired = guard<LanguagePackRequiredMsg>('languagePackRequired');
export const isModelProgress = guard<ModelProgressMsg>('modelProgress');
export const isError = guard<ErrorMsg>('error');
export const isMetrics = guard<MetricsMsg>('metrics');
