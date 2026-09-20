/**
 * Tab audio in, 16 kHz mono chunks out.
 *
 * One capture at a time: there is exactly one offscreen document and it owns
 * one AudioContext. Starting a second capture stops the first.
 */

import type { AudioChunk } from '@subtle/shared';
import { PROCESSOR_NAME, TARGET_RATE } from '../../worklets/dsp.js';

export interface TabCapture {
  ctx: AudioContext;
  chunks: ReadableStream<AudioChunk>;
  /** Rate the tab is actually captured at, before resampling. */
  inputRate: number;
}

export interface CaptureStats {
  /** Chunks dropped because the consumer fell more than BACKLOG_LIMIT behind. */
  dropped: number;
  delivered: number;
  inputRate: number;
  startedAt: number;
  /** 'running', or the reason nothing is being heard or processed. */
  contextState: AudioContextState;
  /**
   * RMS of the most recent chunk. Splits the two ways silence can happen: a
   * level of 0 means nothing is coming out of the tab, a level above 0 with
   * nothing audible means the passthrough to the speakers is the problem.
   */
  inputLevel: number;
  /** Channels the tab is producing. 0 would explain a dead capture. */
  channels: number;
  /**
   * RMS of what is being fed to the speakers, read just before
   * `ctx.destination`. With `inputLevel` this splits silence three ways:
   * nothing captured, captured but not routed to the output, or routed and
   * the platform is not playing it.
   */
  outputLevel: number;
}

/**
 * ~10 s of audio. The audio thread cannot be back-pressured, so a consumer
 * that stalls either costs us memory or costs us chunks; chunks are cheaper.
 * ponytail: fixed limit, make it a Config field if anyone needs to tune it.
 */
const BACKLOG_LIMIT = 100;

interface Active {
  ctx: AudioContext;
  passthrough: GainNode;
  /** Tap on the passthrough, so the output level can be read on demand. */
  meter: AnalyserNode;
  meterBuffer: Float32Array<ArrayBuffer>;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
  controller: ReadableStreamDefaultController<AudioChunk>;
  stats: CaptureStats;
}

let active: Active | null = null;

/** Chrome's tab-capture constraints predate the standard `MediaTrackConstraints`. */
function tabConstraints(streamId: string): MediaStreamConstraints {
  return {
    audio: {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
    },
    video: false,
  } as unknown as MediaStreamConstraints;
}

/**
 * `streamId` comes from `chrome.tabCapture.getMediaStreamId` in the service
 * worker, and is single-use.
 */
export async function startCapture(streamId: string): Promise<TabCapture> {
  await stopCapture();
  return startCaptureFromStream(await navigator.mediaDevices.getUserMedia(tabConstraints(streamId)));
}

/**
 * Everything `startCapture` does once it has a stream.
 *
 * Split out because `chrome.tabCapture.getMediaStreamId` cannot be reached
 * from a test: it needs an `activeTab` grant, which needs a real click on the
 * extension's action, and host permissions do not substitute —
 * `"Extension has not been invoked for the current page"`. Handed a stream
 * from anywhere, this exercises the graph, the worklet and the chunk stream
 * exactly as production does. See e2e/capture.spec.ts.
 */
