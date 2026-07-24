// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../setup-component';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import type { UnlockLogEntry } from '../../lib/unlock-audit';

const isParanoidEnabled = vi.fn(() => true);
vi.mock('../../db/vault', () => ({ isParanoidEnabled: () => isParanoidEnabled() }));
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));

import { useUnlockAudit } from '../../hooks/use-unlock-audit';
import { UnlockAuditAlert } from '../../components/security/UnlockAuditAlert';
import { toast } from '../../components/ui/Toast';

const ok = (at: number): UnlockLogEntry => ({ at, method: 'passphrase', ok: true });
const fail = (at: number, method: UnlockLogEntry['method'] = 'passphrase'): UnlockLogEntry =>
  ({ at, method, ok: false });

// The real wiring: the hook feeds the alert component, exactly as App.tsx does.
function Harness() {
  const api = useUnlockAudit();
  return <UnlockAuditAlert {...api} />;
}

async function setLog(log: UnlockLogEntry[], enabled = true) {
  await db.localSettings.put({
    id: 'local', syncEnabled: false, syncIntervalMs: 300_000,
    paranoidUnlockLogEnabled: enabled, unlockLog: log,
  });
}

beforeEach(async () => {
  await resetDb();
  isParanoidEnabled.mockReturnValue(true);
  vi.mocked(toast).mockClear();
});

describe('unlock audit alert (failed attempts while you were away)', () => {
  it('raises an acknowledgeable dialog listing each failed attempt', async () => {
    // Previous session, two wrong tries overnight, then this unlock.
    await setLog([ok(1_000), fail(2_000), fail(3_000, 'securityKey'), ok(4_000)]);

    render(<Harness />);

    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByText('2 failed unlock attempts')).toBeInTheDocument();
    // Each attempt is listed with its method, so an own typo is recognisable.
    expect(screen.getByText('Security key')).toBeInTheDocument();
    expect(screen.getAllByText('Passphrase')).toHaveLength(1);
    expect(screen.getByText(new RegExp(new Date(1_000).toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeInTheDocument();
    // A dialog, not a toast — this one must not auto-dismiss.
    expect(vi.mocked(toast)).not.toHaveBeenCalled();
  });

  it('uses the singular wording for exactly one attempt', async () => {
    await setLog([ok(1_000), fail(2_000), ok(3_000)]);
    render(<Harness />);
    expect(await screen.findByText('A failed unlock attempt')).toBeInTheDocument();
  });

  it('dismisses on acknowledgement', async () => {
    await setLog([ok(1_000), fail(2_000), ok(3_000)]);
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: 'Got it' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('stays quiet (toast only) when nothing failed since last time', async () => {
    await setLog([ok(1_000), ok(2_000)]);
    render(<Harness />);
    await waitFor(() => expect(vi.mocked(toast)).toHaveBeenCalledWith(expect.stringContaining('Last unlock'), 'info'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('does not count the unlock that just happened as a failure', async () => {
    // Failures BEFORE the previous success must not resurface.
    await setLog([fail(500), ok(1_000), ok(2_000)]);
    render(<Harness />);
    await waitFor(() => expect(vi.mocked(toast)).toHaveBeenCalled());
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('says nothing at all while the audit toggle is off', async () => {
    await setLog([ok(1_000), fail(2_000), ok(3_000)], false);
    render(<Harness />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(vi.mocked(toast)).not.toHaveBeenCalled();
  });

  it('says nothing when Paranoid mode is off', async () => {
    isParanoidEnabled.mockReturnValue(false);
    await setLog([ok(1_000), fail(2_000), ok(3_000)]);
    render(<Harness />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(vi.mocked(toast)).not.toHaveBeenCalled();
  });
});
