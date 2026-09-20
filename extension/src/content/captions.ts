/**
 * Which caption belongs on screen right now.
 *
 * Captions arrive late — recognition takes a second or two — so by the time a
 * line reaches us its own window has often already passed. Showing only
 * captions whose [videoStart, videoEnd] contains the playhead would leave the
 * overlay blank most of the time. So the most recent line lingers past its
 * end, the way a subtitle track does.
 */

import type { Caption } from '@subtle/shared';

/** How long a line stays up after its window ends, in video seconds. */
export const LINGER_SEC = 4;

/**
 * Tolerance on the leading edge. A line whose start is a hair ahead of the
 * playhead is the one being spoken, not a future one.
 */
const LEAD_SEC = 0.25;

/**
 * Holds the captions for the current video. Interim lines are replaced in
 * place by the final carrying the same id.
 */
export class CaptionStore {
  private readonly byId = new Map<string, Caption>();
  private readonly translated = new Map<string, Caption>();
  private shown: Caption | null = null;
  private shownAt = 0;

  upsert(caption: Caption): void {
    this.byId.set(caption.id, caption);
    if (caption.translation.trim()) this.translated.set(caption.id, caption);
    if (this.byId.size > 300) {
      const oldest = this.byId.keys().next().value!;
      this.byId.delete(oldest);
      this.translated.delete(oldest);
    }
  }

  all(): Caption[] {
    return [...this.byId.values()];
  }

  /** The line to show at `time`, or null for silence. */
  activeAt(time: number, preferTranslation = false): Caption | null {
    const captions = this.all();
    // A new original must not flash over the translated line still being read.
    const next = (preferTranslation ? pickActive([...this.translated.values()], time) : null)
      ?? pickActive(captions, time);
    // A new preview must not flash away a just-finished sentence. Final
    // captions and revisions of the same line still appear immediately.
    if (next?.interim && this.shown && !this.shown.interim && next.id !== this.shown.id &&
      time >= this.shownAt && time - this.shownAt < 1) return this.shown;
    if (next?.id !== this.shown?.id || next?.interim !== this.shown?.interim ||
      next?.translation !== this.shown?.translation) this.shownAt = time;
    this.shown = next;
    return next;
  }

  /** The most recently *starting* line, for replay. */
  latest(): Caption | null {
    let best: Caption | null = null;
    for (const c of this.byId.values()) {
      if (!best || c.videoStart > best.videoStart) best = c;
    }
    return best;
  }

  /** Called on a seek or a new video: old lines are stamped against a dead timeline. */
  clear(): void {
    this.byId.clear();
    this.translated.clear();
    this.shown = null;
  }

  get size(): number {
    return this.byId.size;
  }
}

/**
 * Pure selection, so the rule is testable without a DOM or a clock.
 *
 * In order: a line whose window covers `time` wins, latest start first. If
 * none does, the line that ended most recently stays up for `linger` seconds.
 * Lines that have not started yet never show — after a seek backwards, the
 * captions for later in the video must not appear.
 */
export function pickActive(captions: Caption[], time: number, linger = LINGER_SEC): Caption | null {
  let covering: Caption | null = null;
  let recent: Caption | null = null;

  for (const c of captions) {
    if (c.videoStart > time + LEAD_SEC) continue;
    if (c.videoEnd >= time) {
      if (!covering || c.videoStart > covering.videoStart) covering = c;
    } else if (time - c.videoEnd <= linger) {
      if (!recent || c.videoEnd > recent.videoEnd) recent = c;
    }
  }
  return covering ?? recent;
}

/** Splits a line into clickable words and the spacing between them. */
export function splitWords(text: string): { word: string; after: string }[] {
  const out: { word: string; after: string }[] = [];
  const re = /(\S+)(\s*)/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out.push({ word: m[1]!, after: m[2]! });
  }
  return out;
}

/** Trailing punctuation is not part of the word we ask for a gloss of. */
export function bareWord(token: string): string {
  return token.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
}
