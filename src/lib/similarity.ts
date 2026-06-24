/**
 * Local, lexical near-duplicate detection for task / follow-up titles.
 *
 * No network and no model: text normalization + token Jaccard + character-bigram
 * Dice, with connected entries clustered via union-find. Used by the per-list
 * "merge suggestions" feature. Pure functions — fully unit-tested.
 */

import { DEDUPE_TITLE_THRESHOLD, DEDUPE_MAX_ITEMS } from './constants';

/** Lowercase, strip diacritics, drop punctuation, collapse whitespace. */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Word tokens of the normalized text, dropping single-character noise. */
export function tokenize(text: string): string[] {
  const norm = normalizeText(text);
  if (!norm) return [];
  return norm.split(' ').filter((t) => t.length >= 2);
}

/** Jaccard similarity of two token lists: |A∩B| / |A∪B|. */
export function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

function bigramCounts(s: string): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s.slice(i, i + 2);
    map.set(bg, (map.get(bg) ?? 0) + 1);
  }
  return map;
}

/**
 * Sørensen–Dice coefficient over character bigrams of the normalized strings
 * (spaces removed). Robust to typos and minor word-order changes.
 */
export function diceCoefficient(a: string, b: string): number {
  const na = normalizeText(a).replace(/ /g, '');
  const nb = normalizeText(b).replace(/ /g, '');
  if (na.length < 2 || nb.length < 2) return na === nb && na.length > 0 ? 1 : 0;
  const bgA = bigramCounts(na);
  const bgB = bigramCounts(nb);
  let overlap = 0;
  let totalA = 0;
  for (const c of bgA.values()) totalA += c;
  let totalB = 0;
  for (const [bg, c] of bgB) {
    totalB += c;
    const inA = bgA.get(bg);
    if (inA) overlap += Math.min(inA, c);
  }
  return (2 * overlap) / (totalA + totalB);
}

/**
 * Title similarity in [0,1]: exact-after-normalize wins outright, otherwise the
 * stronger of token overlap (order-insensitive) and character-bigram Dice
 * (typo-tolerant).
 */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  return Math.max(jaccardSimilarity(tokenize(a), tokenize(b)), diceCoefficient(a, b));
}

export interface SimilarItem {
  id: string;
  title: string;
}

export interface DuplicateGroup {
  /** member ids (>= 2), in input order */
  ids: string[];
  /** average similarity of the qualifying edges within the group */
  score: number;
}

/**
 * Group items whose titles are near-duplicates. Builds an edge for every pair
 * scoring >= `threshold`, unions the endpoints, and returns connected components
 * of size >= 2 (so A~B~C clusters together even if A and C alone are below the
 * bar). Blank-titled items are ignored; detection is skipped entirely for lists
 * larger than `maxItems` to bound the O(n^2) comparison.
 */
export function findDuplicateGroups(
  items: SimilarItem[],
  opts?: { threshold?: number; maxItems?: number },
): DuplicateGroup[] {
  const threshold = opts?.threshold ?? DEDUPE_TITLE_THRESHOLD;
  const maxItems = opts?.maxItems ?? DEDUPE_MAX_ITEMS;
  if (items.length > maxItems) return [];

  const usable = items.filter((it) => normalizeText(it.title).length > 0);
  const n = usable.length;
  if (n < 2) return [];

  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const edges: Array<{ a: number; b: number; score: number }> = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const score = titleSimilarity(usable[i].title, usable[j].title);
      if (score >= threshold) {
        edges.push({ a: i, b: j, score });
        parent[find(i)] = find(j);
      }
    }
  }
  if (edges.length === 0) return [];

  // Aggregate edge scores per final component root.
  const agg = new Map<number, { sum: number; count: number }>();
  for (const e of edges) {
    const root = find(e.a);
    const cur = agg.get(root) ?? { sum: 0, count: 0 };
    cur.sum += e.score;
    cur.count += 1;
    agg.set(root, cur);
  }

  const membersByRoot = new Map<number, string[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = membersByRoot.get(root);
    if (list) list.push(usable[i].id);
    else membersByRoot.set(root, [usable[i].id]);
  }

  const groups: DuplicateGroup[] = [];
  for (const [root, ids] of membersByRoot) {
    if (ids.length < 2) continue;
    const a = agg.get(root);
    groups.push({ ids, score: a ? a.sum / a.count : 0 });
  }
  // Most confident first; stable tiebreak by first member id.
  groups.sort((x, y) => y.score - x.score || x.ids[0].localeCompare(y.ids[0]));
  return groups;
}
