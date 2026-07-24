// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '../setup-component';
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';
import {
  SHARE_META_PATH, shareFilePath, SHARE_STASH_TTL_MS,
  MAX_SHARE_FILES, MAX_SHARE_FILE_BYTES, MAX_SHARE_TOTAL_BYTES, selectFilesToStash,
  type SharedPayloadMeta,
} from '../../lib/share-target';
import { useAppState } from '../../stores/app-state';
import { toast } from '../../components/ui/Toast';

const createFileItem = vi.fn().mockResolvedValue({ id: 'f1' });
const createLinkItem = vi.fn().mockResolvedValue({ id: 'l1' });
const createSnippetItem = vi.fn().mockResolvedValue({ id: 's1' });
const captureToInbox = vi.fn().mockResolvedValue(undefined);
const createTask = vi.fn().mockResolvedValue({ id: 't1' });
const getOrCreateInbox = vi.fn().mockResolvedValue('inbox-1');
// Sync-readiness gate: files can only be saved once sync is ready. Default ready.
const canUpload = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
vi.mock('../../sync/shared-blobs', () => ({ canUploadSharedBlob: () => canUpload() }));
vi.mock('../../hooks/use-shared-items', () => ({
  createFileItem: (...a: unknown[]) => createFileItem(...a),
  createLinkItem: (...a: unknown[]) => createLinkItem(...a),
  createSnippetItem: (...a: unknown[]) => createSnippetItem(...a),
  formatBytes: (n: number) => `${n} B`,
}));
vi.mock('../../hooks/use-tasks', () => ({ createTask: (...a: unknown[]) => createTask(...a) }));
vi.mock('../../hooks/use-task-lists', () => ({ getOrCreateInbox: () => getOrCreateInbox() }));
// Partial mock: keep the real (pure) sanitize/formatCaptureResult, stub the DB-touching captureToInbox.
vi.mock('../../hooks/use-url-capture', async (orig) => ({
  ...(await orig<typeof import('../../hooks/use-url-capture')>()),
  captureToInbox: (...a: unknown[]) => captureToInbox(...a),
}));
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));

import { useShareTarget } from '../../hooks/use-share-target';

// The prompt itself is tested in components/ShareTargetPrompt.test.tsx; here a
// bare harness drives the hook's pending state and destination callbacks.
function Harness() {
  const api = useShareTarget();
  if (!api.pendingShare) return null;
  return (
    <div>
      <div data-testid="pending-files">{api.pendingShare.files.map((f) => f.name).join(',')}</div>
      <button onClick={() => api.resolveShare('inbox')}>to-inbox</button>
      <button onClick={() => api.resolveShare('shared-folder')}>to-folder</button>
      <button onClick={api.discardShare}>discard</button>
      <button onClick={api.postponeShare}>postpone</button>
    </div>
  );
}

// Minimal Cache stand-in: the hook only calls match().json() / match().blob(), so we
// return lightweight response-like objects (real undici Response can't wrap a jsdom Blob).
function installFakeCaches(meta: SharedPayloadMeta | null, files: Record<string, { bytes: Uint8Array; type: string }>) {
  const store: Record<string, { json?: () => Promise<unknown>; blob?: () => Promise<Blob> }> = {};
  if (meta) store[SHARE_META_PATH] = { json: async () => meta };
  for (const [k, v] of Object.entries(files)) store[k] = { blob: async () => new Blob([v.bytes as BlobPart], { type: v.type }) };
  // Model CacheStorage existence: has() probes it, delete() of a nonexistent cache is
  // a no-op returning false (the hook relies on both — ACR-017 sweep).
  let exists = meta !== null || Object.keys(files).length > 0;
  let deletedExisting = false;
  (globalThis as unknown as { caches: unknown }).caches = {
    has: async () => exists,
    open: async () => ({
      match: async (req: unknown) => (exists ? store[String(req)] : undefined),
      put: async () => undefined,
    }),
    delete: async () => { if (!exists) return false; exists = false; deletedExisting = true; return true; },
  };
  return { wasDeleted: () => deletedExisting };
}

const fileMeta = (over: Partial<SharedPayloadMeta> = {}): SharedPayloadMeta => ({
  title: '', text: '', url: '', ts: Date.now(),
  files: [{ name: 'photo.png', type: 'image/png', size: 3 }],
  ...over,
});
const fileBlobs = { [shareFilePath(0)]: { bytes: new Uint8Array([1, 2, 3]), type: 'image/png' } };

