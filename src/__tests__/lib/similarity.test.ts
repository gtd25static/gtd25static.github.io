import { describe, it, expect } from 'vitest';
import {
  normalizeText,
  tokenize,
  jaccardSimilarity,
  diceCoefficient,
  titleSimilarity,
  findDuplicateGroups,
} from '../../lib/similarity';

describe('normalizeText', () => {
  it('lowercases, strips diacritics and punctuation, collapses whitespace', () => {
    expect(normalizeText('Café  Olé!')).toBe('cafe ole');
    expect(normalizeText('Comprar   Leche')).toBe('comprar leche');
    expect(normalizeText('  Hello, World — again  ')).toBe('hello world again');
  });

  it('returns empty string for punctuation/whitespace only', () => {
    expect(normalizeText('   ')).toBe('');
    expect(normalizeText('---')).toBe('');
  });
});

describe('tokenize', () => {
  it('splits into words and drops single-character noise', () => {
    expect(tokenize('Comprar Leche')).toEqual(['comprar', 'leche']);
    expect(tokenize('a b cd')).toEqual(['cd']);
  });
});

describe('jaccardSimilarity', () => {
  it('is 1 for identical token sets and 0 for disjoint', () => {
    expect(jaccardSimilarity(['a', 'b'], ['b', 'a'])).toBe(1);
    expect(jaccardSimilarity(['a'], ['b'])).toBe(0);
    expect(jaccardSimilarity([], ['a'])).toBe(0);
  });

  it('computes partial overlap', () => {
    // {a,b,c} vs {a,b,c,d} -> 3/4
    expect(jaccardSimilarity(['a', 'b', 'c'], ['a', 'b', 'c', 'd'])).toBeCloseTo(0.75, 5);
  });
});

describe('diceCoefficient', () => {
  it('is 1 for identical strings (after normalization)', () => {
    expect(diceCoefficient('Comprar Leche', 'comprar  leche')).toBe(1);
  });

  it('is high for a one-character typo and low for unrelated', () => {
    expect(diceCoefficient('Comprar leche', 'Comprar lechee')).toBeGreaterThan(0.85);
    expect(diceCoefficient('comprar leche', 'pagar alquiler')).toBeLessThan(0.4);
  });
});

describe('titleSimilarity', () => {
  it('is 1 for case/accent/whitespace-only differences', () => {
    expect(titleSimilarity('Comprar leche', 'comprar  LECHE')).toBe(1);
  });

  it('is 1 for word reorder (token-set match)', () => {
    expect(titleSimilarity('leche comprar', 'comprar leche')).toBe(1);
  });

  it('is high for typos, low for unrelated, 0 for blank', () => {
    expect(titleSimilarity('Comprar leche', 'Comprar lechee')).toBeGreaterThan(0.85);
    expect(titleSimilarity('Comprar leche', 'Pagar alquiler')).toBeLessThan(0.5);
    expect(titleSimilarity('', 'anything')).toBe(0);
  });
});

describe('findDuplicateGroups', () => {
  it('groups near-duplicate titles and leaves unrelated ones out', () => {
    const groups = findDuplicateGroups([
      { id: '1', title: 'Comprar leche' },
      { id: '2', title: 'comprar  Leche' },
      { id: '3', title: 'Pagar alquiler' },
    ]);
    expect(groups).toHaveLength(1);
    expect(new Set(groups[0].ids)).toEqual(new Set(['1', '2']));
    expect(groups[0].score).toBeGreaterThan(0.72);
  });

  it('clusters transitively (A~B~C)', () => {
    const groups = findDuplicateGroups([
      { id: 'a', title: 'Call John Smith' },
      { id: 'b', title: 'Call John Smith jr' },
      { id: 'c', title: 'Call John Smith sr' },
      { id: 'd', title: 'Buy groceries' },
    ]);
    expect(groups).toHaveLength(1);
    expect(new Set(groups[0].ids)).toEqual(new Set(['a', 'b', 'c']));
  });

  it('ignores blank titles and returns [] when nothing is similar', () => {
    expect(
      findDuplicateGroups([
        { id: '1', title: '   ' },
        { id: '2', title: 'Unique thing' },
        { id: '3', title: 'Totally different' },
      ]),
    ).toEqual([]);
  });

  it('respects the threshold option', () => {
    const items = [
      { id: '1', title: 'Call John Smith' },
      { id: '2', title: 'Call John Smith jr' },
    ];
    expect(findDuplicateGroups(items, { threshold: 0.95 })).toEqual([]);
    expect(findDuplicateGroups(items, { threshold: 0.7 })).toHaveLength(1);
  });

  it('bails out for lists larger than maxItems', () => {
    const items = [
      { id: '1', title: 'Comprar leche' },
      { id: '2', title: 'comprar leche' },
      { id: '3', title: 'comprar leche' },
    ];
    expect(findDuplicateGroups(items, { maxItems: 2 })).toEqual([]);
  });
});
