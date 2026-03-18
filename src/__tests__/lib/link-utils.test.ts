import { extractHostname, isValidUrl, extractUrl } from '../../lib/link-utils';

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

describe('extractUrl', () => {
  it('extracts https URL from text', () => {
    expect(extractUrl('Check https://example.com/page')).toBe('https://example.com/page');
  });

  it('extracts http URL from text', () => {
    expect(extractUrl('Visit http://example.com')).toBe('http://example.com');
  });

  it('returns first URL when multiple present', () => {
    expect(extractUrl('https://first.com and https://second.com')).toBe('https://first.com');
  });

  it('returns null when no URL present', () => {
    expect(extractUrl('Just plain text')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractUrl('')).toBeNull();
  });

  it('extracts URL with path and query params', () => {
    expect(extractUrl('See https://example.com/path?q=1&r=2')).toBe('https://example.com/path?q=1&r=2');
  });
});
