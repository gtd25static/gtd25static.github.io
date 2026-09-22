// @vitest-environment jsdom
import { vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../setup-component';
import { toast, ToastContainer } from '../../components/ui/Toast';

// A toast fired while no container is mounted waits, briefly, for the next one
// (the app shell is swapped out during a vault re-key); an old one is dropped.

afterEach(() => {
  vi.restoreAllMocks();
});

it('shows a toast fired just before the container mounted', async () => {
  toast('Device re-keyed', 'success');
  render(<ToastContainer />);
  expect(await screen.findByText('Device re-keyed')).toBeInTheDocument();
});

it('drops a toast fired long before the container mounted', async () => {
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now - 10_000);
  toast('from before a lock', 'info');
  vi.spyOn(Date, 'now').mockReturnValue(now);
  render(<ToastContainer />);
  await new Promise((r) => setTimeout(r, 50));
  expect(screen.queryByText('from before a lock')).toBeNull();
});
