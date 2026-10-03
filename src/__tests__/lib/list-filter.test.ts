import {
  editDistance,
  matchesListFilter,
  filterTasksByQuery,
  sanitizeSavedSearches,
  sameSearch,
  MAX_SAVED_SEARCHES,
  MAX_SAVED_SEARCH_LENGTH,
} from '../../lib/list-filter';

const matches = (query: string, ...texts: Array<string | undefined>) => matchesListFilter(query, texts);

describe('editDistance (optimal string alignment)', () => {
  it('counts insertions, deletions and substitutions', () => {
    expect(editDistance('kitten', 'kitten', 2)).toBe(0);
    expect(editDistance('kitten', 'sitten', 2)).toBe(1);
    expect(editDistance('kitten', 'kittn', 2)).toBe(1);
    expect(editDistance('kitten', 'kittens', 2)).toBe(1);
  });

  it('counts an adjacent swap as one edit', () => {
    expect(editDistance('meeting', 'meetign', 2)).toBe(1);
  });

  it('stops early once past the budget', () => {
    expect(editDistance('abcdef', 'uvwxyz', 1)).toBeGreaterThan(1);
    expect(editDistance('a', 'abcdef', 1)).toBeGreaterThan(1);
  });
});

describe('matchesListFilter — what it finds', () => {
  it('a blank query matches everything', () => {
    expect(matches('', 'anything')).toBe(true);
    expect(matches('   ', 'anything')).toBe(true);
  });

  it('ignores case and accents, both ways', () => {
    expect(matches('reunion', 'Reunión con Ana')).toBe(true);
    expect(matches('REUNIÓN', 'reunion con ana')).toBe(true);
  });

  it('matches part of a word, so a word still being typed already finds it', () => {
    expect(matches('presu', 'Revisar presupuesto Q3')).toBe(true);
    expect(matches('puesto', 'Revisar presupuesto Q3')).toBe(true);
  });

  it('searches the description too', () => {
    expect(matches('factura', 'Llamar a Ana', 'pedirle la factura de agosto')).toBe(true);
  });

  it('every word must match, in any order', () => {
    expect(matches('ana llamar', 'Llamar a Ana')).toBe(true);
    expect(matches('llamar pedro', 'Llamar a Ana')).toBe(false);
  });

  it('one word may match the title and another the description', () => {
    expect(matches('ana agosto', 'Llamar a Ana', 'factura de agosto')).toBe(true);
  });

  it('forgives one typo in a word of 5+ letters', () => {
    expect(matches('presupesto', 'Revisar presupuesto')).toBe(true); // missing letter
    expect(matches('meetign', 'Weekly meeting')).toBe(true);        // swapped letters
    expect(matches('reunoin', 'Reunión con Ana')).toBe(true);       // swap + accent
    expect(matches('factuta', 'Enviar factura')).toBe(true);        // wrong letter
  });

  it('matches singular against plural', () => {
    expect(matches('notas', 'Pasar a limpio la nota')).toBe(true);
    expect(matches('nota', 'Pasar a limpio las notas')).toBe(true);
  });

  it('forgives two typos in a word of 9+ letters', () => {
    expect(matches('presupusto', 'presupuestos')).toBe(true);
    expect(matches('documentacoin', 'Revisar documentación')).toBe(true);
  });

  it('matches across punctuation', () => {
    expect(matches('email', 'Contestar e-mail de Luis')).toBe(true);
    expect(matches('e-mail', 'Contestar email de Luis')).toBe(true);
  });
});

describe('matchesListFilter — what it must NOT find (not lax)', () => {
  it('no subsequence matching: scattered letters are not a match', () => {
    // A fuzzy finder would match these: p…a…n spread across the words.
    expect(matches('pan', 'Preparar agenda nueva')).toBe(false);
    expect(matches('rvsr', 'Revisar presupuesto')).toBe(false);
  });

  it('short words (under 5 letters) must be exact', () => {
    expect(matches('casa', 'Llevar la cosa')).toBe(false);
    expect(matches('test', 'Write the text')).toBe(false);
    expect(matches('ana', 'Llamar a Ane')).toBe(false);
  });

  it('a word of 5–8 letters allows only one typo', () => {
    expect(matches('fectuta', 'Enviar factura')).toBe(false); // two letters off
  });

  it('the first letter must be right', () => {
    expect(matches('pasas', 'Comprar casas')).toBe(false);
    expect(matches('xeeting', 'Weekly meeting')).toBe(false);
  });

  it('typos are judged against whole words, not word starts', () => {
    // "salid" is one letter off the start of "salida", but not a word there.
    expect(matches('salud', 'Revisar la salida')).toBe(false);
  });

  it('numbers never fuzz', () => {
    expect(matches('2024', 'Impuestos 2025')).toBe(false);
    expect(matches('factura2024', 'factura2025')).toBe(false);
    expect(matches('2025', 'Impuestos 2025')).toBe(true);
  });

  it('a typo-tolerant word still has to be there: one wrong word fails the whole query', () => {
    expect(matches('presupuesto marketing', 'Revisar presupuesto de ventas')).toBe(false);
  });

  it('missing texts are tolerated (rows a past bug left without a title)', () => {
    expect(matches('ana', undefined, undefined)).toBe(false);
  });
});

describe('filterTasksByQuery', () => {
  const tasks = [
    { id: '1', title: 'Llamar a Ana', description: undefined },
    { id: '2', title: 'Revisar presupuesto', description: 'con Ana' },
    { id: '3', title: 'Comprar pan', description: undefined },
  ];

  it('keeps the matching tasks in their original order', () => {
    expect(filterTasksByQuery(tasks, 'ana').map((t) => t.id)).toEqual(['1', '2']);
  });

  it('returns the very same array for a blank query', () => {
    expect(filterTasksByQuery(tasks, '  ')).toBe(tasks);
  });
});

describe('saved searches', () => {
  it('sameSearch ignores case, accents and extra spaces', () => {
    expect(sameSearch('Reunión  Ana', ' reunion ana ')).toBe(true);
    expect(sameSearch('ana', 'anas')).toBe(false);
  });

  it('sanitize keeps trimmed strings only, without duplicates, capped', () => {
    expect(sanitizeSavedSearches([' a ', 'A', 'b', 3, null, '', '   ', { x: 1 }])).toEqual(['a', 'b']);
    expect(sanitizeSavedSearches(undefined)).toEqual([]);
    expect(sanitizeSavedSearches('not an array')).toEqual([]);
    const many = Array.from({ length: MAX_SAVED_SEARCHES + 5 }, (_, i) => `s${i}`);
    expect(sanitizeSavedSearches(many)).toHaveLength(MAX_SAVED_SEARCHES);
  });

  it('sanitize drops over-long entries (rows from sync or a backup are untrusted)', () => {
    expect(sanitizeSavedSearches(['x'.repeat(MAX_SAVED_SEARCH_LENGTH + 1), 'ok'])).toEqual(['ok']);
  });
});
