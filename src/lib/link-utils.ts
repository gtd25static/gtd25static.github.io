export function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}


export function isValidUrl(str: string): boolean {
  try {
    const url = new URL(str);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Ensure a URL uses a safe protocol. Returns '#' for dangerous schemes like javascript:. */
export function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return url;
  } catch { /* invalid URL */ }
  return '#';
}

/** Extract the first URL from a text blob. */
export function extractUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"']+/);
  return match ? match[0] : null;
}

// A bare http(s) URL. Backticks, angle brackets and quotes end it so a URL
// cannot swallow the markup around it.
export const BARE_URL_RE = /https?:\/\/[^\s<>"'`]+/g;

/**
 * Trailing punctuation that belongs to the sentence, not the URL. A closing
 * paren is only sentence punctuation when the URL has no opening one — plenty of
 * real URLs end in `)`, Wikipedia's especially.
 */
export function trimTrailingPunctuation(url: string): { url: string; trailing: string } {
  let end = url.length;
  for (; end > 0; end--) {
    const ch = url[end - 1];
    if ('.,;:!?'.includes(ch)) continue;
    if (ch === ')' && !url.slice(0, end).includes('(')) continue;
    break;
  }
  return { url: url.slice(0, end), trailing: url.slice(end) };
}

export type TextPart = { text: string } | { url: string };

/** Plain text split into its runs of text and the http(s) URLs in it, in order. */
export function splitBareUrls(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let pending = '';
  let last = 0;
  for (const match of text.matchAll(BARE_URL_RE)) {
    const { url, trailing } = trimTrailingPunctuation(match[0]);
    pending += text.slice(last, match.index);
    last = match.index + match[0].length;
    if (!isValidUrl(url)) { pending += match[0]; continue; } // http(s) only — never a javascript: href
    if (pending) parts.push({ text: pending });
    parts.push({ url });
    pending = trailing;
  }
  pending += text.slice(last);
  if (pending) parts.push({ text: pending });
  return parts;
}
