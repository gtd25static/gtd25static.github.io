import { vi, type Mock } from 'vitest';
import { db } from '../../db';
import { resetSyncState, setupSyncCredentials, makeSyncData, makeChangeEntry } from '../helpers/sync-helpers';
import type { SyncData, TaskList } from '../../db/models';

// The Paranoid idle poll asks "changed since the last sync?" with two conditional
// GETs, so the steady state is two bodyless 304s. Its ETags used to be learned only
// by the probe itself — never from a sync — so the first probe after every sync
// (own push or another device's change) downloaded both files whole and then ran
// a full sync that downloaded them again.

vi.mock('../../sync/github-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sync/github-api')>();
  return { ...actual, getFile: vi.fn(), putFile: vi.fn(), getFileConditional: vi.fn(), testConnection: vi.fn() };
});
vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));
vi.mock('../../sync/remote-backups', async () => ({
  ...(await vi.importActual('../../sync/remote-backups')),
  maybeCreateBackups: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../sync/shared-blobs', async () => ({
  ...(await vi.importActual('../../sync/shared-blobs')),
  maybeCompactBlobBranch: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../sync/history-compaction', () => ({ maybeSquashDefaultBranch: vi.fn(() => Promise.resolve()) }));

import { getFile, putFile, getFileConditional } from '../../sync/github-api';
import { syncNow, cheapIdleProbe, SNAPSHOT_FILE, CHANGELOG_FILE } from '../../sync/sync-engine';
import { cacheEncryptionKey, deriveKey, generateSalt, createVerifier, encryptSyncData } from '../../sync/crypto';
import { SYNC_VERSION } from '../../sync/version';

let testKey: CryptoKey;
let testSalt: string;
let remote: Map<string, { data: string; sha: string }>;
let shaCounter = 0;
let probes: string[];

const etagOf = (sha: string) => `W/"${sha}"`;

beforeAll(async () => {
  testSalt = generateSalt();
  testKey = await deriveKey('test-password', testSalt);
});

beforeEach(async () => {
  vi.clearAllMocks();
  await resetSyncState();
  await setupSyncCredentials();
  cacheEncryptionKey(testKey, testSalt);
  remote = new Map();
  probes = [];
  (getFile as Mock).mockImplementation(async (_p: string, _r: string, path: string) => {
    const file = remote.get(path);
    return file ? { ...file, etag: etagOf(file.sha) } : null;
  });
  (putFile as Mock).mockImplementation(async (_p: string, _r: string, path: string, data: string, sha?: string) => {
    if (remote.get(path)?.sha !== sha) throw new Error('CONFLICT');
    const next = `sha-${++shaCounter}`;
    remote.set(path, { data, sha: next });
    return next;
  });
  (getFileConditional as Mock).mockImplementation(async (_p: string, _r: string, path: string, etag?: string | null) => {
    const file = remote.get(path);
    if (!file) { probes.push(`${path}:absent`); return { status: 'absent' }; }
    if (etag === etagOf(file.sha)) { probes.push(`${path}:304`); return { status: 'unchanged', etag }; }
    probes.push(`${path}:200`);
    return { status: 'ok', data: file.data, sha: file.sha, etag: etagOf(file.sha) };
  });
});

function list(id: string, name: string): TaskList {
  const now = Date.now();
  return { id, name, type: 'tasks', order: 0, createdAt: now, updatedAt: now } as TaskList;
}

async function syncedOnce() {
  const data = makeSyncData({
    syncVersion: SYNC_VERSION, encryptionSalt: testSalt, encryptionVerifier: await createVerifier(testKey), taskLists: [list('l1', 'Work')],
  }) as SyncData;
  remote.set(SNAPSHOT_FILE, { data: JSON.stringify(await encryptSyncData(testKey, data)), sha: `sha-${++shaCounter}` });
  remote.set(CHANGELOG_FILE, { data: '[]', sha: `sha-${++shaCounter}` });
  await db.syncMeta.update('sync-meta', { lastPulledAt: Date.now() - 60_000 });
  expect(await syncNow()).toBe(0);
  // A device's first sync also writes its pomodoro settings into the snapshot;
  // the steady state starts with the sync after that.
  expect(await syncNow()).toBe(0);
}

describe('the idle probe after a sync', () => {
  it('sees both files unchanged right after a sync', async () => {
    await syncedOnce();
    expect(await cheapIdleProbe()).toBe(false);
    expect(probes).toEqual([`${CHANGELOG_FILE}:304`, `${SNAPSHOT_FILE}:304`]);
  });

  it('recognises the changelog this device just pushed, then settles into 304s', async () => {
    await syncedOnce();
    await db.changeLog.add(makeChangeEntry({ entityId: 't1' }));
    expect(await syncNow()).toBe(0);

    expect(await cheapIdleProbe()).toBe(false); // its own push: a 200 it recognises
    expect(await cheapIdleProbe()).toBe(false);
    expect(probes.slice(-2)).toEqual([`${CHANGELOG_FILE}:304`, `${SNAPSHOT_FILE}:304`]);
  });

  it('still notices another device writing', async () => {
    await syncedOnce();
    remote.set(CHANGELOG_FILE, { data: JSON.stringify([makeChangeEntry({ deviceId: 'device-B' })]), sha: `sha-${++shaCounter}` });
    expect(await cheapIdleProbe()).toBe(true);
  });

  it('does not treat what a failed sync read as applied', async () => {
    await syncedOnce();
    const otherKey = await deriveKey('someone else', testSalt);
    const snap = JSON.parse(remote.get(SNAPSHOT_FILE)!.data) as SyncData;
    snap.encryptionVerifier = await createVerifier(otherKey);
    remote.set(SNAPSHOT_FILE, { data: JSON.stringify(snap), sha: `sha-${++shaCounter}` });

    expect(await syncNow()).toBe(-1); // stops after reading both files
    expect(await cheapIdleProbe()).toBe(true);
  });

  it('keeps asking after a change it saw could not be applied', async () => {
    // The probe used to keep the ETag of every 200 — including another device's
    // change it had not applied. When the sync that followed failed (a network
    // blip), every later probe got a 304 and the device stopped pulling until
    // something else woke it.
    await syncedOnce();
    remote.set(CHANGELOG_FILE, {
      data: JSON.stringify([makeChangeEntry({ deviceId: 'device-B', entityId: 'tB' })]), sha: `sha-${++shaCounter}`,
    });
    expect(await cheapIdleProbe()).toBe(true);

    (getFile as Mock).mockRejectedValueOnce(new Error('network'));
    expect(await syncNow()).toBe(-1);

    expect(await cheapIdleProbe()).toBe(true);
    expect(await syncNow()).toBe(0);
    expect(await cheapIdleProbe()).toBe(false);
  });
});
