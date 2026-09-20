import { describe, expect, it } from 'vitest';
import { audioToVideo, drift, isSeek, toVideoRange, videoToAudio, type Clock } from './timing.js';

/** Video at 10s when the audio clock read 100s, playing normally. */
const playing: Clock = { videoTime: 10, audioTime: 100, paused: false, playbackRate: 1 };

describe('normal playback', () => {
  it('advances the video clock with the audio clock', () => {
    expect(audioToVideo(playing, 100)).toBe(10);
    expect(audioToVideo(playing, 102.5)).toBe(12.5);
  });

  it('extrapolates backwards for audio captured before the sync', () => {
    expect(audioToVideo(playing, 98)).toBe(8);
  });

  it('never returns a negative video time', () => {
    expect(audioToVideo(playing, 80)).toBe(0);
  });

  it('round-trips through videoToAudio', () => {
    expect(videoToAudio(playing, audioToVideo(playing, 103.25))).toBeCloseTo(103.25);
  });

  it('maps a segment to a video range', () => {
    expect(toVideoRange(playing, 101, 103)).toEqual({ videoStart: 11, videoEnd: 13 });
  });
});

describe('pause', () => {
  const paused: Clock = { videoTime: 42, audioTime: 200, paused: true, playbackRate: 1 };

  it('freezes the video clock however long the audio clock runs', () => {
    expect(audioToVideo(paused, 200)).toBe(42);
    expect(audioToVideo(paused, 260)).toBe(42);
  });

  it('collapses a segment spanning the pause onto one instant', () => {
    expect(toVideoRange(paused, 201, 209)).toEqual({ videoStart: 42, videoEnd: 42 });
  });

  it('treats playbackRate 0 as paused', () => {
    const zero: Clock = { ...paused, paused: false, playbackRate: 0 };
    expect(audioToVideo(zero, 260)).toBe(42);
    expect(videoToAudio(zero, 99)).toBe(200);
  });
});

describe('seek', () => {
  it('detects a backwards seek', () => {
    // 2s of audio later the video should read 12; it reads 3 instead.
    const after: Clock = { videoTime: 3, audioTime: 102, paused: false, playbackRate: 1 };
    expect(drift(playing, after)).toBeCloseTo(-9);
    expect(isSeek(playing, after)).toBe(true);
  });

  it('detects a forwards seek', () => {
    const after: Clock = { videoTime: 200, audioTime: 102, paused: false, playbackRate: 1 };
    expect(drift(playing, after)).toBeCloseTo(188);
    expect(isSeek(playing, after)).toBe(true);
  });

  it('detects a seek made while paused', () => {
    const before: Clock = { videoTime: 42, audioTime: 200, paused: true, playbackRate: 1 };
    const after: Clock = { videoTime: 90, audioTime: 201, paused: true, playbackRate: 1 };
    expect(isSeek(before, after)).toBe(true);
  });

  it('does not flag ordinary playback drift', () => {
    const after: Clock = { videoTime: 12.08, audioTime: 102, paused: false, playbackRate: 1 };
    expect(isSeek(playing, after)).toBe(false);
  });

  it('does not flag a rate change on its own', () => {
    const after: Clock = { videoTime: 12, audioTime: 102, paused: false, playbackRate: 1.5 };
    expect(isSeek(playing, after)).toBe(false);
  });

  it('honours a custom tolerance', () => {
    const after: Clock = { videoTime: 12.4, audioTime: 102, paused: false, playbackRate: 1 };
    expect(isSeek(playing, after)).toBe(true);
    expect(isSeek(playing, after, 0.5)).toBe(false);
  });
});

describe('1.5x playback', () => {
  const fast: Clock = { videoTime: 10, audioTime: 100, paused: false, playbackRate: 1.5 };

  it('advances the video clock faster than the audio clock', () => {
    expect(audioToVideo(fast, 102)).toBe(13);
    expect(toVideoRange(fast, 101, 103)).toEqual({ videoStart: 11.5, videoEnd: 14.5 });
  });

  it('round-trips through videoToAudio', () => {
    expect(videoToAudio(fast, 14.5)).toBeCloseTo(103);
  });

  it('is consistent with a slowed-down rate too', () => {
    const slow: Clock = { ...fast, playbackRate: 0.5 };
    expect(audioToVideo(slow, 104)).toBe(12);
  });
});
