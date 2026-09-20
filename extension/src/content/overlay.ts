/**
 * The caption overlay.
 *
 * Lives in a shadow root so no site stylesheet can reach it, and is
 * positioned over the video's bounding rect rather than parented into the
 * player — players rebuild their DOM and would take the overlay with them.
 */

import type { Caption } from '@subtle/shared';
import { bareWord, splitWords } from './captions.js';

export interface OverlayState {
  caption: Caption | null;
  showTranslation: boolean;
  fontSize: number;
  /** Immersion mode: original only, no translation line at all. */
  immersion: boolean;
}

/**
 * Where the overlay has to live to be visible right now.
 *
 * Nothing outside the fullscreen element is rendered in fullscreen, so the
 * overlay has to move inside it. Returns null when the page fullscreened the
 * `<video>` itself: a video element renders no children, so there is nowhere
 * to put an overlay. Most players fullscreen a wrapper and are fine.
 */
export function overlayParent(doc: Document): Element | null {
  const fullscreen = doc.fullscreenElement;
  if (!fullscreen) return doc.body;
  if (fullscreen.tagName === 'VIDEO') return null;
  return fullscreen;
}

const STYLE = `
:host { all: initial; }
.root {
  position: fixed;
  pointer-events: none;
  z-index: 2147483647;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  padding-bottom: 6%;
  box-sizing: border-box;
}
.root[hidden] { display: none; }
.line {
  max-width: 92%;
  margin: 0 0 0.25em;
  padding: 0.15em 0.5em;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.66);
  color: #fff;
  text-align: center;
  line-height: 1.32;
  text-wrap: balance;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.9);
}
.original { font-weight: 600; }
.root.translated .original { color: #cfe3ff; font-weight: 400; font-size: 0.82em; }
.translation { font-weight: 600; order: -1; }
/* Interim text is still being revised; grey it so nobody reads it as final. */
.interim { opacity: 0.9; }
.w { pointer-events: auto; cursor: pointer; border-radius: 3px; }
.w:hover { background: rgba(255, 255, 255, 0.22); }
.pop {
  pointer-events: auto;
  position: fixed;
  max-width: 280px;
  padding: 10px 12px;
  border-radius: 8px;
  background: #16181d;
  color: #f2f4f8;
  border: 1px solid #333842;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
  font-size: 14px;
  line-height: 1.4;
}
.pop b { font-size: 15px; }
.pop .pos { color: #9aa4b2; font-style: italic; margin-left: 4px; }
.pop .tr { margin-top: 4px; color: #bcd6ff; }
.pop button {
  margin-top: 8px; padding: 4px 10px; border-radius: 5px; cursor: pointer;
  border: 1px solid #3a4250; background: #232732; color: inherit; font: inherit;
}
.pop button:hover { background: #2d3341; }
.pop button[disabled] { opacity: 0.6; cursor: default; }
`;

export interface OverlayHooks {
  onWordClick?: (word: string, sentence: string, anchor: DOMRect) => void;
}

export class Overlay {
  readonly host: HTMLElement;
  private readonly shadow: ShadowRoot;
  private readonly root: HTMLElement;
  private readonly original: HTMLElement;
  private readonly translation: HTMLElement;
  private popover: HTMLElement | null = null;
  private video: HTMLVideoElement | null = null;
  private rendered: { id: string; interim: boolean; text: string; translation: string } | null = null;

  constructor(
    private readonly doc: Document = document,
    private readonly hooks: OverlayHooks = {},
  ) {
    this.host = doc.createElement('div');
    this.host.dataset['subtle'] = 'overlay';
    this.shadow = this.host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = STYLE;
    this.root = doc.createElement('div');
    this.root.className = 'root';
    this.root.hidden = true;
    this.original = doc.createElement('p');
    this.original.className = 'line original';
    this.translation = doc.createElement('p');
    this.translation.className = 'line translation';
    this.root.append(this.original, this.translation);
    this.shadow.append(style, this.root);
  }

