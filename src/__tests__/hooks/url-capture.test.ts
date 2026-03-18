import { formatCaptureResult } from '../../hooks/use-url-capture';

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
