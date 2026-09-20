/**
 * Latency bookkeeping for the debug panel.
 *
 * Pure: no DOM, no messaging, no clock of its own, so the percentile maths is
 * testable. The offscreen document feeds it and ships snapshots to the tab.
 */

import type { Stage } from '@subtle/shared';

/** The contract's four stages plus the one that matters most to a user. */
export type DebugStage = Stage | 'e2e';

export const STAGES: DebugStage[] = ['vad', 'asr', 'translate', 'render', 'e2e'];

/** Samples kept per stage. At ~1 caption/second this is a few minutes. */
const WINDOW = 200;

export interface StageSummary {
  last: number | null;
  p50: number | null;
  p95: number | null;
  count: number;
}

/**
 * Nearest-rank percentile over the retained window. Not interpolated: with a
 * couple of hundred samples the difference is noise, and the rank is the
 * number someone can check by hand.
 */
export function percentile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

export class StageStats {
  private readonly samples = new Map<DebugStage, number[]>();
  private readonly lastSeen = new Map<DebugStage, number>();
  /** Total ever recorded, which the retained window does not tell you. */
  private readonly totals = new Map<DebugStage, number>();

  record(stage: DebugStage, ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    const list = this.samples.get(stage) ?? [];
    list.push(ms);
    if (list.length > WINDOW) list.shift();
    this.samples.set(stage, list);
    this.lastSeen.set(stage, ms);
    this.totals.set(stage, (this.totals.get(stage) ?? 0) + 1);
  }

  summary(stage: DebugStage): StageSummary {
    const list = this.samples.get(stage) ?? [];
    const sorted = [...list].sort((a, b) => a - b);
    return {
      last: this.lastSeen.get(stage) ?? null,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      count: this.totals.get(stage) ?? 0,
    };
  }

  snapshot(): Record<DebugStage, StageSummary> {
    return Object.fromEntries(STAGES.map((s) => [s, this.summary(s)])) as Record<
      DebugStage,
      StageSummary
    >;
  }

  reset(): void {
    this.samples.clear();
    this.lastSeen.clear();
    this.totals.clear();
  }
}

/**
 * What this context can actually do. Every one of these is a boundary that
 * has bitten us at least once — see BUGS.md E-1 and E-3.
 */
export interface Environment {
  tabs: boolean;
  translator: boolean;
  languageDetector: boolean;
  speechSynthesis: boolean;
  webgpu: boolean;
}

export interface DebugSnapshot {
  env: Environment;
  model: string;
  /** ASR inference backend. */
  backend: string;
  adapter: string | null;
  translator: string | null;
  translationModel: string | null;
  /** Median real-time factor reported by the recognizer. */
  rtf: number | null;
  /** Seconds of audio waiting on the recognizer. */
  queueSeconds: number;
  /** Chunks the capture dropped because the consumer fell behind. */
  droppedChunks: number;
  /**
   * AudioContext state. Anything but 'running' means the tab is muted and no
   * audio is being processed — the failure that produces silence and no
   * captions at the same time.
   */
  contextState: AudioContextState | null;
  /** RMS of the audio arriving from the tab. 0 means the tab is sending silence. */
  inputLevel: number;
  /** Audio tracks on the captured stream. */
  channels: number;
  /** RMS of what is being sent to the speakers. */
  outputLevel: number;
  capturing: boolean;
  /**
   * Resource entries seen in extension contexts since capture started. Should
   * settle at 0 once the weights are cached — anything else is a fetch we did
   * not mean to make.
   */
  network: { offscreen: number; asr: number; mt: number };
  stages: Record<DebugStage, StageSummary>;
}

export function emptySnapshot(): DebugSnapshot {
  return {
    env: { tabs: false, translator: false, languageDetector: false, speechSynthesis: false, webgpu: false },
    model: '—',
    backend: '—',
    adapter: null,
    translator: null,
    translationModel: null,
    rtf: null,
    queueSeconds: 0,
    droppedChunks: 0,
    contextState: null,
    inputLevel: 0,
    channels: 0,
    outputLevel: 0,
    capturing: false,
    network: { offscreen: 0, asr: 0, mt: 0 },
    stages: new StageStats().snapshot(),
  };
}
