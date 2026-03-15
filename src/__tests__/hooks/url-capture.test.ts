import { formatCaptureTitle } from '../../hooks/use-url-capture';

describe('formatCaptureTitle', () => {
  it('returns title — url when both provided', () => {
    expect(formatCaptureTitle('My Page', 'https://example.com', '')).toBe(
      'My Page — https://example.com',
    );
  });

  it('returns just the url when no title', () => {
    expect(formatCaptureTitle('', 'https://example.com', '')).toBe('https://example.com');
  });

  it('extracts URL from text when url param is empty', () => {
    expect(formatCaptureTitle('', '', 'Check this https://example.com/page')).toBe(
      'Check this — https://example.com/page',
    );
  });

  it('uses title with embedded URL from text', () => {
    expect(formatCaptureTitle('My Title', '', 'https://example.com')).toBe(
      'My Title — https://example.com',
    );
  });

  it('returns plain text when no URLs anywhere', () => {
    expect(formatCaptureTitle('', '', 'Just a note')).toBe('Just a note');
  });

  it('combines title and text when different and no URL', () => {
    expect(formatCaptureTitle('Title', '', 'Some description')).toBe(
      'Title — Some description',
    );
  });

  it('deduplicates when title equals text', () => {
    expect(formatCaptureTitle('Same', '', 'Same')).toBe('Same');
  });

  it('returns empty string when all empty', () => {
    expect(formatCaptureTitle('', '', '')).toBe('');
  });

  it('handles text that is only a URL with no surrounding text', () => {
    expect(formatCaptureTitle('', '', 'https://example.com')).toBe('https://example.com');
  });

  it('prefers url param over embedded URL in text', () => {
    expect(
      formatCaptureTitle('Page', 'https://main.com', 'text https://other.com'),
    ).toBe('Page — https://main.com');
  });
});
