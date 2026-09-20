// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Caption } from '@subtle/shared';
import { Overlay, overlayParent } from './overlay.js';
import { scoreVideos } from './video.js';

/** jsdom has no Fullscreen API; this is the part the overlay reads. */
function setFullscreen(element: Element | null): void {
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => element,
  });
}

function caption(patch: Partial<Caption> = {}): Caption {
  return {
    id: 'u1',
    original: 'Guten Morgen, wie geht es dir?',
    translation: 'Good morning, how are you?',
    srcLang: 'de',
    tgtLang: 'en',
    videoStart: 10,
    videoEnd: 12,
    interim: false,
    ...patch,
  };
}

const state = { showTranslation: true, fontSize: 28, immersion: false };

beforeEach(() => {
  document.body.innerHTML = '';
  setFullscreen(null);
});

describe('overlayParent', () => {
  it('is the body when nothing is fullscreen', () => {
    expect(overlayParent(document)).toBe(document.body);
  });

  it('is the fullscreen element when a player wrapper goes fullscreen', () => {
    const wrapper = document.createElement('div');
    document.body.append(wrapper);
    setFullscreen(wrapper);
    expect(overlayParent(document)).toBe(wrapper);
  });

  it('is null when the page fullscreened the bare <video>', () => {
    // A video element renders no children, so there is nowhere to overlay.
    const video = document.createElement('video');
    document.body.append(video);
    setFullscreen(video);
    expect(overlayParent(document)).toBeNull();
  });
});

describe('Overlay re-parenting', () => {
  it('starts in the body', () => {
    const overlay = new Overlay(document);
    overlay.mount();
    expect(overlay.host.parentNode).toBe(document.body);
  });

  it('moves into the fullscreen wrapper and back out again', () => {
    const wrapper = document.createElement('div');
    document.body.append(wrapper);
    const overlay = new Overlay(document);
    overlay.mount();

    setFullscreen(wrapper);
    expect(overlay.reparent()).toBe(true);
    expect(overlay.host.parentNode).toBe(wrapper);

    setFullscreen(null);
    expect(overlay.reparent()).toBe(true);
    expect(overlay.host.parentNode).toBe(document.body);
  });

  it('detaches and reports failure when the bare video is fullscreen', () => {
    const video = document.createElement('video');
    document.body.append(video);
    const overlay = new Overlay(document);
    overlay.mount();

    setFullscreen(video);
    expect(overlay.reparent()).toBe(false);
    expect(overlay.host.isConnected).toBe(false);

    // ...and recovers when fullscreen exits.
    setFullscreen(null);
    expect(overlay.reparent()).toBe(true);
    expect(overlay.host.parentNode).toBe(document.body);
  });

  it('does not move the node when the parent has not changed', () => {
    const overlay = new Overlay(document);
    overlay.mount();
    const append = vi.spyOn(document.body, 'append');
    overlay.reparent();
    overlay.reparent();
    expect(append).not.toHaveBeenCalled();
  });

  it('survives being re-parented while a caption is up', () => {
    const wrapper = document.createElement('div');
    document.body.append(wrapper);
    const overlay = new Overlay(document);
    overlay.mount();
    overlay.render({ caption: caption(), ...state });

    setFullscreen(wrapper);
    overlay.reparent();
    expect(overlay.host.parentNode).toBe(wrapper);
    expect(overlay.host.shadowRoot!.querySelector('.original')!.textContent).toContain('Guten Morgen');
  });
});

