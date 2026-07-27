import { useEffect, useRef } from 'react';
import { createTask } from './use-tasks';
import { getOrCreateInbox } from './use-task-lists';
import { toast } from '../components/ui/Toast';
import { MAX_TITLE_LENGTH } from '../lib/constants';
import { extractUrl, isValidUrl } from '../lib/link-utils';

/** Strip HTML tags from a string. */
function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, '');
}

/** Sanitize a capture param: strip HTML, trim, truncate. */
export function sanitize(raw: string | null): string {
  if (!raw) return '';
  return stripHtml(raw).trim().slice(0, MAX_TITLE_LENGTH);
}

export interface CaptureResult {
  title: string;
  link?: string;
  linkTitle?: string;
}

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
  if (url && isValidUrl(url)) {
    return title
      ? { title, link: url, linkTitle: title }
      : { title: url, link: url };
  }

  // Try extracting a URL from the text param (common on Android)
  const embeddedUrl = extractUrl(text);
  if (embeddedUrl) {
    const textWithoutUrl = text.replace(embeddedUrl, '').trim().replace(/\s+/g, ' ');
    const effectiveTitle = title || textWithoutUrl || embeddedUrl;
    return { title: effectiveTitle, link: embeddedUrl };
  }

  // Plain text capture
  if (title && text && title !== text) {
    return { title: `${title} — ${text}` };
  }
  return { title: title || text };
}

/**
 * Hook that checks for capture params on mount and creates an inbox task.
 * Triggers on:
 *   - /capture?title=...&url=...&text=... (Web Share Target on Android)
 *   - /?capture&title=...&url=... (bookmarklet, browser tab)
 *   - /?protocol=web%2Bgtd%3Acapture%3F... (bookmarklet, installed app —
 *     Chrome's protocol handler launch; see parseProtocolCapture)
 */
export function useUrlCapture() {
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;

    const params = new URLSearchParams(window.location.search);
    const isShareTarget = window.location.pathname === '/capture';
    const isBookmarklet = params.has('capture');
    const isProtocol = params.has('protocol');

    if (!isShareTarget && !isBookmarklet && !isProtocol) return;

    handled.current = true;

    const protocolResult = isProtocol ? parseProtocolCapture(params.get('protocol')) : null;
    const title = sanitize(params.get('title'));
    const url = sanitize(params.get('url'));
    const text = sanitize(params.get('text'));

    // Clear the share-target query string from the address bar/history IMMEDIATELY,
    // before any async work, so the shared content (which the GET share target puts in
    // the URL) lingers for the shortest possible window (ACR-004). The sanitized values
    // are already captured in locals above.
    cleanUrl();

    // A protocol launch carries everything inside its own URL.
    if (isProtocol) {
      if (protocolResult) captureToInbox(protocolResult);
      return;
    }

    // Skip if all params are empty
    if (!title && !url && !text) return;

    const result = formatCaptureResult(title, url, text);
    result.title = result.title.slice(0, MAX_TITLE_LENGTH);
    if (!result.title) return;

    captureToInbox(result);
  }, []);
}

/**
 * Create an Inbox task from a capture result. `link`/`linkTitle` are passed straight
 * through to createTask so the task renders the URL as a clickable link (sanitized +
 * rel="noopener noreferrer" by the task UI). Reused by the share-target flow.
 */
export async function captureToInbox({ title, link, linkTitle }: CaptureResult) {
  const inboxId = await getOrCreateInbox();
  const task = await createTask(inboxId, { title, link, linkTitle });
  if (task) {
    toast('Captured to Inbox', 'success');
  }
}

function cleanUrl() {
  window.history.replaceState(null, '', '/');
}
