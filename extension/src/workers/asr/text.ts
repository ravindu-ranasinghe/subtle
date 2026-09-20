/**
 * Text heuristics: stitching overlapping chunks back together, and throwing
 * away what Whisper made up.
 *
 * Whisper on near-silence is confidently wrong. It has favourite phrases
 * ("Thank you.", "ご視聴ありがとうございました") from subtitle-scraped training
 * data, it falls into repetition loops, and it will emit a paragraph for two
 * seconds of hum. None of that is detectable from the text alone, which is why
 * these take the chunk's energy and VAD score too.
 */

/** Strip case, punctuation and spacing so two spellings of the same word match. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function hasCJK(s: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(s);
}

/** Word tokens where the language has spaces, characters where it does not. */
function tokenize(s: string): { tokens: string[]; separator: string } {
  const trimmed = s.trim();
  if (/\s/.test(trimmed)) return { tokens: trimmed.split(/\s+/), separator: ' ' };
  return { tokens: [...trimmed], separator: '' };
}

/**
 * Removes from `next` the part it repeats from the end of `previous`.
 *
 * Chunks of a long utterance overlap by half a second so nothing is clipped
 * mid-word, which means Whisper transcribes that half second twice. Matching
 * is on normalized tokens, but the returned text keeps its original spelling
 * and punctuation.
 */
export function dedupeOverlap(previous: string, next: string, maxUnits = 24): string {
  if (!previous.trim() || !next.trim()) return next.trim();
  const prev = tokenize(previous);
  const cur = tokenize(next);
  const limit = Math.min(maxUnits, prev.tokens.length, cur.tokens.length);

  // Longest match wins: a one-word overlap is often coincidence, a six-word
  // one never is.
  for (let k = limit; k >= 1; k--) {
    const tail = prev.tokens.slice(prev.tokens.length - k).map(normalize).join('');
    const head = cur.tokens.slice(0, k).map(normalize).join('');
    if (tail.length > 0 && tail === head) {
      return cur.tokens.slice(k).join(cur.separator).trim();
    }
  }
  return next.trim();
}

/** `previous` and the non-repeated part of `next`, joined. */
export function appendDeduped(previous: string, next: string): string {
  const tail = dedupeOverlap(previous, next);
  if (!tail) return previous.trim();
  if (!previous.trim()) return tail;
  return `${previous.trim()}${hasCJK(previous) && hasCJK(tail) ? '' : ' '}${tail}`;
}

// --------------------------------------------------------- hallucinations

/**
 * Phrases Whisper emits when it has nothing to transcribe. Normalized, so
 * punctuation and case do not matter.
 */
const IDLE_PHRASES = [
  // English
  'thankyou', 'thanksforwatching', 'thankyouforwatching', 'thanksforwatchingthisvideo',
  'pleasesubscribe', 'subscribetomychannel', 'seeyouinthenextvideo', 'bye', 'byebye', 'you',
  // Amara / subtitle credits, in the languages we target
  'subtitlesbytheamaraorgcommunity', 'amaraorg',
  'subtítulosrealizadosporlacomunidaddeamaraorg', 'subtitulosrealizadosporlacomunidaddeamaraorg',
  'soustitresréalisésparlacommunautédamaraorg', 'soustitresrealisesparlacommunautedamaraorg',
  'soustitresfaitparlacommunauté',
  // Spanish / French sign-offs
  'graciasporver', 'graciasporverelvideo', 'suscríbete',
  'mercidavoirregardécettevidéo', 'abonnezvous',
  // Japanese
  'ご視聴ありがとうございました', 'ご視聴ありがとうございます', '字幕視聴ありがとうございました',
  'おやすみなさい', 'チャンネル登録お願いします',
  // Non-speech markers
  'music', 'musique', 'música', 'applause', 'silence', 'blank_audio',
].map(normalize);

export interface SegmentSignals {
  text: string;
  /** Length of the audio the text claims to describe. */
  audioSeconds: number;
  /** Mean VAD probability over the chunk. */
  meanProb: number;
  /** RMS of the chunk, 0..1. */
  energy: number;
}

export interface Verdict {
  keep: boolean;
  /** Set when `keep` is false: which rule fired, for metrics and debugging. */
  reason?: 'empty' | 'idle-phrase' | 'repetition-loop' | 'impossible-rate';
}

/**
 * RMS below this is effectively silence. Speech in a captured tab sits an
 * order of magnitude above it.
 * ponytail: fixed gate; make it adaptive if quiet sources start getting cut.
 */
export const LOW_ENERGY_RMS = 0.012;
const LOW_PROB = 0.6;

/** Measured against macOS TTS clips, which run dense: ~17 chars/s, ~3.4 words/s. */
const MAX_CHARS_PER_SEC = 30;
const MAX_CJK_CHARS_PER_SEC = 16;
const MAX_WORDS_PER_SEC = 7;

/**
 * True when `tokens` is mostly one n-gram repeated — "you you you you", or a
 * sentence the decoder got stuck on.
 */
export function hasRepetitionLoop(tokens: string[]): boolean {
  for (let n = 1; n <= 5; n++) {
    if (tokens.length < n * 4) continue;
    let i = 0;
    while (i + 2 * n <= tokens.length) {
      let reps = 1;
      while (i + (reps + 1) * n <= tokens.length && sameGram(tokens, i, i + reps * n, n)) reps++;
      const covered = (reps * n) / tokens.length;
      if (reps >= 6 || (reps >= 4 && covered >= 0.6)) return true;
      i += Math.max(1, (reps - 1) * n);
    }
  }
  return false;
}

function sameGram(tokens: string[], a: number, b: number, n: number): boolean {
  for (let k = 0; k < n; k++) {
    if (normalize(tokens[a + k]!) !== normalize(tokens[b + k]!)) return false;
  }
  return true;
}

export function classifySegment(signals: SegmentSignals): Verdict {
  const text = signals.text.trim();
  if (normalize(text).length === 0) return { keep: false, reason: 'empty' };

  const quiet = signals.energy < LOW_ENERGY_RMS || signals.meanProb < LOW_PROB;
  if (quiet && IDLE_PHRASES.includes(normalize(text))) {
    return { keep: false, reason: 'idle-phrase' };
  }

  const { tokens } = tokenize(text);
  if (hasRepetitionLoop(tokens)) return { keep: false, reason: 'repetition-loop' };

  if (signals.audioSeconds > 0) {
    const chars = normalize(text).length;
    const charLimit = hasCJK(text) ? MAX_CJK_CHARS_PER_SEC : MAX_CHARS_PER_SEC;
    if (chars / signals.audioSeconds > charLimit) return { keep: false, reason: 'impossible-rate' };
    if (/\s/.test(text)) {
      const words = text.split(/\s+/).length;
      if (words / signals.audioSeconds > MAX_WORDS_PER_SEC) {
        return { keep: false, reason: 'impossible-rate' };
      }
    }
  }

  return { keep: true };
}

/** RMS of a chunk, for {@link classifySegment}. */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / samples.length);
}
