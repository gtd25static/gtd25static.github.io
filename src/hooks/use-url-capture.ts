import { useEffect, useRef } from 'react';
import { createTask } from './use-tasks';
import { getOrCreateInbox } from './use-task-lists';
import { toast } from '../components/ui/Toast';
import { MAX_TITLE_LENGTH } from '../lib/constants';
import { extractUrl } from '../lib/link-utils';

/** Strip HTML tags from a string. */
function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, '');
}

/** Sanitize a capture param: strip HTML, trim, truncate. */
function sanitize(raw: string | null): string {
  if (!raw) return '';
  return stripHtml(raw).trim().slice(0, MAX_TITLE_LENGTH);
}

export interface CaptureResult {
  title: string;
  link?: string;
  linkTitle?: string;
}

/** Build a task title + link from capture params. */
export function formatCaptureResult(title: string, url: string, text: string): CaptureResult {
  // If we have a URL in the url param
  if (url) {
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
 *   - /?capture&title=...&url=... (bookmarklet)
 */
export function useUrlCapture() {
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;

    const params = new URLSearchParams(window.location.search);
    const isShareTarget = window.location.pathname === '/capture';
    const isBookmarklet = params.has('capture');

    if (!isShareTarget && !isBookmarklet) return;

    handled.current = true;

    const title = sanitize(params.get('title'));
    const url = sanitize(params.get('url'));
    const text = sanitize(params.get('text'));

    // Skip if all params are empty
    if (!title && !url && !text) {
      cleanUrl();
      return;
    }

    const result = formatCaptureResult(title, url, text);
    result.title = result.title.slice(0, MAX_TITLE_LENGTH);
    if (!result.title) {
      cleanUrl();
      return;
    }

    captureToInbox(result);
    cleanUrl();
  }, []);
}

async function captureToInbox({ title, link, linkTitle }: CaptureResult) {
  const inboxId = await getOrCreateInbox();
  const task = await createTask(inboxId, { title, link, linkTitle });
  if (task) {
    toast('Captured to Inbox', 'success');
  }
}

function cleanUrl() {
  window.history.replaceState(null, '', '/');
}
