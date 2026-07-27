import { linkifyLabel, shortenUrl, MAX_URL_LABEL_LENGTH } from '../../lib/mindmap-links';
import { parseInline } from '../../lib/mini-markdown';
import { MAX_MINDMAP_LABEL_LENGTH } from '../../lib/constants';

describe('shortenUrl', () => {
  it('shows the domain and the last path segment', () => {
    expect(shortenUrl('https://www.example.com/blog/2026/how-sleep-works')).toBe('example.com/how-sleep-works');
    expect(shortenUrl('https://example.com/blog/')).toBe('example.com/blog');
    expect(shortenUrl('https://example.com/')).toBe('example.com');
    expect(shortenUrl('https://example.com')).toBe('example.com');
  });

  it('drops the query and fragment from the text', () => {
    expect(shortenUrl('https://example.com/a/page.html?utm_source=x&y=2#section')).toBe('example.com/page.html');
  });

  it('decodes a percent-encoded segment', () => {
    expect(shortenUrl('https://es.wikipedia.org/wiki/Sue%C3%B1o_profundo')).toBe('es.wikipedia.org/Sueño_profundo');
  });

  it('caps at 80 characters, keeping the domain — that is what says where it goes', () => {
    const long = `https://example.com/${'x'.repeat(300)}`;
    const short = shortenUrl(long);
    expect(short).toHaveLength(MAX_URL_LABEL_LENGTH);
    expect(short.startsWith('example.com/')).toBe(true);
    expect(short.endsWith('…')).toBe(true);
    expect(MAX_URL_LABEL_LENGTH).toBe(80);
  });
});

describe('linkifyLabel', () => {
  it('turns a bare URL into a markdown link with the short text', () => {
    expect(linkifyLabel('https://www.example.com/a/page')).toBe('[example.com/page](https://www.example.com/a/page)');
  });

  it('keeps the surrounding text and the sentence punctuation', () => {
    expect(linkifyLabel('see https://example.com/a/page, then stop')).toBe(
      'see [example.com/page](https://example.com/a/page), then stop',
    );
    expect(linkifyLabel('(https://example.com/a/page)')).toBe('([example.com/page](https://example.com/a/page))');
  });

  it('keeps a closing paren that belongs to the URL', () => {
    const label = linkifyLabel('https://en.wikipedia.org/wiki/Sleep_(disambiguation)');
    // ")" is percent-encoded so it cannot close the markdown link early…
    expect(label).toBe('[en.wikipedia.org/Sleep_(disambiguation)](https://en.wikipedia.org/wiki/Sleep_%28disambiguation%29)');
    // …and the renderer reads the whole href back.
    const [token] = parseInline(label);
    expect(token).toMatchObject({ type: 'link', href: 'https://en.wikipedia.org/wiki/Sleep_%28disambiguation%29' });
  });

  it('leaves existing links and code spans alone', () => {
    const existing = '[my page](https://example.com/a/b)';
    expect(linkifyLabel(existing)).toBe(existing);
    expect(linkifyLabel('`https://example.com/raw`')).toBe('`https://example.com/raw`');
    expect(linkifyLabel(`${existing} and https://other.com/x`)).toBe(
      `${existing} and [other.com/x](https://other.com/x)`,
    );
  });

  it('handles several URLs and several lines', () => {
    expect(linkifyLabel('https://a.com/one\nhttps://b.com/two')).toBe(
      '[a.com/one](https://a.com/one)\n[b.com/two](https://b.com/two)',
    );
  });

  it('ignores anything that is not http(s)', () => {
    for (const raw of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'ftp://example.com/x']) {
      expect(linkifyLabel(raw)).toBe(raw);
    }
  });

  it('cannot be broken out of by a crafted URL', () => {
    // A URL carrying markdown syntax must not produce a second, attacker-chosen
    // link — the parser reads the href we emitted, nothing else.
    const label = linkifyLabel('https://evil.com/a]"(javascript:alert(1))');
    const tokens = parseInline(label);
    const links = tokens.filter((t) => t.type === 'link');
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ type: 'link' });
    if (links[0].type === 'link') expect(links[0].href.startsWith('https://evil.com/')).toBe(true);
    expect(label).not.toMatch(/\]\(javascript:/);
  });

  it('leaves the label untouched when linkifying would overflow the node cap', () => {
    const url = 'https://example.com/some/path/page';
    const filler = 'x'.repeat(MAX_MINDMAP_LABEL_LENGTH - url.length);
    const label = `${filler}${url}`;
    expect(linkifyLabel(label)).toBe(label); // rather than a label truncated mid-link
  });

  it('is idempotent — re-saving a node does not nest links', () => {
    const once = linkifyLabel('see https://example.com/a/page');
    expect(linkifyLabel(once)).toBe(once);
  });
});
