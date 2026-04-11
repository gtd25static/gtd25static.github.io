import { extractHostname, isValidUrl, extractUrl, sanitizeUrl } from '../../lib/link-utils';

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

describe('sanitizeUrl', () => {
  it('allows http URLs', () => {
    expect(sanitizeUrl('http://example.com')).toBe('http://example.com');
  });

  it('allows https URLs', () => {
    expect(sanitizeUrl('https://example.com/path?q=1')).toBe('https://example.com/path?q=1');
  });

  it('blocks javascript: URLs', () => {
    expect(sanitizeUrl('javascript:alert(1)')).toBe('#');
  });

  it('blocks data: URLs', () => {
    expect(sanitizeUrl('data:text/html,<script>alert(1)</script>')).toBe('#');
  });

  it('blocks ftp: URLs', () => {
    expect(sanitizeUrl('ftp://example.com')).toBe('#');
  });

  it('returns # for invalid strings', () => {
    expect(sanitizeUrl('not a url')).toBe('#');
  });

  it('returns # for empty string', () => {
    expect(sanitizeUrl('')).toBe('#');
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
