import { describe, expect, it } from 'vitest';
import { isAudioChunk, isCaption, isMessage, isSegment, isStart, type Message } from './messages.js';
import { DEFAULT_CONFIG } from './interfaces.js';

describe('isMessage', () => {
  it('accepts a well-formed message', () => {
    const m: Message = { type: 'stop', tabId: 7 };
    expect(isMessage(m)).toBe(true);
  });

  it('rejects junk, unknown types and missing fields', () => {
    expect(isMessage(null)).toBe(false);
    expect(isMessage('stop')).toBe(false);
    expect(isMessage({ type: 'nope' })).toBe(false);
    expect(isMessage({ type: 'stop' })).toBe(false);
    expect(isMessage({ type: 'start', tabId: 1, streamId: 'x' })).toBe(false);
  });

  it('accepts a message missing only optional fields', () => {
    expect(isMessage({ type: 'metrics', stage: 'asr', ms: 12 })).toBe(true);
  });
});

describe('per-type guards', () => {
  it('narrows to exactly one type', () => {
    const start = { type: 'start', tabId: 1, streamId: 's', config: DEFAULT_CONFIG };
    expect(isStart(start)).toBe(true);
    expect(isSegment(start)).toBe(false);
    expect(isCaption(start)).toBe(false);
  });

  it('accepts an audio chunk carrying a Float32Array', () => {
    expect(isAudioChunk({ type: 'audioChunk', samples: new Float32Array(160), audioStart: 1.5 })).toBe(true);
  });
});