export async function startCaptureFromStream(stream: MediaStream): Promise<TabCapture> {
  const ctx = new AudioContext();
  try {
    // An offscreen document has no user activation, so the context is created
    // suspended and stays that way unless it is told otherwise. A suspended
    // context renders nothing: the tab passthrough is silent *and* the audio
    // thread never runs, so the worklet emits no chunks and no captions are
    // ever produced. Both symptoms, one cause.
    if (ctx.state === 'suspended') await ctx.resume();
    await ctx.audioWorklet.addModule(chrome.runtime.getURL('worklets/resampler.js'));
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    await ctx.close();
    throw err;
  }
  if (ctx.state !== 'running') {
    // Report it and carry on. Refusing to capture here would turn a degraded
    // state into a total failure, and the state is visible in the debug panel.
    console.warn(`[subtle] AudioContext is ${ctx.state}; audio may not play or be processed`);
  }

  const source = ctx.createMediaStreamSource(stream);
  // Capturing a tab mutes it, so hand the audio straight back to the speakers.
  // The gain in between is what dubbing ducks: hearing the original and the
  // dub at equal volume is worse than hearing either alone.
  const passthrough = new GainNode(ctx, { gain: 1 });
  source.connect(passthrough).connect(ctx.destination);
  // An analyser with nothing connected to its output is a pure tap: it reads
  // the signal on its way to the speakers without altering it.
  const meter = ctx.createAnalyser();
  meter.fftSize = 2048;
  passthrough.connect(meter);

  const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, { numberOfOutputs: 1, outputChannelCount: [1] });
  source.connect(node);
  // A worklet node is only pulled when it reaches the destination. It emits
  // silence, but it has to arrive somewhere; a muted gain keeps it running
  // without adding anything to what the user hears.
  const silence = new GainNode(ctx, { gain: 0 });
  node.connect(silence).connect(ctx.destination);

  const stats: CaptureStats = {
    dropped: 0,
    delivered: 0,
    inputRate: ctx.sampleRate,
    startedAt: Date.now(),
    contextState: ctx.state,
    inputLevel: 0,
    channels: stream.getAudioTracks().length,
    outputLevel: 0,
  };
  // If the context is ever suspended again — a tab discard, a device change —
  // audio stops in both directions and the stats say why.
  ctx.addEventListener('statechange', () => {
    stats.contextState = ctx.state;
  });

  let controller!: ReadableStreamDefaultController<AudioChunk>;
  const chunks = new ReadableStream<AudioChunk>({
    start: (c) => {
      controller = c;
    },
    cancel: () => void stopCapture(),
  });

  node.port.onmessage = (e: MessageEvent) => {
    const data = e.data as { type?: string; samples?: Float32Array; audioStart?: number };
    if (data.type !== 'audioChunk' || !data.samples || data.audioStart === undefined) return;
    if ((controller.desiredSize ?? 0) < -BACKLOG_LIMIT) {
      stats.dropped++;
      return;
    }
    stats.delivered++;
    let energy = 0;
    for (const v of data.samples) energy += v * v;
    stats.inputLevel = Math.sqrt(energy / data.samples.length);
    controller.enqueue({ samples: data.samples, audioStart: data.audioStart });
  };

  // The tab going away ends the track; tearing down here stops the
  // AudioContext from sitting open and silent for the rest of the session.
  stream.getAudioTracks()[0]?.addEventListener('ended', () => void stopCapture());

  active = {
    ctx,
    stream,
    source,
    node,
    controller,
    stats,
    passthrough,
    meter,
    meterBuffer: new Float32Array(new ArrayBuffer(meter.fftSize * 4)),
  };
  return { ctx, chunks, inputRate: ctx.sampleRate };
}

export async function stopCapture(): Promise<void> {
  const current = active;
  if (!current) return;
  active = null;

  current.node.port.onmessage = null;
  current.node.port.postMessage({ type: 'stop' });
  current.node.disconnect();
  current.source.disconnect();
  current.stream.getTracks().forEach((t) => t.stop());
  try {
    current.controller.close();
  } catch {
    // Already closed or errored — nothing left to do.
  }
  await current.ctx.close();
}

/** Null when nothing is being captured. For the debug page and spike runs. */
export function captureStats(): CaptureStats | null {
  const current = active;
  if (!current) return null;
  // Read on demand rather than on a timer: the only caller is the debug
  // snapshot, twice a second.
  current.meter.getFloatTimeDomainData(current.meterBuffer);
  let energy = 0;
  for (const v of current.meterBuffer) energy += v * v;
  current.stats.outputLevel = Math.sqrt(energy / current.meterBuffer.length);
  return current.stats;
}

/**
 * Sets how loud the original tab audio is, 0..1. Ramped rather than stepped,
 * because an instant gain change clicks. Used by dubbing; a no-op when
 * nothing is being captured.
 */
export function setPassthroughGain(gain: number, rampSeconds = 0.12): void {
  const current = active;
  if (!current) return;
  const param = current.passthrough.gain;
  const now = current.ctx.currentTime;
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(Math.max(0, Math.min(1, gain)), now + Math.max(0.01, rampSeconds));
}

/** Current passthrough gain, for the debug panel. */
export function passthroughGain(): number {
  return active?.passthrough.gain.value ?? 1;
}

export { TARGET_RATE };
