import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { createTask } from './use-tasks';
import { getOrCreateInbox } from './use-task-lists';
import { toast } from '../components/ui/Toast';
import { MAX_TITLE_LENGTH, MAX_DESCRIPTION_LENGTH } from '../lib/constants';
import { extractUrl, isValidUrl } from '../lib/link-utils';
import { isParanoidEnabled, isUnlocked, lockIfIdleExpired } from '../db/vault';
import {
  holdCapture, takeCapturesToFile, capturesToConfirm, releaseCapture,
  subscribeHeldCaptures, heldCapturesVersion,
} from '../lib/held-captures';

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

/**
 * Whether a URL of this app is a capture link:
 *   - /capture?title=...&url=...&text=... (Web Share Target on Android)
 *   - /?capture&title=...&url=... (bookmarklet, browser tab)
 *   - /?protocol=web%2Bgtd%3Acapture%3F... (bookmarklet, installed app —
 *     Chrome's protocol handler launch; see parseProtocolCapture)
 */
function isCaptureUrl(url: URL): boolean {
  return url.pathname === '/capture' || url.searchParams.has('capture') || url.searchParams.has('protocol');
}

/** The capture a capture link carries, sanitised — or null when nothing usable is in it. */
function captureFromUrl(url: URL): CaptureResult | null {
  const params = url.searchParams;
  // A protocol launch carries everything inside its own URL.
  if (params.has('protocol')) return parseProtocolCapture(params.get('protocol'));
  const title = sanitize(params.get('title'));
  const link = sanitize(params.get('url'));
  const text = sanitize(params.get('text'));
  if (!title && !link && !text) return null;
  const result = formatCaptureResult(title, link, text);
  result.title = result.title.slice(0, MAX_TITLE_LENGTH);
  return result.title ? result : null;
}

// Set while the unlocked app is mounted (useUrlCapture): a capture that reaches
// an open window is filed at once; otherwise it is held (lib/held-captures).
let mounted = false;
// The capture this window was opened with. The launch queue hands that same
// launch over again, and it was already taken from the address bar.
let bootCapture: string | null = null;
// One capture at a time: filed together, each could create the Inbox.
let filing: Promise<void> = Promise.resolve();

function fileCapture(capture: CaptureResult): void {
  filing = filing.then(async () => {
    let filed = false;
    try { filed = await captureToInbox(capture); } catch { /* not filed: handled below */ }
    // The vault locked under it (writes fail closed while locked): keep it for the next unlock.
    if (!filed && isParanoidEnabled() && !isUnlocked()) holdCapture(capture);
  });
}

/**
 * Take a capture from the address bar and scrub it at once (ACR-004).
 * main.tsx calls this before the first render: on a locked Paranoid device the
 * app shows the lock screen, and the captured page's title and URL used to sit
 * in the address bar until someone unlocked. useUrlCapture files it later.
 */
export function takeCaptureFromUrl(): void {
  const url = new URL(window.location.href);
  if (!isCaptureUrl(url)) return;
  // Read (and sanitised) before the scrub.
  const capture = captureFromUrl(url);
  cleanUrl();
  if (!capture) return;
  bootCapture = JSON.stringify(capture);
  holdCapture(capture, isParanoidEnabled());
}

/**
 * Captures launched at an app window that is ALREADY OPEN. The manifest's
 * launch_handler (focus-existing) brings that window forward and hands the
 * launch URL to window.launchQueue, where a new window — which in Paranoid Mode
 * starts locked, however unlocked this one is — used to open. Nothing touches
 * the address bar here. Filed at once while unlocked, otherwise held for the
 * unlock — in Paranoid Mode always held, to ask first (useCaptureConfirm).
 * A window opened BY a launch gets that launch queued first; it was
 * already taken from the address bar, so it is skipped. main.tsx calls this.
 */
export function listenForLaunches(): void {
  const queue = (window as Window & { launchQueue?: LaunchQueue }).launchQueue;
  queue?.setConsumer(({ targetURL }) => {
    const boot = bootCapture;
    bootCapture = null;
    let url: URL;
    try { url = new URL(targetURL ?? ''); } catch { return; }
    if (url.origin !== window.location.origin || !isCaptureUrl(url)) return;
    const capture = captureFromUrl(url);
    if (!capture || JSON.stringify(capture) === boot) return;
    if (isParanoidEnabled()) {
      // Brought forward after its idle time ran out — before the focus check
      // has locked it: lock first, so the question waits for the unlock.
      lockIfIdleExpired();
      holdCapture(capture, true);
    } else if (mounted) {
      fileCapture(capture);
    } else {
      holdCapture(capture);
    }
  });
}

interface LaunchQueue {
  setConsumer(consumer: (params: { targetURL?: string }) => void): void;
}

/** Files held captures into the Inbox, and later ones as they arrive, while mounted (unlocked). */
export function useUrlCapture() {
  useEffect(() => {
    takeCaptureFromUrl(); // already done by main.tsx in the app; a no-op then
    for (const capture of takeCapturesToFile()) fileCapture(capture);
    mounted = true;
    return () => { mounted = false; };
  }, []);
}

/**
 * In Paranoid Mode every capture asks before it is filed (CaptureConfirmPrompt):
 * any page whose link you click can send one — Chrome hands a plain https link
 * to the app window without a prompt — and with the app window open and
 * unlocked there is no unlock in between any more to stop it. The question,
 * oldest first; `count` is how many are waiting.
 */
export function useCaptureConfirm() {
  useSyncExternalStore(subscribeHeldCaptures, heldCapturesVersion);
  const waiting = capturesToConfirm();
  const current = waiting[0] ?? null;
  const id = current?.id;
  const add = useCallback(() => {
    const capture = id === undefined ? null : releaseCapture(id);
    if (capture) fileCapture(capture);
  }, [id]);
  const discard = useCallback(() => {
    if (id !== undefined) releaseCapture(id);
  }, [id]);
  return { capture: current?.capture ?? null, count: waiting.length, add, discard };
}

/**
 * Create an Inbox task from a capture result. `link`/`linkTitle` are passed straight
 * through to createTask so the task renders the URL as a clickable link (sanitized +
 * rel="noopener noreferrer" by the task UI). Reused by the share-target flow.
 * Resolves to whether the task was created.
 */
export async function captureToInbox({ title, link, linkTitle, description }: CaptureResult): Promise<boolean> {
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
  return !!task;
}

function cleanUrl() {
  window.history.replaceState(null, '', '/');
}
