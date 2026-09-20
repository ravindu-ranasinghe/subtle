/**
 * The arithmetic behind dubbing, kept free of the Web Speech API so it can be
 * tested without a voice installed.
 *
 * The hard constraint: a dub has to fit in the gap the original speech
 * occupied. Translations are rarely the same length as their source, so the
 * utterance is compressed by raising the speaking rate — up to the point where
 * it stops being intelligible, after which it is better to overrun slightly
 * than to gabble.
 */

/**
 * Rough speaking rates at `rate = 1`, per script. Measured against macOS
 * voices: English runs ~2.8 words/s, Japanese ~5.5 characters/s.
 */
const WORDS_PER_SEC = 2.8;
const CJK_CHARS_PER_SEC = 5.5;

/** Beyond this the speech is too fast to follow, so the dub is allowed to run long. */
export const MAX_RATE = 1.15;
/** Below this it drags; there is no reason to slow a dub down to fill a gap. */
export const MIN_RATE = 1;

const NEURAL_LANGUAGES = new Set('ar bg hr cs da nl en et fi fr de el hi hu id it ja ko lv lt pl pt ro ru sk sl es sv tr uk vi'.split(' '));
export const supportsNeuralVoice = (lang: string): boolean => NEURAL_LANGUAGES.has(lang.toLowerCase().split('-')[0]!);

function isCJK(text: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text);
}

/** How long `text` would take to speak at rate 1. */
export function estimateSpeechSeconds(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  if (isCJK(trimmed)) {
    return [...trimmed.replace(/\s/g, '')].length / CJK_CHARS_PER_SEC;
  }
  return trimmed.split(/\s+/).length / WORDS_PER_SEC;
}

/**
 * Speaking rate that fits `natural` seconds of speech into `budget`, clamped
 * to what a listener can still follow. A budget of zero or less means "no
 * constraint" rather than "infinitely fast".
 */
export function compressionRate(natural: number, budget: number): number {
  if (budget <= 0 || natural <= 0) return MIN_RATE;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, natural / budget));
}

export interface VoiceLike {
  lang: string;
  name: string;
  default?: boolean;
  localService?: boolean;
}

/**
 * Best voice for `lang`. An exact tag wins, then the base language, then
 * whatever the platform calls default — speaking English words with a
 * Japanese voice is worse than not dubbing at all.
 */
export function pickVoice<T extends VoiceLike>(voices: readonly T[], lang: string): T | null {
  if (voices.length === 0) return null;
  const want = lang.toLowerCase();
  const base = want.split('-')[0]!;
  const matching = voices.filter((v) => v.localService !== false && v.lang.toLowerCase().split(/[-_]/)[0] === base);
  const score = (v: T): number =>
    (v.lang.toLowerCase().replace('_', '-') === want ? 10 : 0) +
    (/premium|enhanced|natural|neural/i.test(v.name) ? 8 : 0) +
    (/Samantha|Daniel|Monica|Mónica|Thomas|Kyoko|Ting.?Ting|Yuna|Anna|Alice|Luciana|Milena/i.test(v.name) ? 4 : 0) +
    (v.default ? 1 : 0);
  return matching.sort((a, b) => score(b) - score(a))[0] ?? null;
}

export interface ScheduleDecision {
  /** Seconds to wait before speaking. */
  delay: number;
  /** False when the moment has passed and speaking now would only confuse. */
  worthSpeaking: boolean;
}

/**
 * Whether a dub is still worth starting.
 *
 * Recognition and translation take time, so a dub is always scheduled for a
 * moment that has partly passed. A little late is fine — the listener hears it
 * over the next sentence. Later than the line it belongs to is not: it would
 * play over unrelated speech.
 */
export function schedule(atAudioTime: number, now: number, budget: number): ScheduleDecision {
  const delay = atAudioTime - now;
  if (delay >= 0) return { delay, worthSpeaking: true };
  // Allow it to start up to one line's worth late, then give up.
  const lateness = -delay;
  return { delay: 0, worthSpeaking: lateness <= Math.max(1, budget) };
}
