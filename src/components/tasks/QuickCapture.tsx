import { useState, useEffect, useRef } from 'react';
import { useAppState } from '../../stores/app-state';
import { createTask } from '../../hooks/use-tasks';
import { getOrCreateInbox } from '../../hooks/use-task-lists';
import { toast } from '../ui/Toast';
import { MAX_TITLE_LENGTH } from '../../lib/constants';
import { extractUrl } from '../../lib/link-utils';

export function QuickCapture() {
  const open = useAppState((s) => s.quickCaptureOpen);
  const setOpen = useAppState((s) => s.setQuickCaptureOpen);
  const [title, setTitle] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTitle('');
      // Focus after render
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  if (!open) return null;

  async function handlePaste() {
    try {
      const text = await navigator.clipboard.readText();
      const trimmed = text.trim().slice(0, MAX_TITLE_LENGTH);
      if (trimmed) {
        setTitle(trimmed);
        inputRef.current?.focus();
      }
    } catch {
      toast('Clipboard access denied', 'error');
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;

    const inboxId = await getOrCreateInbox();
    const url = extractUrl(trimmed);
    if (url) {
      const titleWithoutUrl = trimmed.replace(url, '').trim().replace(/\s+/g, ' ');
      const task = await createTask(inboxId, {
        title: titleWithoutUrl || url,
        link: url,
        ...(titleWithoutUrl ? { linkTitle: titleWithoutUrl } : {}),
      });
      if (task) toast('Captured to Inbox', 'success');
    } else {
      const task = await createTask(inboxId, { title: trimmed });
      if (task) toast('Captured to Inbox', 'success');
    }
    setTitle('');
    // Stay open for the next item
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[90] bg-black/50 backdrop-blur-sm"
        onClick={() => setOpen(false)}
      />
      {/* Floating input */}
      <div className="fixed left-1/2 top-1/4 z-[91] w-full max-w-lg -translate-x-1/2 px-4">
        <form onSubmit={handleSubmit} className="flex items-center gap-2 rounded-xl border border-zinc-300 bg-white p-2 shadow-2xl dark:border-zinc-600 dark:bg-zinc-800">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0 ml-1 text-accent-500">
            <path d="M10 4v12M4 10h12" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={title}
            onChange={(e) => setTitle(e.target.value.slice(0, MAX_TITLE_LENGTH))}
            maxLength={MAX_TITLE_LENGTH}
            placeholder="Quick capture to Inbox..."
            className="flex-1 bg-transparent text-base md:text-sm text-zinc-900 placeholder:text-zinc-400 outline-none dark:text-zinc-100 dark:placeholder:text-zinc-500"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setOpen(false);
              }
            }}
          />
          <button
            type="button"
            onClick={handlePaste}
            title="Paste from clipboard"
            className="rounded-lg p-1.5 text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="5" y="2" width="6" height="3" rx="0.5" />
              <path d="M5 3.5H3.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H11" />
            </svg>
          </button>
          <button
            type="submit"
            disabled={!title.trim()}
            className="rounded-lg bg-accent-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Capture
          </button>
        </form>
        <p className="mt-2 text-center text-xs text-zinc-400 dark:text-zinc-500">
          Enter to save &amp; continue, Esc to close
        </p>
      </div>
    </>
  );
}
