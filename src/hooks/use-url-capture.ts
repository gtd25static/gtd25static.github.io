import { useEffect } from 'react';
import { createTask } from './use-tasks';
import { getOrCreateInbox } from './use-task-lists';
import { toast } from '../components/ui/Toast';
import { MAX_TITLE_LENGTH, MAX_DESCRIPTION_LENGTH } from '../lib/constants';
import { extractUrl, isValidUrl } from '../lib/link-utils';

/**
 * Sanitize a capture param: trim, truncate (to a title's length unless the
 * caller has a bigger home for it). Markup is kept as literal text — titles are
 * only ever rendered as text, and stripping "tags" ate ordinary text such as
 * "a<b and c>d".
 */
export function sanitize(raw: string | null, maxLength = MAX_TITLE_LENGTH): string {
  if (!raw) return '';
  return raw.trim().slice(0, maxLength);
}

export interface CaptureResult {
  title: string;
  link?: string;
  linkTitle?: string;
  /** Text that came with the capture besides its title and link. */
  description?: string;
}

// How much of a capture too long for a title stays in it (the rest is in the description).
const CAPTURE_TITLE_PREVIEW = 120;

/**
 * Custom scheme registered by the manifest's protocol_handlers. Chrome only
 * captures in-scope links from real link clicks — never from `window.open`,
 * which is what a bookmarklet does — so an https URL cannot reliably reach the
 * installed app. A `web+gtd:` URL always launches it.
 *
 * Letters only after `web+`. HTML's registerProtocolHandler (which the manifest
 * member defers to) takes "web+" followed by one or more ASCII LOWER ALPHAS, so
 * the first attempt at this — `web+gtd25`, matching the app's name — was
 * silently rejected: "the scheme does not have a registered handler". Keep the
 * regex guard in the tests if you rename it.
 */
export const CAPTURE_PROTOCOL = 'web+gtd:';

/**
 * Read a `web+gtd:capture?title=…&url=…` payload. Chrome hands it to us
 * percent-encoded in `?protocol=`, so by the time URLSearchParams has decoded
 * the outer layer this is the raw protocol URL. Parsed by hand rather than with
 * `new URL()`: only the query matters, and a hostile page can put anything in
 * here — everything goes through the same sanitize() as the query flow.
 */
export function parseProtocolCapture(raw: string | null): CaptureResult | null {
  if (!raw || !raw.startsWith(CAPTURE_PROTOCOL)) return null;
  const query = raw.slice(raw.indexOf('?') + 1);
  if (!query || !raw.includes('?')) return null;
  const params = new URLSearchParams(query);
  const result = formatCaptureResult(
    sanitize(params.get('title')),
    sanitize(params.get('url')),
    sanitize(params.get('text')),
  );
  result.title = result.title.slice(0, MAX_TITLE_LENGTH);
  return result.title ? result : null;
}

/** Build a task title + link from capture params. */
export function formatCaptureResult(title: string, url: string, text: string): CaptureResult {
  // If we have a URL in the url param. Only http(s) becomes a link: every
  // capture entry point (share target, bookmarklet, protocol handler) can be
  // driven by a hostile page, and a `javascript:` value has no business being
  // stored as one — the render-time href sanitiser stays the second line of
  // defence, not the only one.
  // Text besides the title and link is kept as the description (it used to be dropped).
  if (url && isValidUrl(url)) {
    const result: CaptureResult = title
      ? { title, link: url, linkTitle: title }
      : { title: url, link: url };
    if (text && text !== url && text !== title) result.description = text;
    return result;
  }

  // Try extracting a URL from the text param (common on Android)
  const embeddedUrl = extractUrl(text);
  if (embeddedUrl) {
    const textWithoutUrl = text.replace(embeddedUrl, '').trim().replace(/\s+/g, ' ');
    const effectiveTitle = title || textWithoutUrl || embeddedUrl;
    const result: CaptureResult = { title: effectiveTitle, link: embeddedUrl };
    if (title && textWithoutUrl && textWithoutUrl !== title) result.description = textWithoutUrl;
    return result;
  }

  // Plain text capture
  if (title && text && title !== text) {
    return { title: `${title} — ${text}` };
  }
  return { title: title || text };
}

// A capture read from the address bar, waiting for the app to be up to file it.
let pendingCapture: CaptureResult | null = null;

/**
 * Take a capture from the address bar and scrub it at once (ACR-004). Triggers on:
 *   - /capture?title=...&url=...&text=... (Web Share Target on Android)
 *   - /?capture&title=...&url=... (bookmarklet, browser tab)
 *   - /?protocol=web%2Bgtd%3Acapture%3F... (bookmarklet, installed app —
 *     Chrome's protocol handler launch; see parseProtocolCapture)
 * main.tsx calls this before the first render: on a locked Paranoid device the
 * app shows the lock screen, and the captured page's title and URL used to sit
 * in the address bar until someone unlocked. useUrlCapture files it later.
 */
export function takeCaptureFromUrl(): void {
  const params = new URLSearchParams(window.location.search);
  const isShareTarget = window.location.pathname === '/capture';
  const isBookmarklet = params.has('capture');
  const isProtocol = params.has('protocol');
  if (!isShareTarget && !isBookmarklet && !isProtocol) return;

  // The sanitized values are read into locals before the scrub.
  const protocolResult = isProtocol ? parseProtocolCapture(params.get('protocol')) : null;
  const title = sanitize(params.get('title'));
  const url = sanitize(params.get('url'));
  const text = sanitize(params.get('text'));
  cleanUrl();

  // A protocol launch carries everything inside its own URL.
  if (isProtocol) {
    pendingCapture = protocolResult;
    return;
  }
  if (!title && !url && !text) return;
  const result = formatCaptureResult(title, url, text);
  result.title = result.title.slice(0, MAX_TITLE_LENGTH);
  if (result.title) pendingCapture = result;
}

/** Files the capture taken from the address bar (see takeCaptureFromUrl) into the Inbox, once. */
export function useUrlCapture() {
  useEffect(() => {
    takeCaptureFromUrl(); // already done by main.tsx in the app; a no-op then
    const capture = pendingCapture;
    pendingCapture = null;
    if (capture) void captureToInbox(capture);
  }, []);
}

/**
 * Create an Inbox task from a capture result. `link`/`linkTitle` are passed straight
 * through to createTask so the task renders the URL as a clickable link (sanitized +
 * rel="noopener noreferrer" by the task UI). Reused by the share-target flow.
 */
export async function captureToInbox({ title, link, linkTitle, description }: CaptureResult) {
  // Too long for a title (a shared note): a short title, and all of it in the
  // description — everything past 500 characters used to be lost.
  if (title.length > MAX_TITLE_LENGTH) {
    description = description ? `${title}\n\n${description}` : title;
    const firstLine = title.split('\n', 1)[0].trim();
    title = firstLine.length > CAPTURE_TITLE_PREVIEW ? `${firstLine.slice(0, CAPTURE_TITLE_PREVIEW - 1)}…` : firstLine;
  }
  if (description && description.length > MAX_DESCRIPTION_LENGTH) {
    description = description.slice(0, MAX_DESCRIPTION_LENGTH);
    toast(`The text was cut to a task's ${MAX_DESCRIPTION_LENGTH} characters — share it to the Shared Folder to keep all of it.`, 'error');
  }
  const inboxId = await getOrCreateInbox();
  const task = await createTask(inboxId, { title, link, linkTitle, ...(description ? { description } : {}) });
  if (task) {
    toast('Captured to Inbox', 'success');
  }
}

function cleanUrl() {
  window.history.replaceState(null, '', '/');
}
