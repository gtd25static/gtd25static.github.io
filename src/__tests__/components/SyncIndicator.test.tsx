// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import '../setup-component';
import { vi, beforeEach, describe, it, expect } from 'vitest';
import type { SyncData } from '../../sync/use-sync';

// Mutable holder so each test can shape the sync context.
const h = vi.hoisted(() => ({ ctx: {} as Record<string, unknown> }));
vi.mock('../../sync/use-sync', () => ({
  useSyncContext: () => h.ctx,
}));

import { SyncIndicator } from '../../components/layout/SyncIndicator';

function setCtx(overrides: Partial<SyncData>) {
  h.ctx = {
    syncEnabled: true,
    pendingChanges: false,
    syncProgress: null,
    lastSyncStats: null,
    lastErrorInfo: null,
    online: true,
    lastPulledAt: undefined,
    triggerSync: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  setCtx({});
});

describe('SyncIndicator', () => {
  it('renders nothing when sync is disabled', () => {
    setCtx({ syncEnabled: false });
    const { container } = render(<SyncIndicator />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the rate-limit resume time', () => {
    const resetAt = new Date('2026-06-11T14:32:00').getTime();
    setCtx({ lastErrorInfo: { category: 'rate-limited', message: 'GitHub API rate limit exceeded', retryAtMs: resetAt } });
    render(<SyncIndicator />);
    expect(screen.getByText('Rate limited — resumes 14:32')).toBeInTheDocument();
  });

  it('labels a missing repo actionably', () => {
    setCtx({ lastErrorInfo: { category: 'repo-missing', message: 'GitHub API error: 404' } });
    render(<SyncIndicator />);
    expect(screen.getByText('Repo not found — check Settings → Sync')).toBeInTheDocument();
    expect(screen.getByRole('button').title).toContain('GitHub API error: 404');
  });

  it('labels a rejected token actionably', () => {
    setCtx({ lastErrorInfo: { category: 'auth', message: 'GitHub API error: 401' } });
    render(<SyncIndicator />);
    expect(screen.getByText('Token rejected — check PAT in Settings')).toBeInTheDocument();
  });

  it('labels a version gate actionably', () => {
    setCtx({ lastErrorInfo: { category: 'update-required', message: 'Remote data requires a newer app version' } });
    render(<SyncIndicator />);
    expect(screen.getByText('Update required — reload app')).toBeInTheDocument();
  });

  it('offline trumps a stale error and shows the last-synced age', () => {
    setCtx({
      online: false,
      lastPulledAt: Date.now() - 2 * 60 * 60 * 1000,
      lastErrorInfo: { category: 'network', message: 'Failed to fetch' },
    });
    render(<SyncIndicator />);
    expect(screen.getByText('Offline — last synced 2h ago')).toBeInTheDocument();
    expect(screen.queryByText('No connection')).not.toBeInTheDocument();
  });

  it('shows plain Offline when nothing was ever synced', () => {
    setCtx({ online: false });
    render(<SyncIndicator />);
    expect(screen.getByText('Offline')).toBeInTheDocument();
  });

  it('idle state carries the last-synced age in the tooltip', () => {
    setCtx({ lastPulledAt: Date.now() - 5 * 60 * 1000 });
    render(<SyncIndicator />);
    expect(screen.getByText('Synced')).toBeInTheDocument();
    expect(screen.getByRole('button').title).toBe('Last synced 5m ago — click to sync');
  });
});
