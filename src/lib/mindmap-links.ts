import { isValidUrl } from './link-utils';
import { MAX_MINDMAP_LABEL_LENGTH } from './constants';

// Bare URLs typed or pasted into a mindmap node become real markdown links, with
// a readable label instead of the raw URL: the domain (minus `www.`) and the last
// path segment, capped. A node is a box on a canvas — a 200-character tracking
// URL makes the whole map unreadable, and the full URL is still there in the
// link target.
//
// Purely local: the page title is NOT fetched. That would need `connect-src`
// opened to the entire web (the app talks only to api.github.com and its own
// origin), it would leak the reader's IP and timing to every host a label
// mentions — including every URL inside an imported outline — and it would
// almost never work anyway, since reading a cross-origin HTML document requires
// that site to send `Access-Control-Allow-Origin`, which practically none do.

/** Longest display text for a linkified URL. */
export const MAX_URL_LABEL_LENGTH = 80;

// A bare http(s) URL. Backticks, angle brackets and quotes end it so a URL
// cannot swallow the markup around it.
const BARE_URL_RE = /https?:\/\/[^\s<>"'`]+/g;

// Regions of a label that already have meaning and must be left alone: an
// existing [text](href) link, and a `code span` (which suppresses inner parsing
// in mini-markdown). Kept in step with parseInline's own patterns.
const CLAIMED_RE = /\[[^\]]+\]\([^)\s]+\)|`[^`]*`/g;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Percent-decode a path segment for display, tolerating malformed input. */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Characters that would end the link text early (`]`) or break the label onto
 * another line, removed from what we render — the href keeps the real URL.
 */
function safeLinkText(text: string): string {
  return text
    .replace(/[[\]]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * `)` would close the markdown link early — mini-markdown's href group is
 * `[^)\s]+`. Percent-encoding it keeps the URL equivalent while staying inside
 * the syntax; whitespace can't occur, BARE_URL_RE stops at it.
 */
function safeHref(url: string): string {
  return url.replace(/\(/g, '%28').replace(/\)/g, '%29');
}

/**
 * Display text for a URL: `domain/last-path-segment`, capped at `max`. The
 * domain leads so it survives truncation — it is the part that tells you where
 * the link goes. Query and fragment are dropped from the text only.
 */
export function shortenUrl(raw: string, max = MAX_URL_LABEL_LENGTH): string {
  let text: string;
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./i, '');
    const segments = url.pathname.split('/').filter(Boolean);
    const last = segments.length > 0 ? safeDecode(segments[segments.length - 1]) : '';
    text = last ? `${host}/${last}` : host;
  } catch {
    text = raw; // not parseable as a URL: show it as-is, just shortened
  }
  return truncate(safeLinkText(text), max) || raw.slice(0, max);
}

/**
 * Trailing punctuation that belongs to the sentence, not the URL. A closing
 * paren is only sentence punctuation when the URL has no opening one — plenty of
 * real URLs end in `)`, Wikipedia's especially.
 */
function trimTrailingPunctuation(url: string): { url: string; trailing: string } {
  let end = url.length;
  for (; end > 0; end--) {
    const ch = url[end - 1];
    if ('.,;:!?'.includes(ch)) continue;
    if (ch === ')' && !url.slice(0, end).includes('(')) continue;
    break;
  }
  return { url: url.slice(0, end), trailing: url.slice(end) };
}

function linkifyPlain(text: string): string {
  return text.replace(BARE_URL_RE, (match) => {
    const { url, trailing } = trimTrailingPunctuation(match);
    if (!isValidUrl(url)) return match; // http(s) only — never a javascript: href
    return `[${shortenUrl(url)}](${safeHref(url)})${trailing}`;
  });
}

/**
 * Rewrite every bare URL in a node label as `[domain/page](url)`, leaving
 * existing links and code spans untouched. Returns the label unchanged when the
 * rewrite would push it past the node label cap — a truncated label could
 * otherwise end mid-link and render as broken markup.
 */
export function linkifyLabel(label: string): string {
  let out = '';
  let last = 0;
  CLAIMED_RE.lastIndex = 0;
  for (let claimed = CLAIMED_RE.exec(label); claimed; claimed = CLAIMED_RE.exec(label)) {
    out += linkifyPlain(label.slice(last, claimed.index)) + claimed[0];
    last = claimed.index + claimed[0].length;
  }
  out += linkifyPlain(label.slice(last));
  return out.length <= MAX_MINDMAP_LABEL_LENGTH ? out : label;
}
