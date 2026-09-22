// @vitest-environment jsdom
import { useState } from 'react';
import { vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { ServiceWorkerProvider, useServiceWorker, type UpdateCheckResult } from '../../hooks/use-service-worker';
import { GIT_COMMIT } from '../../lib/constants';

// An update check must distinguish "nothing new" from "I could not tell".
// The stub for virtual:pwa-register/react never calls onRegisteredSW, so every
// case here goes through the fallback that asks the browser for the
// registration — the path a device with a failed registration takes.

function Probe() {
  const { forceCheck } = useServiceWorker();
  const [result, setResult] = useState<UpdateCheckResult | null>(null);
  return (
    <>
      <button onClick={() => void forceCheck().then(setResult)}>check</button>
      <output data-testid="result">{result ?? ''}</output>
    </>
  );
}

/** Mount the provider, run one check, and return what it reported. */
async function runCheck(): Promise<string> {
  render(<ServiceWorkerProvider><Probe /></ServiceWorkerProvider>);
  await userEvent.setup().click(screen.getByRole('button', { name: 'check' }));
  await waitFor(() => expect(screen.getByTestId('result')).not.toBeEmptyDOMElement());
  return screen.getByTestId('result').textContent ?? '';
}

function stubServiceWorker(value: unknown) {
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value });
}

function stubRegistration(registration: Partial<ServiceWorkerRegistration>) {
  stubServiceWorker({ getRegistration: () => Promise.resolve(registration) });
}

/** registration.update() resolves with the registration itself, not with void. */
const resolvingUpdate = () => Promise.resolve({} as ServiceWorkerRegistration);

/** What version.json reports, or null for a file the device cannot reach. */
function stubDeployedCommit(commit: string | null) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(
    commit === null
      ? ({ ok: false } as Response)
      : ({ ok: true, json: () => Promise.resolve({ commit, message: 'deployed' }) } as unknown as Response),
  )));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

describe('a user-initiated update check', () => {
  it('reports that nothing is registered to install updates', async () => {
    stubServiceWorker(undefined);
    expect(await runCheck()).toBe('no-worker');
  });

  it('reports the same when the browser knows of no registration', async () => {
    stubServiceWorker({ getRegistration: () => Promise.resolve(undefined) });
    expect(await runCheck()).toBe('no-worker');
  });

  it('reports a waiting build without needing the version file', async () => {
    stubRegistration({ update: resolvingUpdate, waiting: {} as ServiceWorker });
    stubDeployedCommit(GIT_COMMIT);

    expect(await runCheck()).toBe('update-found');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('confirms up to date only when the deployed commit is the one running', async () => {
    const update = vi.fn(resolvingUpdate);
    stubRegistration({ update });
    stubDeployedCommit(GIT_COMMIT);

    expect(await runCheck()).toBe('up-to-date');
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('catches a stuck worker: the server has another build and the check found nothing', async () => {
    stubRegistration({ update: resolvingUpdate });
    stubDeployedCommit('c0ffee1');

    expect(await runCheck()).toBe('stale-worker');
  });

  it('reports a failure instead of calling a rejected check up to date', async () => {
    stubRegistration({ update: () => Promise.reject(new Error('blocked by the network')) });
    stubDeployedCommit(GIT_COMMIT);

    expect(await runCheck()).toBe('failed');
  });

  it('does not cry wolf when the version file itself is unreachable', async () => {
    stubRegistration({ update: resolvingUpdate });
    stubDeployedCommit(null);

    expect(await runCheck()).toBe('up-to-date');
  });
});