  mount(): void {
    this.reparent();
  }

  unmount(): void {
    this.closePopover();
    this.host.remove();
  }

  attachTo(video: HTMLVideoElement | null): void {
    this.video = video;
    if (!video) this.root.hidden = true;
  }

  /**
   * Moves the overlay into whatever is fullscreen, or back to the body.
   * Returns false when the page fullscreened a bare `<video>` and there is
   * nowhere to render.
   */
  reparent(): boolean {
    const parent = overlayParent(this.doc);
    if (!parent) {
      this.host.remove();
      return false;
    }
    if (this.host.parentNode !== parent) parent.append(this.host);
    return true;
  }

  /** Keeps the overlay box over the video. Cheap enough to run on every frame. */
  syncPosition(): void {
    if (!this.video || !this.host.isConnected) return;
    const rect = this.video.getBoundingClientRect();
    const style = this.root.style;
    style.left = `${rect.left}px`;
    style.top = `${rect.top}px`;
    style.width = `${rect.width}px`;
    style.height = `${rect.height}px`;
  }

  render(state: OverlayState): void {
    const { caption } = state;
    if (!caption) {
      this.root.hidden = true;
      this.rendered = null;
      return;
    }
    this.root.hidden = false;
    this.root.dataset['captionId'] = caption.id;
    this.root.style.fontSize = `${state.fontSize}px`;

    const showTranslation = state.showTranslation && !state.immersion;
    const next = {
      id: caption.id,
      interim: caption.interim,
      text: caption.original,
      translation: showTranslation ? caption.translation : '',
    };
    // Rebuilding the word spans on every frame would drop the popover and
    // kill text selection, so only touch the DOM when something changed.
    if (
      this.rendered &&
      this.rendered.id === next.id &&
      this.rendered.interim === next.interim &&
      this.rendered.text === next.text &&
      this.rendered.translation === next.translation
    ) {
      return;
    }
    // Translation updates must not rebuild source words under a selection
    // or a word-lookup click.
    if (this.rendered?.text !== next.text) {
      this.original.replaceChildren(...this.wordNodes(caption.original));
    }
    this.rendered = next;

    this.original.classList.toggle('interim', caption.interim);
    this.root.classList.toggle('translated', Boolean(next.translation));
    this.original.lang = caption.srcLang;
    this.translation.lang = caption.tgtLang;
    this.translation.textContent = next.translation;
    this.translation.hidden = !showTranslation || next.translation === '';
    this.translation.classList.toggle('interim', caption.interim);
  }

  private wordNodes(text: string): Node[] {
    const nodes: Node[] = [];
    for (const { word, after } of splitWords(text)) {
      const span = this.doc.createElement('span');
      span.className = 'w';
      span.textContent = word;
      span.addEventListener('click', (e) => {
        e.stopPropagation();
        const bare = bareWord(word);
        if (bare) this.hooks.onWordClick?.(bare, text, span.getBoundingClientRect());
      });
      nodes.push(span);
      if (after) nodes.push(this.doc.createTextNode(after));
    }
    return nodes;
  }

  // ---------------------------------------------------------------- popover

  showPopover(anchor: DOMRect, content: (root: HTMLElement) => void): void {
    this.closePopover();
    const pop = this.doc.createElement('div');
    pop.className = 'pop';
    content(pop);
    this.shadow.append(pop);
    // Clamp so a word near the edge does not push the popover off screen.
    const width = 280;
    const left = Math.min(Math.max(8, anchor.left - width / 2 + anchor.width / 2), window.innerWidth - width - 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.max(8, anchor.top - 8)}px`;
    pop.style.transform = 'translateY(-100%)';
    this.popover = pop;
  }

  closePopover(): void {
    this.popover?.remove();
    this.popover = null;
  }

  get popoverOpen(): boolean {
    return this.popover !== null;
  }
}
