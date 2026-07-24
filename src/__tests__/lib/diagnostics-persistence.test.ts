// @vitest-environment jsdom
import { vi, describe, it, expect, beforeEach } from 'vitest';

const KEY = 'gtd25-diagnostics-log';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// The log is module state hydrated at import time, so each test re-imports a
// fresh module instance against a seeded localStorage — an app restart in vitro.
async function freshDiagnostics() {
  vi.resetModules();
  return import('../../lib/diagnostics');
}

beforeEach(() => {
  localStorage.clear();
});

describe('diagnostics log persistence', () => {
  it('persists recorded errors and survives a module reload (app restart / update)', async () => {
    const d1 = await freshDiagnostics();
    d1.recordError('test.ctx', new Error('boom'));
    expect(JSON.parse(localStorage.getItem(KEY)!)).toHaveLength(1);

    const d2 = await freshDiagnostics(); // "restart"
    const log = d2.getErrorLog();
    expect(log).toHaveLength(1);
    expect(log[0].context).toBe('test.ctx');
    expect(log[0].message).toBe('boom');
  });

  it('prunes entries older than a week on load — persistent, not eternal', async () => {
    const now = Date.now();
    localStorage.setItem(KEY, JSON.stringify([
      { at: now - WEEK_MS - 60_000, context: 'old', message: 'ancient' },
      { at: now - 60_000, context: 'fresh', message: 'recent' },
    ]));
    const d = await freshDiagnostics();
    expect(d.getErrorLog().map((e) => e.context)).toEqual(['fresh']);
  });

  it('caps the stored log at the ring-buffer size', async () => {
    const now = Date.now();
    localStorage.setItem(KEY, JSON.stringify(
      Array.from({ length: 150 }, (_, i) => ({ at: now - i, context: `c${i}`, message: 'm' })),
    ));
    const d = await freshDiagnostics();
    expect(d.getErrorLog().length).toBe(100);
  });

  it('tolerates corrupted or non-array storage without breaking recording', async () => {
    localStorage.setItem(KEY, 'not json at all {');
    const d = await freshDiagnostics();
    expect(d.getErrorLog()).toHaveLength(0);
    d.recordError('after.corruption', 'still works');
    expect(d.getErrorLog()).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toHaveLength(1);
  });

  it('clearErrorLog removes the persisted copy too', async () => {
    const d = await freshDiagnostics();
    d.recordError('ctx', 'x');
    d.clearErrorLog();
    expect(d.getErrorLog()).toHaveLength(0);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('keeps redacting secrets before anything touches disk (ACR-015)', async () => {
    const d = await freshDiagnostics();
    d.recordError('ctx', new Error('token ghp_0123456789012345678901234 leaked'));
    expect(localStorage.getItem(KEY)).not.toContain('ghp_');
    expect(d.getErrorLog()[0].message).toContain('[redacted-token]');
  });
});