beforeEach(() => {
  createFileItem.mockClear();
  createLinkItem.mockClear();
  createSnippetItem.mockClear();
  captureToInbox.mockClear();
  createTask.mockClear();
  getOrCreateInbox.mockClear();
  canUpload.mockReset();
  canUpload.mockResolvedValue(true);
  useAppState.setState({ selectedListId: null });
});
afterEach(() => { delete (globalThis as unknown as { caches?: unknown }).caches; });

describe('useShareTarget (Android share → destination prompt)', () => {
  it('prompts for a shared file; choosing Shared Folder saves it there and navigates', async () => {
    window.history.replaceState({}, '', '/?shareTarget=1');
    const cache = installFakeCaches(fileMeta(), fileBlobs);

    render(<Harness />);

    // Nothing is saved before the user answers.
    await screen.findByText('to-folder');
    expect(createFileItem).not.toHaveBeenCalled();
    expect(screen.getByTestId('pending-files')).toHaveTextContent('photo.png');
    await waitFor(() => expect(window.location.search).toBe('')); // URL scrubbed already

    fireEvent.click(screen.getByText('to-folder'));
    await waitFor(() => expect(createFileItem).toHaveBeenCalledTimes(1));
    const file = createFileItem.mock.calls[0][0] as File;
    expect(file.name).toBe('photo.png');
    expect(file.type).toBe('image/png');
    expect(captureToInbox).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
    await waitFor(() => expect(useAppState.getState().selectedListId).toBe('__shared__'));
    await waitFor(() => expect(cache.wasDeleted()).toBe(true));
  });

  it('choosing Inbox for a file stores the bytes in the Shared Folder AND adds a pointer task', async () => {
    window.history.replaceState({}, '', '/?shareTarget=1');
    const cache = installFakeCaches(fileMeta(), fileBlobs);

    render(<Harness />);
    fireEvent.click(await screen.findByText('to-inbox'));

    await waitFor(() => expect(createFileItem).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));
    expect(getOrCreateInbox).toHaveBeenCalled();
    expect(createTask).toHaveBeenCalledWith('inbox-1', {
      title: 'photo.png',
      description: expect.stringContaining('Shared Folder'),
    });
    // The view is not yanked away — the toast says where things went.
    expect(useAppState.getState().selectedListId).toBeNull();
    await waitFor(() => expect(cache.wasDeleted()).toBe(true));
  });

  it('waits for sync readiness before prompting for a file (startup race)', async () => {
    vi.useFakeTimers();
    try {
      window.history.replaceState({}, '', '/?shareTarget=1');
      installFakeCaches(fileMeta(), fileBlobs);
      // Not ready on the first couple of polls (sync key still deriving), then ready.
      canUpload.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);

      render(<Harness />);
      await act(() => vi.advanceTimersByTimeAsync(1000)); // let the poll flip to ready

      fireEvent.click(screen.getByText('to-folder'));
      await act(() => vi.advanceTimersByTimeAsync(0)); // flush the async save
      expect(createFileItem).toHaveBeenCalledTimes(1);
      expect((createFileItem.mock.calls[0][0] as File).name).toBe('photo.png');
    } finally {
      vi.useRealTimers();
    }
  });

  it('defers (keeps the stash, no prompt) when sync never becomes ready — drops nothing', async () => {
    vi.useFakeTimers();
    try {
      window.history.replaceState({}, '', '/?shareTarget=1');
      const cache = installFakeCaches(fileMeta(), fileBlobs);
      canUpload.mockResolvedValue(false); // offline / sync unavailable

      render(<Harness />);
      await act(() => vi.advanceTimersByTimeAsync(31_000)); // past the readiness timeout

      expect(screen.queryByText('to-folder')).toBeNull(); // never asked
      expect(createFileItem).not.toHaveBeenCalled();
      expect(cache.wasDeleted()).toBe(false); // stash kept so the next start retries
      expect(vi.mocked(toast)).toHaveBeenCalledWith(expect.stringContaining('Sync isn’t ready'), 'info');
    } finally {
      vi.useRealTimers();
    }
  });

  it('defers a plain-text share too when sync is down — a snippet also uploads bytes', async () => {
    vi.useFakeTimers();
    try {
      window.history.replaceState({}, '', '/?shareTarget=1');
      const cache = installFakeCaches({ title: 'Nota', text: 'solo texto, sin enlace', url: '', ts: Date.now(), files: [] }, {});
      canUpload.mockResolvedValue(false);

      render(<Harness />);
      await act(() => vi.advanceTimersByTimeAsync(31_000));

      expect(screen.queryByText('to-folder')).toBeNull();
      expect(cache.wasDeleted()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('prompts a URL share immediately even when sync is down — links carry no blob', async () => {
    window.history.replaceState({}, '', '/?shareTarget=1');
    installFakeCaches({ title: 'Cool page', text: '', url: 'https://example.com/x', ts: Date.now(), files: [] }, {});
    canUpload.mockResolvedValue(false);

    render(<Harness />);
    expect(await screen.findByText('to-folder')).toBeInTheDocument();
  });

  it('routes a shared link to the Inbox with a clickable link field when chosen', async () => {
    window.history.replaceState({}, '', '/?shareTarget=1');
    installFakeCaches({ title: 'Cool page', text: '', url: 'https://example.com/x', ts: Date.now(), files: [] }, {});

    render(<Harness />);
    fireEvent.click(await screen.findByText('to-inbox'));

    await waitFor(() => expect(captureToInbox).toHaveBeenCalledTimes(1));
    const result = captureToInbox.mock.calls[0][0] as { title: string; link?: string };
    expect(result.link).toBe('https://example.com/x'); // passed to createTask -> clickable
    expect(createFileItem).not.toHaveBeenCalled();
  });

  it('saves a shared link as a Shared Folder link item when chosen', async () => {
    window.history.replaceState({}, '', '/?shareTarget=1');
    const cache = installFakeCaches({ title: 'Cool page', text: '', url: 'https://example.com/x', ts: Date.now(), files: [] }, {});

    render(<Harness />);
    fireEvent.click(await screen.findByText('to-folder'));

    await waitFor(() => expect(createLinkItem).toHaveBeenCalledWith('https://example.com/x', 'Cool page'));
    expect(captureToInbox).not.toHaveBeenCalled();
    await waitFor(() => expect(useAppState.getState().selectedListId).toBe('__shared__'));
    await waitFor(() => expect(cache.wasDeleted()).toBe(true));
  });

  it('saves shared plain text as a Shared Folder snippet when chosen', async () => {
    window.history.replaceState({}, '', '/?shareTarget=1');
    installFakeCaches({ title: 'A thought', text: 'remember the milk', url: '', ts: Date.now(), files: [] }, {});

    render(<Harness />);
    fireEvent.click(await screen.findByText('to-folder'));

    await waitFor(() => expect(createSnippetItem).toHaveBeenCalledWith('A thought', 'remember the milk'));
    expect(createLinkItem).not.toHaveBeenCalled();
  });

  it('discard clears the stash without saving anything', async () => {
    window.history.replaceState({}, '', '/?shareTarget=1');
    const cache = installFakeCaches(fileMeta(), fileBlobs);

    render(<Harness />);
    fireEvent.click(await screen.findByText('discard'));

    await waitFor(() => expect(cache.wasDeleted()).toBe(true));
    expect(createFileItem).not.toHaveBeenCalled();
    expect(captureToInbox).not.toHaveBeenCalled();
    expect(screen.queryByText('to-folder')).toBeNull();
  });

  it('postpone keeps the stash so the next start asks again', async () => {
    window.history.replaceState({}, '', '/?shareTarget=1');
    const cache = installFakeCaches(fileMeta(), fileBlobs);

    render(<Harness />);
    fireEvent.click(await screen.findByText('postpone'));

    expect(screen.queryByText('to-folder')).toBeNull(); // prompt closed…
    await new Promise((r) => setTimeout(r, 20));
    expect(cache.wasDeleted()).toBe(false); // …but the share is not lost
    expect(createFileItem).not.toHaveBeenCalled();
  });

  it('surfaces the SW error redirect without throwing', async () => {
    window.history.replaceState({}, '', '/?shareTarget=error');
    render(<Harness />);
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(createFileItem).not.toHaveBeenCalled();
    expect(captureToInbox).not.toHaveBeenCalled();
  });

  it('clears a (possibly partial) stash on the SW error redirect (ACR-017)', async () => {
    window.history.replaceState({}, '', '/?shareTarget=error');
    const cache = installFakeCaches(fileMeta({ files: [{ name: 'half.bin', type: '', size: 9 }] }), {});
    render(<Harness />);
    await waitFor(() => expect(cache.wasDeleted()).toBe(true));
    expect(createFileItem).not.toHaveBeenCalled();
  });

  it('offers an orphaned fresh stash on startup without the redirect flag (ACR-017)', async () => {
    window.history.replaceState({}, '', '/'); // normal launch — redirect URL was lost
    const cache = installFakeCaches(
      fileMeta({ files: [{ name: 'doc.pdf', type: 'application/pdf', size: 3 }] }),
      { [shareFilePath(0)]: { bytes: new Uint8Array([1, 2, 3]), type: 'application/pdf' } },
    );

    render(<Harness />);
    fireEvent.click(await screen.findByText('to-folder'));

    await waitFor(() => expect(createFileItem).toHaveBeenCalledTimes(1));
    expect((createFileItem.mock.calls[0][0] as File).name).toBe('doc.pdf');
    await waitFor(() => expect(cache.wasDeleted()).toBe(true));
  });

  it('purges a stale orphaned stash without importing or prompting (ACR-017)', async () => {
    window.history.replaceState({}, '', '/');
    const cache = installFakeCaches(
      fileMeta({ title: 'old', ts: Date.now() - SHARE_STASH_TTL_MS - 60_000, files: [{ name: 'old.png', type: 'image/png', size: 3 }] }),
      fileBlobs,
    );

    render(<Harness />);

    await waitFor(() => expect(cache.wasDeleted()).toBe(true));
    expect(screen.queryByText('to-folder')).toBeNull();
    expect(createFileItem).not.toHaveBeenCalled();
    expect(captureToInbox).not.toHaveBeenCalled();
  });

  it('does not touch the URL or the (empty) cache on a normal launch', async () => {
    window.history.replaceState({}, '', '/?capture&title=x'); // bookmarklet params belong to use-url-capture
    const cache = installFakeCaches(null, {});
    render(<Harness />);
    await new Promise((r) => setTimeout(r, 20));
    expect(window.location.search).toBe('?capture&title=x'); // untouched without the shareTarget flag
    expect(cache.wasDeleted()).toBe(false);
  });

  it('tells the user when the SW skipped oversized files (ACR-018)', async () => {
    window.history.replaceState({}, '', '/?shareTarget=1');
    installFakeCaches(fileMeta({ skippedFiles: 2 }), fileBlobs);

    render(<Harness />);

    await screen.findByText('to-folder'); // toast fires when the prompt appears
    await waitFor(() => expect(vi.mocked(toast)).toHaveBeenCalledWith('2 shared files were too large to receive', 'error'));
    expect(createFileItem).not.toHaveBeenCalled(); // still awaiting the user's choice
  });
});

describe('selectFilesToStash (SW stash caps, ACR-018)', () => {
  it('skips a single file over the per-file cap', () => {
    const { keep, skipped } = selectFilesToStash([{ size: MAX_SHARE_FILE_BYTES + 1 }, { size: 10 }]);
    expect(keep.map((f) => f.size)).toEqual([10]);
    expect(skipped).toBe(1);
  });

  it('enforces the aggregate cap in share order', () => {
    const half = Math.floor(MAX_SHARE_TOTAL_BYTES / 2);
    const { keep, skipped } = selectFilesToStash([{ size: half }, { size: half }, { size: half }]);
    expect(keep.length).toBe(2);
    expect(skipped).toBe(1);
  });

  it('enforces the file-count cap', () => {
    const many = Array.from({ length: MAX_SHARE_FILES + 5 }, () => ({ size: 1 }));
    const { keep, skipped } = selectFilesToStash(many);
    expect(keep.length).toBe(MAX_SHARE_FILES);
    expect(skipped).toBe(5);
  });

  it('keeps everything when within all caps', () => {
    const { keep, skipped } = selectFilesToStash([{ size: 1 }, { size: 2 }]);
    expect(keep.length).toBe(2);
    expect(skipped).toBe(0);
  });
});
