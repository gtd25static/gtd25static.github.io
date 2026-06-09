// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react';
import '../setup-component';
import { vi, beforeEach } from 'vitest';

// Stub the capture side-effects so the test focuses on URL handling (ACR-004).
const createTask = vi.fn().mockResolvedValue({ id: 't1' });
const getOrCreateInbox = vi.fn().mockResolvedValue('inbox-id');
vi.mock('../../hooks/use-tasks', () => ({ createTask: (...a: unknown[]) => createTask(...a) }));
vi.mock('../../hooks/use-task-lists', () => ({ getOrCreateInbox: () => getOrCreateInbox() }));
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));

import { useUrlCapture } from '../../hooks/use-url-capture';

function Harness() {
  useUrlCapture();
  return null;
}

beforeEach(() => {
  createTask.mockClear();
  getOrCreateInbox.mockClear();
});

describe('useUrlCapture — share-target URL scrubbing (ACR-004)', () => {
  it('clears the query string immediately, before async capture resolves', async () => {
    window.history.replaceState({}, '', '/capture?title=Secret&text=sensitive%20note&url=https%3A%2F%2Fx.com');
    expect(window.location.pathname).toBe('/capture');
    expect(window.location.search).not.toBe('');

    render(<Harness />);

    // The mount effect scrubs the URL synchronously, before captureToInbox settles —
    // so shared content does not linger in the address bar/history.
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('');

    // The capture still happens from the values read before scrubbing.
    await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));
  });

  it('scrubs the URL even when all params are empty', async () => {
    window.history.replaceState({}, '', '/capture?title=&text=&url=');
    render(<Harness />);
    expect(window.location.pathname).toBe('/');
    expect(window.location.search).toBe('');
    expect(createTask).not.toHaveBeenCalled();
  });
});
