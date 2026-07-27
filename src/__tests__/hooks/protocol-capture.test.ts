import { CAPTURE_PROTOCOL, parseProtocolCapture } from '../../hooks/use-url-capture';
import { MAX_TITLE_LENGTH } from '../../lib/constants';

// The payload of a `web+gtd:` launch, as it reaches the app: Chrome
// percent-encodes the whole protocol URL into ?protocol=…, and URLSearchParams
// has already undone that one layer by the time this parser sees it.
function launched(title: string, url: string): string {
  return `${CAPTURE_PROTOCOL}capture?title=${encodeURIComponent(title)}&url=${encodeURIComponent(url)}`;
}

describe('CAPTURE_PROTOCOL', () => {
  it('is a scheme the HTML spec actually allows to be registered', () => {
    // "web+" followed by one or more ASCII LOWER ALPHAS — no digits. The first
    // version of this was `web+gtd25:`, which Chrome refused to register at all
    // ("the scheme does not have a registered handler") with no build-time error.
    expect(CAPTURE_PROTOCOL).toMatch(/^web\+[a-z]+:$/);
  });
});

describe('parseProtocolCapture', () => {
  it('reads the title and URL of the captured page', () => {
    expect(parseProtocolCapture(launched('My Page', 'https://example.com/a?b=c'))).toEqual({
      title: 'My Page',
      link: 'https://example.com/a?b=c',
      linkTitle: 'My Page',
    });
  });

  it('survives the round trip a real launch does to the payload', () => {
    const raw = launched('Título & “quotes” 50%', 'https://ex.com/p?q=a+b&r=1');
    // What Chrome substitutes for %s, then what URLSearchParams hands back.
    const encoded = `/?protocol=${encodeURIComponent(raw)}`;
    const decoded = new URLSearchParams(encoded.slice(2)).get('protocol');
    expect(parseProtocolCapture(decoded)).toEqual({
      title: 'Título & “quotes” 50%',
      link: 'https://ex.com/p?q=a+b&r=1',
      linkTitle: 'Título & “quotes” 50%',
    });
  });

  it('falls back to a plain text capture when there is no URL', () => {
    expect(parseProtocolCapture(`${CAPTURE_PROTOCOL}capture?text=just%20a%20note`)).toEqual({
      title: 'just a note',
    });
  });

  it('rejects anything that is not our scheme, or carries no query', () => {
    expect(parseProtocolCapture(null)).toBeNull();
    expect(parseProtocolCapture('')).toBeNull();
    expect(parseProtocolCapture('https://evil.example/?title=x')).toBeNull();
    expect(parseProtocolCapture('web+other:capture?title=x')).toBeNull();
    expect(parseProtocolCapture(`${CAPTURE_PROTOCOL}capture`)).toBeNull();
    expect(parseProtocolCapture(`${CAPTURE_PROTOCOL}capture?`)).toBeNull();
    expect(parseProtocolCapture(`${CAPTURE_PROTOCOL}capture?title=`)).toBeNull();
  });

  it('sanitises a hostile payload exactly like the query flow', () => {
    // Any page can invoke the handler, so treat the payload as attacker input.
    const injected = parseProtocolCapture(
      `${CAPTURE_PROTOCOL}capture?title=${encodeURIComponent('<img src=x onerror=alert(1)>Hi')}`,
    );
    expect(injected?.title).toBe('Hi');

    const long = parseProtocolCapture(
      `${CAPTURE_PROTOCOL}capture?title=${'x'.repeat(MAX_TITLE_LENGTH + 500)}`,
    );
    expect(long?.title).toHaveLength(MAX_TITLE_LENGTH);
  });

  it('never stores a non-http(s) URL as the task link', () => {
    for (const hostile of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd']) {
      const parsed = parseProtocolCapture(
        `${CAPTURE_PROTOCOL}capture?title=Click&url=${encodeURIComponent(hostile)}`,
      );
      expect(parsed?.link, hostile).toBeUndefined();
      expect(parsed?.title).toBe('Click'); // the capture still lands, just without a link
    }
  });
});
