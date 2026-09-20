/**
 * Audio clock <-> video clock.
 *
 * Audio is captured on the offscreen AudioContext, whose `currentTime` runs
 * monotonically from when capture started and knows nothing about the page.
 * The <video> clock pauses, seeks and runs at other speeds. Every ASR result
 * is stamped on the audio clock and has to be rendered on the video clock,
 * so all of that translation lives here as pure functions over the most
 * recent videoSync sample.
 */

import type { VideoSyncMsg } from './messages.js';

/** The part of a videoSync that matters for timing. */
export type Clock = Pick<VideoSyncMsg, 'videoTime' | 'audioTime' | 'paused' | 'playbackRate'>;

export interface VideoRange {
  videoStart: number;
  videoEnd: number;
}

/** Seconds of predicted-vs-reported drift past which we call it a seek. */
export const SEEK_TOLERANCE = 0.25;

function stopped(c: Clock): boolean {
  return c.paused || c.playbackRate <= 0;
}

/**
 * Where on the video timeline the audio at `audioTime` was heard.
 *
 * While the video is paused (or rate 0) the video clock does not advance, so
 * every audio instant maps to the same frozen position.
 */
export function audioToVideo(sync: Clock, audioTime: number): number {
  if (stopped(sync)) return Math.max(0, sync.videoTime);
  const elapsed = (audioTime - sync.audioTime) * sync.playbackRate;
  return Math.max(0, sync.videoTime + elapsed);
}

/**
 * Inverse of {@link audioToVideo}. Not invertible while stopped — the whole
 * paused span collapses onto one video instant — so that case returns the
 * sync's own audio time.
 */
export function videoToAudio(sync: Clock, videoTime: number): number {
  if (stopped(sync)) return sync.audioTime;
  return sync.audioTime + (videoTime - sync.videoTime) / sync.playbackRate;
}

/** Map a segment's [audioStart, audioEnd] onto the video timeline. */
export function toVideoRange(sync: Clock, audioStart: number, audioEnd: number): VideoRange {
  return {
    videoStart: audioToVideo(sync, audioStart),
    videoEnd: audioToVideo(sync, audioEnd),
  };
}

/**
 * How far the new sample fell from where the old one predicted it would be.
 * Signed: positive means the video is further ahead than expected.
 */
export function drift(prev: Clock, next: Clock): number {
  return next.videoTime - audioToVideo(prev, next.audioTime);
}

/**
 * True when the user seeked (or the page swapped the media) between two
 * samples. Callers use this to drop in-flight captions, which are stamped
 * against a timeline that no longer exists.
 *
 * A rate change alone is not a seek: the prediction still holds at the
 * instant the new sample was taken.
 */
export function isSeek(prev: Clock, next: Clock, tolerance = SEEK_TOLERANCE): boolean {
  return Math.abs(drift(prev, next)) > tolerance;
}
