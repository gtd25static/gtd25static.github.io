import { newId } from '../../lib/id';

describe('newId', () => {
  it('returns a string', () => {
    expect(typeof newId()).toBe('string');
  });

  it('returns a 12-character string', () => {
    expect(newId()).toHaveLength(12);
  });

  it('returns unique values on successive calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newId()));
    expect(ids.size).toBe(100);
  });
});
