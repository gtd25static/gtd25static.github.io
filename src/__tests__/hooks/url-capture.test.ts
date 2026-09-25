import { formatCaptureResult, sanitize } from '../../hooks/use-url-capture';

describe('formatCaptureResult', () => {
  it('returns title + link when url param and title provided', () => {
    expect(formatCaptureResult('My Page', 'https://example.com', '')).toEqual({
      title: 'My Page',
      link: 'https://example.com',
      linkTitle: 'My Page',
    });
  });

  it('returns url as title+link when no title', () => {
    expect(formatCaptureResult('', 'https://example.com', '')).toEqual({
      title: 'https://example.com',
      link: 'https://example.com',
    });
  });

  it('extracts URL from text into link field', () => {
    expect(formatCaptureResult('', '', 'Check this https://example.com/page')).toEqual({
      title: 'Check this',
      link: 'https://example.com/page',
    });
  });

  it('uses title with embedded URL from text', () => {
    expect(formatCaptureResult('My Title', '', 'https://example.com')).toEqual({
      title: 'My Title',
      link: 'https://example.com',
    });
  });

  it('returns plain text when no URLs anywhere', () => {
    expect(formatCaptureResult('', '', 'Just a note')).toEqual({
      title: 'Just a note',
    });
  });

  it('combines title and text when different and no URL', () => {
    expect(formatCaptureResult('Title', '', 'Some description')).toEqual({
      title: 'Title — Some description',
    });
  });

  it('deduplicates when title equals text', () => {
    expect(formatCaptureResult('Same', '', 'Same')).toEqual({
      title: 'Same',
    });
  });

  it('returns empty title when all empty', () => {
    expect(formatCaptureResult('', '', '')).toEqual({
      title: '',
    });
  });

  it('handles text that is only a URL with no surrounding text', () => {
    expect(formatCaptureResult('', '', 'https://example.com')).toEqual({
      title: 'https://example.com',
      link: 'https://example.com',
    });
  });

  it('ignores a url param that is not http(s), rather than storing it as a link', () => {
    expect(formatCaptureResult('Page', 'javascript:alert(1)', '')).toEqual({ title: 'Page' });
    // …and still finds a real link in the text alongside it.
    expect(formatCaptureResult('', 'data:text/html,x', 'see https://example.com')).toEqual({
      title: 'see',
      link: 'https://example.com',
    });
  });

  it('prefers url param over embedded URL in text', () => {
    expect(
      formatCaptureResult('Page', 'https://main.com', 'text https://other.com'),
    ).toEqual({
      title: 'Page',
      link: 'https://main.com',
      linkTitle: 'Page',
    });
  });
});

// Titles are shown as text everywhere (no HTML sink), so dropping everything
// between "<" and ">" only mangled what was captured.
describe('sanitize', () => {
  it('keeps angle brackets and what sits between them', () => {
    expect(sanitize('a<b and c>d')).toBe('a<b and c>d');
    expect(sanitize('if x < 3 and y > 4')).toBe('if x < 3 and y > 4');
    expect(sanitize('Read <b>this</b>')).toBe('Read <b>this</b>');
  });

  it('still trims, and treats a missing value as empty', () => {
    expect(sanitize('  padded  ')).toBe('padded');
    expect(sanitize(null)).toBe('');
  });
});
