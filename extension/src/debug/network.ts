/**
 * Counts network requests made from an extension context.
 *
 * The point is the zero: once the model weights are in the Cache API, playing
 * a video should make no requests at all. A number climbing during playback
 * means something is going out that should not be — a cache miss, a model
 * re-fetch, a CDN fallback that MV3 is supposed to forbid.
 *
 * Cache API hits do not produce resource entries, so a cached model load does
 * not show up here. That is what makes the zero meaningful.
 */

export interface NetworkCount {
  total: number;
  /** Most recent URLs, for working out what is leaking. */
  recent: string[];
}

const RECENT = 8;

export class NetworkCounter {
  private total = 0;
  private recent: string[] = [];
  private observer: PerformanceObserver | null = null;

  start(): void {
    if (this.observer || typeof PerformanceObserver === 'undefined') return;
    this.observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // A response served from a cache still logs an entry with zero
        // transfer size; only bytes off the wire count.
        const resource = entry as PerformanceResourceTiming;
        if (resource.transferSize === 0) continue;
        this.total++;
        this.recent = [resource.name, ...this.recent].slice(0, RECENT);
      }
    });
    try {
      this.observer.observe({ type: 'resource', buffered: true });
    } catch {
      // Not every context exposes resource timing; the counter stays at 0.
      this.observer = null;
    }
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  /** Called when capture starts, so the count covers playback and not startup. */
  reset(): void {
    this.total = 0;
    this.recent = [];
  }

  get count(): NetworkCount {
    return { total: this.total, recent: [...this.recent] };
  }
}
