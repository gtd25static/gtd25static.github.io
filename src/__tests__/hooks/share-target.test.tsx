// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react';
import '../setup-component';
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { SHARE_META_PATH, shareFilePath, type SharedPayloadMeta } from '../../lib/share-target';
import { useAppState } from '../../stores/app-state';

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
function installFakeCaches(meta: SharedPayloadMeta, files: Record<string, { bytes: Uint8Array; type: string }>) {
  const store: Record<string, { json?: () => Promise<unknown>; blob?: () => Promise<Blob> }> = {
    [SHARE_META_PATH]: { json: async () => meta },
  };
  for (const [k, v] of Object.entries(files)) store[k] = { blob: async () => new Blob([v.bytes as BlobPart], { type: v.type }) };
  let deleted = false;
  (globalThis as unknown as { caches: unknown }).caches = {
    open: async () => ({
      match: async (req: unknown) => (deleted ? undefined : store[String(req)]),
      put: async () => undefined,
    }),
    delete: async () => { deleted = true; return true; },
  };
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
});
