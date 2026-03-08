import { extractHostname, isValidUrl } from '../../lib/link-utils';

describe('extractHostname', () => {
  it('extracts hostname from a valid URL', () => {
    expect(extractHostname('https://www.example.com/path')).toBe('www.example.com');
  });

  it('returns raw input for invalid URL', () => {
    expect(extractHostname('not a url')).toBe('not a url');
  });

  it('handles URLs with ports', () => {
    expect(extractHostname('http://localhost:3000/api')).toBe('localhost');
  });
});

describe('isValidUrl', () => {
  it('accepts http URLs', () => {
    expect(isValidUrl('http://example.com')).toBe(true);
  });

  it('accepts https URLs', () => {
    expect(isValidUrl('https://example.com')).toBe(true);
  });

  it('rejects ftp URLs', () => {
    expect(isValidUrl('ftp://example.com')).toBe(false);
  });

  it('rejects non-URL strings', () => {
    expect(isValidUrl('hello world')).toBe(false);
  });
});
