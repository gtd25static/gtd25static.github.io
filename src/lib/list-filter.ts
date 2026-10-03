/**
 * The quick filter above each list, and the saved searches it keeps as chips.
 * Pure functions — fully unit-tested.
 *
 * "Fuzzy" here means forgiving about case, accents and the odd typo — NOT the
 * subsequence matching of fuzzy finders, where "pan" finds "Preparar agenda
 * nueva" and a short query matches half the list. The rules:
 *  - every word of the query must match (AND), in the title or the description;
 *  - a word matches wherever it appears as typed (substring), ignoring case and
 *    accents — so a word still being typed already finds its item;
 *  - failing that, a WHOLE word of the item within a small edit distance: one
 *    typo from 5 letters, two from 9, the first letter right, and never for a
 *    word with digits ("2024" must not find "2025").
 */

export const MAX_SAVED_SEARCHES = 12;
export const MAX_SAVED_SEARCH_LENGTH = 100;

/** Lowercase and strip accents, keeping punctuation so "e-mail" or "c++" match as typed. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

function lettersAndDigits(text: string): string {
  return text.replace(/[^\p{L}\p{N}]+/gu, '');
}

function typoBudget(word: string): number {
  if (/\p{N}/u.test(word)) return 0;
  return word.length >= 9 ? 2 : word.length >= 5 ? 1 : 0;
}

/**
 * Optimal-string-alignment distance (Levenshtein plus adjacent swaps). Returns
 * `max + 1` as soon as the distance is known to exceed `max`.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prevPrev: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prevPrev[j - 2] + 1);
      row.push(d);
      rowMin = Math.min(rowMin, d);
    }
    if (rowMin > max) return max + 1;
    prevPrev = prev;
    prev = row;
  }
  return prev[b.length];
}

interface Haystack {
  text: string;
  words: string[];
}

function toHaystack(texts: Array<string | undefined>): Haystack {
  const text = fold(texts.filter(Boolean).join('\n'));
  // Both "e-mail" as one word and its parts, so a typo'd word is compared with each.
  const words = new Set<string>();
  for (const chunk of text.split(/\s+/)) {
    words.add(lettersAndDigits(chunk));
    for (const part of chunk.split(/[^\p{L}\p{N}]+/u)) words.add(part);
  }
  words.delete('');
  return { text, words: [...words] };
}

function tokenMatches(token: string, haystack: Haystack): boolean {
  if (haystack.text.includes(token)) return true;
  const word = lettersAndDigits(token);
  const budget = typoBudget(word);
  if (budget === 0) return false;
  return haystack.words.some((w) => w[0] === word[0] && editDistance(word, w, budget) <= budget);
}

function queryTokens(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean);
}

/** Whether `texts` (an item's title, description…) match `query`. A blank query matches everything. */
export function matchesListFilter(query: string, texts: Array<string | undefined>): boolean {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return true;
  const haystack = toHaystack(texts);
  return tokens.every((t) => tokenMatches(t, haystack));
}

/** The tasks matching `query` on title or description, in their original order (the same array when blank). */
export function filterTasksByQuery<T extends { title?: string; description?: string }>(tasks: T[], query: string): T[] {
  if (queryTokens(query).length === 0) return tasks;
  return tasks.filter((t) => matchesListFilter(query, [t.title, t.description]));
}

/** Two searches that filter identically: case, accents and spacing aside. */
export function sameSearch(a: string, b: string): boolean {
  return queryTokens(a).join(' ') === queryTokens(b).join(' ');
}

/**
 * A list row's saved searches, cleaned: trimmed non-empty strings within the
 * length limit, no duplicates, at most MAX_SAVED_SEARCHES. Rows arrive from
 * sync and from backups, so the field is untrusted.
 */
export function sanitizeSavedSearches(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const search = entry.trim();
    if (!search || search.length > MAX_SAVED_SEARCH_LENGTH) continue;
    if (result.some((s) => sameSearch(s, search))) continue;
    result.push(search);
    if (result.length === MAX_SAVED_SEARCHES) break;
  }
  return result;
}
