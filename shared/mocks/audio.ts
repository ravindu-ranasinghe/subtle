/**
 * A WAV file pretending to be captured tab audio, so the ASR side can be
 * driven without a real tabCapture stream.
 */

import type { AudioChunkMsg } from '../messages.js';

export interface Wav {
  sampleRate: number;
  /** Mono, downmixed if the file had more channels. */
  samples: Float32Array;
}

const str = (v: DataView, at: number) =>
  String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));

/**
 * Minimal RIFF/WAVE reader: 16-bit PCM and 32-bit float, any channel count.
 * Not a general decoder — it only has to read our own fixtures.
 */
export function decodeWav(buffer: ArrayBuffer): Wav {
  const view = new DataView(buffer);
  if (str(view, 0) !== 'RIFF' || str(view, 8) !== 'WAVE') throw new Error('not a WAV file');

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let data: { at: number; length: number } | null = null;

  // Walk the chunk list; LIST/fact chunks sit between fmt and data often enough.
  for (let at = 12; at + 8 <= view.byteLength; ) {
    const id = str(view, at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      data = { at: body, length: size };
    }
    at = body + size + (size % 2); // chunks are word-aligned
  }
  if (!data || !channels) throw new Error('WAV missing fmt or data chunk');

  const bytes = bits / 8;
  const frames = Math.floor(data.length / bytes / channels);
  const samples = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const at = data.at + (f * channels + c) * bytes;
      if (format === 3 && bits === 32) sum += view.getFloat32(at, true);
      else if (bits === 16) sum += view.getInt16(at, true) / 32768;
      else throw new Error(`unsupported WAV format ${format}/${bits}-bit`);
    }
    samples[f] = sum / channels;
  }
  return { sampleRate, samples };
}

/** The 16 kHz mono fixture next to this file: three bursts of speech-ish tone. */
export async function loadFixture(): Promise<Wav> {
  const url = new URL('./fixtures/speech-16k.wav', import.meta.url);
  if (url.protocol === 'file:') {
    // Node (tests, bench). Indirect specifier so bundlers leave it alone
    // instead of externalising it with a warning on every extension build.
    const nodeFs = 'node:fs/promises';
    const { readFile } = await import(/* @vite-ignore */ nodeFs);
    const buf = await readFile(url);
    return decodeWav(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  }
  return decodeWav(await (await fetch(url)).arrayBuffer());
}

export interface MockAudioSourceOptions {
  /** Chunk length in ms. The real worklet emits 128-frame blocks batched to ~100 ms. */
  chunkMs?: number;
  /** Where on the AudioContext clock the first chunk starts. */
  startAt?: number;
  /** Wall-clock multiplier. 0 delivers everything synchronously. */
  speed?: number;
  /** Loop forever instead of stopping at the end of the file. */
  loop?: boolean;
}

/**
 * Feed a WAV out as audioChunk messages, paced like a live capture.
 * Returns a stop function.
 */
export function mockAudioSource(
  wav: Wav,
  onChunk: (m: AudioChunkMsg) => void,
  options: MockAudioSourceOptions = {},
): () => void {
  const chunkMs = options.chunkMs ?? 100;
  const speed = options.speed ?? 1;
  if (options.loop && speed <= 0) throw new Error('mockAudioSource: loop at speed 0 never returns');
  const size = Math.max(1, Math.round((wav.sampleRate * chunkMs) / 1000));
  const count = Math.ceil(wav.samples.length / size);
  let audioStart = options.startAt ?? 0;
  let i = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const send = () => {
    if (stopped) return;
    const from = (i % count) * size;
    const samples = wav.samples.slice(from, from + size);
    onChunk({ type: 'audioChunk', samples, audioStart });
    audioStart += samples.length / wav.sampleRate;
    i++;
    if (!options.loop && i >= count) return;
    if (speed > 0) timer = setTimeout(send, chunkMs / speed);
    else send();
  };
  send();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}
