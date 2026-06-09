// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react';
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
const captureToInbox = vi.fn().mockResolvedValue(undefined);
vi.mock('../../hooks/use-shared-items', () => ({ createFileItem: (...a: unknown[]) => createFileItem(...a) }));
// Partial mock: keep the real (pure) sanitize/formatCaptureResult, stub the DB-touching captureToInbox.
vi.mock('../../hooks/use-url-capture', async (orig) => ({
  ...(await orig<typeof import('../../hooks/use-url-capture')>()),
  captureToInbox: (...a: unknown[]) => captureToInbox(...a),
}));
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));

import { useShareTarget } from '../../hooks/use-share-target';

function Harness() { useShareTarget(); return null; }

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

beforeEach(() => {
  createFileItem.mockClear();
  captureToInbox.mockClear();
  useAppState.setState({ selectedListId: null });
});
afterEach(() => { delete (globalThis as unknown as { caches?: unknown }).caches; });

describe('useShareTarget (Android share → Shared Folder / Inbox)', () => {
  it('saves a shared file into the Shared Folder and navigates there', async () => {
    window.history.replaceState({}, '', '/?shareTarget=1');
    installFakeCaches(
      { title: '', text: '', url: '', ts: Date.now(), files: [{ name: 'photo.png', type: 'image/png', size: 3 }] },
      { [shareFilePath(0)]: { bytes: new Uint8Array([1, 2, 3]), type: 'image/png' } },
    );

    render(<Harness />);

    await waitFor(() => expect(createFileItem).toHaveBeenCalledTimes(1));
    const file = createFileItem.mock.calls[0][0] as File;
    expect(file.name).toBe('photo.png');
    expect(file.type).toBe('image/png');
    expect(captureToInbox).not.toHaveBeenCalled();
    await waitFor(() => expect(useAppState.getState().selectedListId).toBe('__shared__'));
    await waitFor(() => expect(window.location.search).toBe('')); // URL scrubbed
  });

  it('routes a shared link to the Inbox with a clickable link field', async () => {
    window.history.replaceState({}, '', '/?shareTarget=1');
    installFakeCaches(
      { title: 'Cool page', text: '', url: 'https://example.com/x', ts: Date.now(), files: [] },
      {},
    );

    render(<Harness />);

    await waitFor(() => expect(captureToInbox).toHaveBeenCalledTimes(1));
    const result = captureToInbox.mock.calls[0][0] as { title: string; link?: string };
    expect(result.link).toBe('https://example.com/x'); // passed to createTask -> clickable
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
    const cache = installFakeCaches(
      { title: '', text: '', url: '', ts: Date.now(), files: [{ name: 'half.bin', type: '', size: 9 }] },
      {},
    );
    render(<Harness />);
    await waitFor(() => expect(cache.wasDeleted()).toBe(true));
    expect(createFileItem).not.toHaveBeenCalled();
  });

  it('consumes an orphaned fresh stash on startup without the redirect flag (ACR-017)', async () => {
    window.history.replaceState({}, '', '/'); // normal launch — redirect URL was lost
    const cache = installFakeCaches(
      { title: '', text: '', url: '', ts: Date.now(), files: [{ name: 'doc.pdf', type: 'application/pdf', size: 3 }] },
      { [shareFilePath(0)]: { bytes: new Uint8Array([1, 2, 3]), type: 'application/pdf' } },
    );

    render(<Harness />);

    await waitFor(() => expect(createFileItem).toHaveBeenCalledTimes(1));
    expect((createFileItem.mock.calls[0][0] as File).name).toBe('doc.pdf');
    await waitFor(() => expect(cache.wasDeleted()).toBe(true));
  });

  it('purges a stale orphaned stash without importing it (ACR-017)', async () => {
    window.history.replaceState({}, '', '/');
    const cache = installFakeCaches(
      { title: 'old', text: '', url: '', ts: Date.now() - SHARE_STASH_TTL_MS - 60_000, files: [{ name: 'old.png', type: 'image/png', size: 3 }] },
      { [shareFilePath(0)]: { bytes: new Uint8Array([1, 2, 3]), type: 'image/png' } },
    );

    render(<Harness />);

    await waitFor(() => expect(cache.wasDeleted()).toBe(true));
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
    installFakeCaches(
      { title: '', text: '', url: '', ts: Date.now(), files: [{ name: 'ok.png', type: 'image/png', size: 3 }], skippedFiles: 2 },
      { [shareFilePath(0)]: { bytes: new Uint8Array([1, 2, 3]), type: 'image/png' } },
    );

    render(<Harness />);

    await waitFor(() => expect(createFileItem).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(vi.mocked(toast)).toHaveBeenCalledWith('2 shared files were too large to receive', 'error'));
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
