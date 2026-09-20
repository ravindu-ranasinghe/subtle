/**
 * Text surgery around sentence-level MT models.
 *
 * opus-mt and NLLB translate one sentence at a time and take no context
 * argument. The workarounds below were shaped by what the models actually did
 * (SPIKES.md section C), not by what ought to work:
 *
 *  - Joining context and sentence with a plain space or a newline makes
 *    opus-mt **silently drop a sentence**. "Ayer fui al mercado. Compré unas
 *    manzanas rojas. Estaban muy ricas." came back as "I bought some red
 *    apples, they were very good." — the first sentence simply gone. You
 *    cannot strip what was never emitted.
 *  - " <sep> " kept all the sentences in 4 of 4 trials, though the marker
 *    itself sometimes survives into the output and sometimes does not.
 *
 * So context is used, and then *checked*: if the sentence count does not come
 * back as expected, the caller re-translates without context. The failure is
 * detected rather than silently shipped.
 */

/** Survives opus-mt as a boundary far more reliably than a space or newline. */
export const CONTEXT_SEPARATOR = ' <sep> ';

/** Context sentences to carry. Beyond three, the model starts dropping them. */
export const MAX_CONTEXT = 3;

const SENTENCE_END = /(?<=[.!?。！？])/;

/** Split into sentences. Abbreviations over-split; captions rarely contain them. */
export function sentences(text: string): string[] {
  return text
    .split(SENTENCE_END)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Joins the most recent `MAX_CONTEXT` context lines ahead of `text`. */
export function prependContext(text: string, context: string[]): string {
  const recent = context.slice(-MAX_CONTEXT).filter((c) => c.trim());
  if (recent.length === 0) return text;
  return recent.join(' ') + CONTEXT_SEPARATOR + text;
}

export interface StripResult {
  text: string;
  /**
   * False when the output did not come back with the expected number of
   * sentences — the model merged or dropped something and the tail cannot be
   * trusted to be the target sentence. Callers re-translate without context.
   */
  trusted: boolean;
}

/**
 * Takes the target sentence back out of a contextual translation.
 *
 * `contextCount` is how many context sentences went in, so the output should
 * hold exactly that many plus one.
 */
export function stripContext(output: string, contextCount: number): StripResult {
  const cleaned = output.replaceAll('<sep>', ' ').replace(/\s+/g, ' ').trim();
  if (contextCount <= 0) return { text: cleaned, trusted: true };

  const parts = sentences(cleaned);
  if (parts.length !== contextCount + 1) return { text: cleaned, trusted: false };
  return { text: parts[parts.length - 1]!, trusted: true };
}

// -------------------------------------------------------------------- gloss

const WORD = /[\p{L}\p{N}]+/gu;

function words(text: string): string[] {
  return text.match(WORD) ?? [];
}

/**
 * The word `full` has that `without` does not.
 *
 * Translating a word on its own loses its sense: Spanish "banco" alone comes
 * back as "bank" even in "Voy a sentarme en el banco del parque". Translating
 * the sentence with and without the word and taking the difference gets
 * "bench" instead — the sense the sentence actually carries.
 *
 * Returns null when the difference is empty or so large that removing the word
 * clearly reshaped the whole sentence; the caller then falls back.
 */
export function glossDifference(full: string, without: string): string | null {
  const remaining = new Map<string, number>();
  for (const w of words(without.toLowerCase())) {
    remaining.set(w, (remaining.get(w) ?? 0) + 1);
  }

  const extra: string[] = [];
  for (const w of words(full)) {
    const key = w.toLowerCase();
    const count = remaining.get(key) ?? 0;
    if (count > 0) remaining.set(key, count - 1);
    else extra.push(w);
  }

  if (extra.length === 0 || extra.length > 5) return null;
  // The content word is the long one: the diff also picks up articles and
  // prepositions that moved when the word left.
  return extra.reduce((a, b) => (b.length > a.length ? b : a));
}

/** Removes `word` from `sentence`, for the difference above. */
export function removeWord(sentence: string, word: string): string {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return sentence
    .replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu'), '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}
