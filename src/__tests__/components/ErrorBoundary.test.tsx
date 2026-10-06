// @vitest-environment jsdom
import { render, screen, act } from '@testing-library/react';
import '../setup-component';

vi.mock('../../lib/diagnostics', () => ({ recordError: vi.fn() }));

import { ErrorBoundary } from '../../components/ErrorBoundary';

// A live query waiting behind a long IndexedDB transaction (turning Paranoid
// Mode off on a large database, on a slow device) gives up after Dexie's 60 s
// waitFor with a TimeoutError. The data is fine and the next read succeeds, but
// the app used to replace everything with "Something went wrong".

function timeout(): Error {
  const err = new Error('Transaction timed out');
  err.name = 'TimeoutError';
  return err;
}

// React retries a failed render once on its own, so "broken" is a state the
// test flips, not a count of throws.
let broken = false;
function Flaky({ error }: { error: () => Error }) {
  if (broken) throw error();
  return <p>Content is back</p>;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('waits out a transient database timeout and renders again', async () => {
    broken = true;
    render(<ErrorBoundary><Flaky error={timeout} /></ErrorBoundary>);
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
    expect(screen.getByText(/Still working/)).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(2_000); }); // still blocked: retried, failed again
    expect(screen.getByText(/Still working/)).toBeInTheDocument();
    broken = false; // the migration's transaction committed
    await act(async () => { vi.advanceTimersByTime(10_000); });
    expect(screen.getByText('Content is back')).toBeInTheDocument();
  });

  it('gives up and shows the error after repeated timeouts', async () => {
    broken = true;
    render(<ErrorBoundary><Flaky error={timeout} /></ErrorBoundary>);
    for (let i = 0; i < 10; i++) await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('shows any other error at once, as before', () => {
    broken = true;
    render(<ErrorBoundary><Flaky error={() => new Error('boom')} /></ErrorBoundary>);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
  });
});

// Reliability review 2026-10-06 (M11): the boundary sat above the update
// machinery, so a build that crashed while rendering could not be replaced from
// the app — "Reload" re-ran the same build (a waiting worker needs activating).
describe('ErrorBoundary — a way out of a broken build', () => {
  function Boom(): never {
    throw new Error('render bug');
  }

  it('offers the waiting update, and shows which build failed', async () => {
    const { ServiceWorkerContext } = await import('../../hooks/use-service-worker');
    const applyUpdate = vi.fn();
    render(
      <ServiceWorkerContext.Provider value={{ needRefresh: true, applyUpdate, checkForUpdate: vi.fn(), forceCheck: vi.fn() }}>
        <ErrorBoundary><Boom /></ErrorBoundary>
      </ServiceWorkerContext.Provider>,
    );

    screen.getByRole('button', { name: 'Update and reload' }).click();
    expect(applyUpdate).toHaveBeenCalled();
    expect(screen.getByText(/Build /)).toBeInTheDocument();
  });

  it('with no update waiting, it is a plain Reload', () => {
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update and reload' })).toBeNull();
  });

  it('a fallback can be given, e.g. nothing for a part that must not take the app down', () => {
    render(<div><ErrorBoundary fallback={null}><Boom /></ErrorBoundary><p>The rest</p></div>);
    expect(screen.getByText('The rest')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).toBeNull();
  });
});
