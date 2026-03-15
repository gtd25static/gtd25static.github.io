import { useEffect, useRef } from 'react';
import { createTask } from './use-tasks';
import { getOrCreateInbox } from './use-task-lists';
import { toast } from '../components/ui/Toast';
import { MAX_TITLE_LENGTH } from '../lib/constants';

/** Strip HTML tags from a string. */
function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, '');
}

/** Sanitize a capture param: strip HTML, trim, truncate. */
function sanitize(raw: string | null): string {
  if (!raw) return '';
  return stripHtml(raw).trim().slice(0, MAX_TITLE_LENGTH);
}

/** Extract the first URL from a text blob (Android often puts URLs in the text param). */
function extractUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"']+/);
  return match ? match[0] : null;
}

/** Build a task title from capture params. */
export function formatCaptureTitle(title: string, url: string, text: string): string {
  // If we have a URL in the url param, use title — url
  if (url) {
    return title ? `${title} — ${url}` : url;
  }

  // Try extracting a URL from the text param (common on Android)
  const embeddedUrl = extractUrl(text);
  if (embeddedUrl) {
    // Text might be "Check this out https://example.com" — use the non-URL part as title
    const textWithoutUrl = text.replace(embeddedUrl, '').trim().replace(/\s+/g, ' ');
    const effectiveTitle = title || textWithoutUrl;
    return effectiveTitle ? `${effectiveTitle} — ${embeddedUrl}` : embeddedUrl;
  }

  // Plain text capture
  if (title && text && title !== text) {
    return `${title} — ${text}`;
  }
  return title || text;
}

/**
 * Hook that checks for `?capture` query params on mount and creates an inbox task.
 * Used by Web Share Target and bookmarklet flows.
 */
export function useUrlCapture() {
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;

    const params = new URLSearchParams(window.location.search);
    if (!params.has('capture')) return;

    handled.current = true;

    const title = sanitize(params.get('title'));
    const url = sanitize(params.get('url'));
    const text = sanitize(params.get('text'));

    // Skip if all params are empty
    if (!title && !url && !text) {
      cleanUrl();
      return;
    }

    const taskTitle = formatCaptureTitle(title, url, text).slice(0, MAX_TITLE_LENGTH);
    if (!taskTitle) {
      cleanUrl();
      return;
    }

    captureToInbox(taskTitle);
    cleanUrl();
  }, []);
}

async function captureToInbox(title: string) {
  const inboxId = await getOrCreateInbox();
  const task = await createTask(inboxId, { title });
  if (task) {
    toast('Captured to Inbox', 'success');
  }
}

function cleanUrl() {
  const url = new URL(window.location.href);
  url.search = '';
  window.history.replaceState(null, '', url.pathname);
}
