/**
 * Finding and following the video on the page.
 *
 * Sites have more than one: a hero player, autoplaying previews in a sidebar,
 * an ad. The one worth captioning is the big visible one that is playing, and
 * on a single-page app it is replaced without a navigation.
 */

export interface VideoScore {
  video: HTMLVideoElement;
  score: number;
}

/** Below this a video is a thumbnail or a tracking pixel, not content. */
const MIN_EDGE = 120;

function visibleArea(rect: DOMRect, view: { width: number; height: number }): number {
  const w = Math.max(0, Math.min(rect.right, view.width) - Math.max(rect.left, 0));
  const h = Math.max(0, Math.min(rect.bottom, view.height) - Math.max(rect.top, 0));
  return w * h;
}

/**
 * Ranks the videos on the page. Visible area is the base score; playing
 * doubles it, so a large paused video loses to a smaller one actually
 * running, and a fullscreen video wins outright.
 */
export function scoreVideos(
  videos: readonly HTMLVideoElement[],
  view: { width: number; height: number },
  fullscreenElement: Element | null = null,
): VideoScore[] {
  const scored: VideoScore[] = [];
  for (const video of videos) {
    const rect = video.getBoundingClientRect();
    if (rect.width < MIN_EDGE || rect.height < MIN_EDGE) continue;
    let score = visibleArea(rect, view);
    if (score <= 0) continue;
    if (!video.paused && !video.ended) score *= 2;
    if (video.readyState === 0) score *= 0.25;
    if (fullscreenElement && (fullscreenElement === video || fullscreenElement.contains(video))) {
      score *= 100;
    }
    scored.push({ video, score });
  }
  return scored.sort((a, b) => b.score - a.score);
}

export function pickVideo(doc: Document = document): HTMLVideoElement | null {
  const view = { width: window.innerWidth, height: window.innerHeight };
  return scoreVideos([...doc.querySelectorAll('video')], view, doc.fullscreenElement)[0]?.video ?? null;
}

/**
 * Calls `onChange` whenever the best video on the page changes, including
 * when a single-page app swaps it out from under us.
 */
export class VideoWatcher {
  private current: HTMLVideoElement | null = null;
  private observer: MutationObserver | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly onChange: (video: HTMLVideoElement | null) => void,
    private readonly doc: Document = document,
  ) {}

  start(): void {
    this.evaluate();
    // Catching the element being added is not enough: players swap `src` and
    // resize well after insertion, and which video is "best" changes when one
    // starts playing. A cheap re-check covers what mutations miss.
    this.observer = new MutationObserver(() => this.evaluate());
    this.observer.observe(this.doc.documentElement, { childList: true, subtree: true });
    this.timer = setInterval(() => this.evaluate(), 2000);
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  get video(): HTMLVideoElement | null {
    return this.current;
  }

  private evaluate(): void {
    const next = pickVideo(this.doc);
    if (next === this.current) return;
    this.current = next;
    this.onChange(next);
  }
}