describe('Overlay rendering', () => {
  const shadow = (o: Overlay) => o.host.shadowRoot!;

  it('renders the original and translation', () => {
    const overlay = new Overlay(document);
    overlay.mount();
    overlay.render({ caption: caption(), ...state });
    expect(shadow(overlay).querySelector('.original')!.textContent).toContain('Guten Morgen');
    expect(shadow(overlay).querySelector('.translation')!.textContent).toBe('Good morning, how are you?');
  });

  it('greys interim text and clears the flag on the final', () => {
    const overlay = new Overlay(document);
    overlay.mount();
    overlay.render({ caption: caption({ original: 'Guten', interim: true }), ...state });
    expect(shadow(overlay).querySelector('.original')!.classList.contains('interim')).toBe(true);

    overlay.render({ caption: caption(), ...state });
    expect(shadow(overlay).querySelector('.original')!.classList.contains('interim')).toBe(false);
  });

  it('hides the translation when it is switched off', () => {
    const overlay = new Overlay(document);
    overlay.mount();
    overlay.render({ caption: caption(), ...state, showTranslation: false });
    expect((shadow(overlay).querySelector('.translation') as HTMLElement).hidden).toBe(true);
  });

  it('hides the translation in immersion mode even when it is switched on', () => {
    const overlay = new Overlay(document);
    overlay.mount();
    overlay.render({ caption: caption(), ...state, immersion: true });
    expect((shadow(overlay).querySelector('.translation') as HTMLElement).hidden).toBe(true);
  });

  it('hides everything when there is no caption', () => {
    const overlay = new Overlay(document);
    overlay.mount();
    overlay.render({ caption: caption(), ...state });
    overlay.render({ caption: null, ...state });
    expect((shadow(overlay).querySelector('.root') as HTMLElement).hidden).toBe(true);
  });

  it('rebuilds the words only when the line changes', () => {
    const overlay = new Overlay(document);
    overlay.mount();
    overlay.render({ caption: caption(), ...state });
    const first = shadow(overlay).querySelector('.w');
    overlay.render({ caption: caption(), ...state });
    // Same nodes: rebuilding every frame would drop the popover and any selection.
    expect(shadow(overlay).querySelector('.w')).toBe(first);

    overlay.render({ caption: caption({ translation: 'Updated translation' }), ...state });
    expect(shadow(overlay).querySelector('.w')).toBe(first);
    overlay.render({ caption: caption({ original: 'Etwas anderes' }), ...state });
    expect(shadow(overlay).querySelector('.w')).not.toBe(first);
  });

  it('reports the clicked word without its punctuation', () => {
    const clicks: string[] = [];
    const overlay = new Overlay(document, { onWordClick: (w) => clicks.push(w) });
    overlay.mount();
    overlay.render({ caption: caption(), ...state });
    const words = [...shadow(overlay).querySelectorAll('.w')] as HTMLElement[];
    words[1]!.click(); // "Morgen,"
    expect(clicks).toEqual(['Morgen']);
  });

  it('opens and closes the gloss popover', () => {
    const overlay = new Overlay(document);
    overlay.mount();
    expect(overlay.popoverOpen).toBe(false);
    overlay.showPopover(new DOMRect(10, 200, 40, 20), (root) => {
      root.textContent = 'gloss';
    });
    expect(overlay.popoverOpen).toBe(true);
    expect(shadow(overlay).querySelector('.pop')!.textContent).toBe('gloss');
    overlay.closePopover();
    expect(shadow(overlay).querySelector('.pop')).toBeNull();
  });

  it('keeps the styles inside the shadow root, out of the page', () => {
    const overlay = new Overlay(document);
    overlay.mount();
    expect(shadow(overlay).querySelector('style')).not.toBeNull();
    expect(document.querySelector('style')).toBeNull();
  });
});

describe('scoreVideos', () => {
  const view = { width: 1280, height: 720 };

  function makeVideo(rect: Partial<DOMRect>, options: { paused?: boolean; readyState?: number } = {}) {
    const video = document.createElement('video');
    const full = { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, ...rect } as DOMRect;
    video.getBoundingClientRect = () => full;
    Object.defineProperty(video, 'paused', { value: options.paused ?? false });
    Object.defineProperty(video, 'readyState', { value: options.readyState ?? 4 });
    return video;
  }

  it('prefers the larger video', () => {
    const big = makeVideo({ width: 800, height: 450, right: 800, bottom: 450 });
    const small = makeVideo({ width: 200, height: 150, right: 200, bottom: 150 });
    expect(scoreVideos([small, big], view)[0]!.video).toBe(big);
  });

  it('prefers a playing video over a larger paused one', () => {
    const paused = makeVideo({ width: 800, height: 450, right: 800, bottom: 450 }, { paused: true });
    const playing = makeVideo({ width: 640, height: 360, right: 640, bottom: 360 });
    expect(scoreVideos([paused, playing], view)[0]!.video).toBe(playing);
  });

  it('ignores thumbnails and tracking pixels', () => {
    const tiny = makeVideo({ width: 1, height: 1, right: 1, bottom: 1 });
    expect(scoreVideos([tiny], view)).toHaveLength(0);
  });

  it('ignores a video scrolled out of the viewport', () => {
    const offscreen = makeVideo({ top: 2000, left: 0, width: 800, height: 450, right: 800, bottom: 2450 });
    expect(scoreVideos([offscreen], view)).toHaveLength(0);
  });

  it('gives the fullscreen video the win outright', () => {
    const big = makeVideo({ width: 1280, height: 720, right: 1280, bottom: 720 });
    const small = makeVideo({ width: 200, height: 200, right: 200, bottom: 200 }, { paused: true });
    expect(scoreVideos([big, small], view, small)[0]!.video).toBe(small);
  });
});
