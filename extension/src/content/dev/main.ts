/**
 * Drives the real overlay with mock captions so the UI can be worked on with
 * no audio, no models and no extension loaded.
 *
 *   pnpm --filter @subtle/extension exec vite
 *   open http://localhost:5173/src/content/dev/index.html
 *
 * It reuses MockRecognizer and MockTranslator from /shared/mocks, so the
 * caption stream has the same shape and timing the real pipeline produces —
 * including interim lines being replaced by finals.
 */

import type { Caption, Segment } from '@subtle/shared';
import { MockRecognizer, MockTranslator } from '@subtle/shared/mocks';
import { CaptionStore } from '../captions.js';
import { Overlay } from '../overlay.js';

const video = document.querySelector<HTMLVideoElement>('#v')!;
const log = document.querySelector<HTMLElement>('#log')!;
const note = (text: string): void => {
  log.textContent = `${text}\n${log.textContent}`.split('\n').slice(0, 40).join('\n');
};

/**
 * A silent colour-cycling clip, recorded so it is seekable — replay and the
 * seek-clears-captions path need a real timeline, not a live stream.
 */
async function generateVideo(seconds = 8): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = 960;
  canvas.height = 540;
  const ctx = canvas.getContext('2d')!;
  const recorder = new MediaRecorder(canvas.captureStream(30));
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => chunks.push(e.data);
  const done = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  recorder.start();

  // setInterval rather than rAF: rAF is paused in a background tab, and a
  // harness that silently never finishes loading is worse than a slow one.
  const started = performance.now();
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const t = (performance.now() - started) / 1000;
      ctx.fillStyle = `hsl(${(t * 24) % 360} 45% 22%)`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#ffffff33';
      ctx.font = '48px system-ui';
      ctx.fillText(`${t.toFixed(1)}s`, 40, 80);
      if (t >= seconds) {
        clearInterval(timer);
        resolve();
      }
    }, 33);
  });
  recorder.stop();
  await done;
  return URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
}

const store = new CaptionStore();
const state = { showTranslation: true, immersion: false, captionsOn: true, fontSize: 28 };

const overlay = new Overlay(document, {
  onWordClick: (word, sentence, anchor) => {
    note(`gloss: ${word}`);
    // Stands in for the glossRequest round trip through the offscreen doc.
    void translator.gloss(word, sentence, 'de', 'en').then((gloss) => {
      overlay.showPopover(anchor, (root) => {
        const heading = document.createElement('div');
        const b = document.createElement('b');
        b.textContent = gloss.word;
        heading.append(b);
        if (gloss.pos) {
          const pos = document.createElement('span');
          pos.className = 'pos';
          pos.textContent = gloss.pos;
          heading.append(pos);
        }
        const tr = document.createElement('div');
        tr.className = 'tr';
        tr.textContent = gloss.translation;
        const save = document.createElement('button');
        save.textContent = 'Save';
        save.addEventListener('click', () => {
          save.disabled = true;
          save.textContent = 'Saved';
          note(`saved: ${gloss.word} = ${gloss.translation}`);
        });
        root.append(heading, tr, save);
      });
    });
  },
});
overlay.mount();
overlay.attachTo(video);

const translator = new MockTranslator({ latencyMs: 120 });
let recognizer: MockRecognizer | null = null;

/** Mock segments are on the audio clock; here it is just the video clock. */
async function onSegment(segment: Segment): Promise<void> {
  const caption: Caption = {
    id: segment.id,
    original: segment.text,
    translation: segment.interim ? '' : await translator.translate(segment.text, [], segment.lang, 'en'),
    srcLang: segment.lang,
    tgtLang: 'en',
    videoStart: segment.audioStart,
    videoEnd: segment.audioEnd,
    interim: segment.interim,
    ...(segment.words ? { words: segment.words } : {}),
  };
  store.upsert(caption);
  note(`${caption.interim ? 'interim' : 'final  '} ${caption.id}  ${caption.original}`);
}

function startCaptions(): void {
  recognizer?.dispose();
  store.clear();
  recognizer = new MockRecognizer();
  recognizer.onSegment((s) => void onSegment(s));
  void recognizer.load('tiny', () => {}).then(() => {
    recognizer!.pushAudio({ samples: new Float32Array(160), audioStart: video.currentTime });
  });
}

function tick(): void {
  requestAnimationFrame(tick);
  overlay.reparent();
  overlay.syncPosition();
  overlay.render({
    caption: state.captionsOn ? store.activeAt(video.currentTime) : null,
    showTranslation: state.showTranslation,
    fontSize: state.fontSize,
    immersion: state.immersion,
  });
}

const on = (id: string, fn: () => void): void =>
  document.querySelector(`#${id}`)!.addEventListener('click', fn);

on('fs', () => void document.querySelector('main')!.requestFullscreen());
on('translation', () => {
  state.showTranslation = !state.showTranslation;
  note(`translation ${state.showTranslation}`);
});
on('immersion', () => {
  state.immersion = !state.immersion;
  note(`immersion ${state.immersion}`);
});
on('captions', () => {
  state.captionsOn = !state.captionsOn;
  note(`captions ${state.captionsOn}`);
});
on('replay', () => {
  const last = store.latest();
  if (last) video.currentTime = Math.max(0, last.videoStart - 0.15);
});
on('restart', startCaptions);
document.addEventListener('click', () => overlay.closePopover(), true);

// A real file is the better subject; the generated clip is the fallback so
// the harness works with nothing to hand.
document.querySelector<HTMLInputElement>('#file')!.addEventListener('change', (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) {
    video.src = URL.createObjectURL(file);
    note(`loaded ${file.name}`);
  }
});

video.addEventListener('play', startCaptions, { once: true });
video.addEventListener('seeking', () => {
  store.clear();
  note('seek — captions cleared');
});
note('generating an 8s test clip…');
void generateVideo().then((url) => {
  video.src = url;
  note('press play — captions start with the video');
});
tick();
