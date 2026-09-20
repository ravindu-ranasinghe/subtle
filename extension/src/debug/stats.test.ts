import { describe, expect, it } from 'vitest';
import { StageStats, emptySnapshot, percentile } from './stats.js';

describe('percentile', () => {
  it('uses nearest rank', () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(sorted, 0.5)).toBe(50);
    expect(percentile(sorted, 0.95)).toBe(100);
    expect(percentile(sorted, 0.1)).toBe(10);
  });

  it('handles one sample and none', () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.95)).toBe(42);
    expect(percentile([], 0.5)).toBeNull();
  });

  it('never runs off either end', () => {
    expect(percentile([1, 2, 3], 0)).toBe(1);
    expect(percentile([1, 2, 3], 1)).toBe(3);
  });
});

describe('StageStats', () => {
  it('reports last, p50 and p95 per stage', () => {
    const stats = new StageStats();
    for (const ms of [100, 200, 300, 400, 500]) stats.record('asr', ms);
    const asr = stats.summary('asr');
    expect(asr.last).toBe(500);
    expect(asr.p50).toBe(300);
    expect(asr.p95).toBe(500);
    expect(asr.count).toBe(5);
  });

  it('keeps stages apart', () => {
    const stats = new StageStats();
    stats.record('vad', 5);
    stats.record('asr', 500);
    expect(stats.summary('vad').last).toBe(5);
    expect(stats.summary('asr').last).toBe(500);
    expect(stats.summary('translate').last).toBeNull();
  });

  it('is empty before anything is recorded', () => {
    const summary = new StageStats().summary('render');
    expect(summary).toEqual({ last: null, p50: null, p95: null, count: 0 });
  });

  it('ignores nonsense timings rather than skewing the percentiles', () => {
    const stats = new StageStats();
    stats.record('asr', 100);
    stats.record('asr', Number.NaN);
    stats.record('asr', -5);
    stats.record('asr', Number.POSITIVE_INFINITY);
    expect(stats.summary('asr').count).toBe(1);
    expect(stats.summary('asr').p50).toBe(100);
  });

  it('keeps counting past the retained window', () => {
    const stats = new StageStats();
    for (let i = 0; i < 250; i++) stats.record('render', i);
    const summary = stats.summary('render');
    expect(summary.count).toBe(250);
    // The window holds the last 200, so the oldest 50 are gone.
    expect(summary.p50).toBeGreaterThan(100);
    expect(summary.last).toBe(249);
  });

  it('resets', () => {
    const stats = new StageStats();
    stats.record('asr', 100);
    stats.reset();
    expect(stats.summary('asr').count).toBe(0);
  });

  it('snapshots every stage', () => {
    const snapshot = new StageStats().snapshot();
    expect(Object.keys(snapshot)).toEqual(['vad', 'asr', 'translate', 'render', 'e2e']);
  });
});

describe('emptySnapshot', () => {
  it('starts with a zero network count, which is the number that matters', () => {
    expect(emptySnapshot().network).toEqual({ offscreen: 0, asr: 0, mt: 0 });
    expect(emptySnapshot().capturing).toBe(false);
  });
});
