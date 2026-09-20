/**
 * Saved vocabulary: stored by the content script when the user hits Save on a
 * gloss popover, read and exported by the popup.
 */

export interface SavedWord {
  word: string;
  /** The caption line it came from — an Anki card without context is useless. */
  sentence: string;
  translation: string;
  pos?: string;
  url: string;
  /** Position in the video, so the user can go back to it. */
  videoTime: number;
  savedAt: number;
}

const KEY = 'savedWords';
/** Beyond this the popup list stops being usable and storage gets heavy. */
const LIMIT = 2000;

export async function listWords(): Promise<SavedWord[]> {
  const stored = await chrome.storage.local.get(KEY);
  return (stored[KEY] as SavedWord[] | undefined) ?? [];
}

/** Saving the same word from the same line twice replaces the first. */
export async function saveWord(word: SavedWord): Promise<SavedWord[]> {
  const existing = await listWords();
  const filtered = existing.filter((w) => !(w.word === word.word && w.sentence === word.sentence));
  const next = [...filtered, word].slice(-LIMIT);
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export async function removeWord(word: string, savedAt: number): Promise<SavedWord[]> {
  const next = (await listWords()).filter((w) => !(w.word === word && w.savedAt === savedAt));
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export async function clearWords(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}

// ------------------------------------------------------------------ export

const COLUMNS = ['word', 'translation', 'pos', 'sentence', 'url', 'videoTime', 'savedAt'] as const;

/** RFC 4180: quote anything containing a comma, quote or newline; double the quotes. */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function cell(word: SavedWord, column: (typeof COLUMNS)[number]): string {
  const value = word[column];
  if (value === undefined) return '';
  if (column === 'videoTime') return (value as number).toFixed(2);
  if (column === 'savedAt') return new Date(value as number).toISOString();
  return String(value);
}

export function toCSV(words: SavedWord[]): string {
  const rows = words.map((w) => COLUMNS.map((c) => csvCell(cell(w, c))).join(','));
  return [COLUMNS.join(','), ...rows].join('\r\n');
}

/**
 * Anki's plain-text import is tab separated with one note per line, so a tab
 * or a newline inside a field silently shifts every column after it. Tabs
 * become spaces and newlines become `<br>`, which Anki renders.
 */
function ankiField(value: string): string {
  return value.replaceAll('\t', ' ').replace(/\r?\n/g, '<br>').trim();
}

/**
 * Front, back, sentence, source — the order Anki maps to fields 1..4 on
 * import. No header: Anki would read one as a note.
 */
export function toAnki(words: SavedWord[]): string {
  return words
    .map((w) =>
      [
        ankiField(w.word),
        ankiField(w.pos ? `${w.translation} (${w.pos})` : w.translation),
        ankiField(w.sentence),
        ankiField(`${w.url}#t=${w.videoTime.toFixed(0)}`),
      ].join('\t'),
    )
    .join('\n');
}

export const EXPORTS = {
  csv: { filename: 'subtle-words.csv', mime: 'text/csv', render: toCSV },
  anki: { filename: 'subtle-words.txt', mime: 'text/plain', render: toAnki },
} as const;

export type ExportFormat = keyof typeof EXPORTS;
