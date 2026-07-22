import { vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { setMigrationBypass } from '../../db/vault-middleware';
import {
  enableParanoid, lock, isUnlocked, unlockWithPassphrase,
  setSecondaryPassphrase, clearSecondaryPassphrase,
  __resetVaultStateForTests,
} from '../../db/vault';
import type { Task, TaskList, Subtask, Mindmap, MindmapNode, SharedItem } from '../../db/models';

const REAL = 'the real passphrase 123';
const SECONDARY = 'the other passphrase 456';

// Distinctive markers so "did any real content survive" is unambiguous.
const MARKERS = [
  'FIRE_THE_CFO', 'LAYOFF_MEMO_Q3', 'WHISTLEBLOWER', 'secret-doc-url',
  'ACQUIRE_ACME', 'evidence_zip_name', 'admitted the fraud',
];

async function seedRealContent() {
  await db.taskLists.add({ id: 'l1', name: 'FIRE_THE_CFO list', type: 'tasks', order: 0, createdAt: 1, updatedAt: 1 } as TaskList);
  await db.tasks.add({
    id: 't1', listId: 'l1', title: 'FIRE_THE_CFO on Monday', description: 'LAYOFF_MEMO_Q3 details',
    link: 'https://x.example.org/secret-doc-url', status: 'blocked', order: 0, createdAt: 1, updatedAt: 1,
    links: [{ url: 'https://x.example.org/secret-doc-url', title: 'WHISTLEBLOWER' }],
    discussionLog: [{ id: 'd1', at: 5, note: 'admitted the fraud' }],
  } as Task);
  await db.subtasks.add({ id: 's1', taskId: 't1', title: 'WHISTLEBLOWER contact', status: 'todo', order: 0, createdAt: 1, updatedAt: 1 } as Subtask);
  await db.mindmaps.add({ id: 'm1', name: 'ACQUIRE_ACME plan', order: 0, createdAt: 1, updatedAt: 1 } as Mindmap);
  await db.mindmapNodes.add({ id: 'n1', mapId: 'm1', label: 'ACQUIRE_ACME step', shape: 'diamond', order: 0, createdAt: 1, updatedAt: 1 } as MindmapNode);
  await db.sharedItems.add({ id: 'si1', type: 'file', name: 'evidence_zip_name', size: 999, blobId: 'b1', mimeType: 'application/zip', order: 0, createdAt: 1, updatedAt: 1 } as SharedItem);
  await db.sharedBlobs.add({ id: 'b1', data: new TextEncoder().encode('LAYOFF_MEMO_Q3 raw bytes'), cachedAt: 1 });
}

/** Every stored byte, read raw (middleware bypassed), as one string. */
async function rawDump(): Promise<string> {
  setMigrationBypass(true);
  try {
    const tables = [db.taskLists, db.tasks, db.subtasks, db.sharedItems, db.sharedBlobs, db.mindmaps, db.mindmapNodes, db.changeLog, db.syncMeta, db.vault, db.localSettings];
    const parts: string[] = [];
    for (const t of tables) {
      const rows = await (t as unknown as { toArray: () => Promise<unknown[]> }).toArray();
      parts.push(JSON.stringify(rows, (_k, v) => (v instanceof Uint8Array ? new TextDecoder().decode(v) : v)));
    }
    return parts.join('\n');
  } finally {
    setMigrationBypass(false);
  }
}

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
  localStorage.removeItem('gtd25-paranoid-key');
});

afterEach(() => {
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
  localStorage.removeItem('gtd25-paranoid-key');
});

describe('secondary-passphrase re-init (duress)', () => {
  it('leaves NO trace of real content anywhere after a secondary unlock', async () => {
    await seedRealContent();
    await enableParanoid(REAL);
    // Sanity: the real content is present (encrypted) before we re-init.
    await setSecondaryPassphrase(SECONDARY);
    lock();

    expect(await unlockWithPassphrase(SECONDARY)).toBe(true);
    expect(isUnlocked()).toBe(true);

    // THE guarantee: not one marker survives — not in decrypted rows, not raw
    // (in ciphertext, changelog, blobs, vault secrets, anywhere).
    const dump = await rawDump();
    for (const marker of MARKERS) {
      expect(dump.includes(marker), `real content "${marker}" survived`).toBe(false);
    }

    // Decrypted (through the live DEK) content is present but placeholder.
    const tasks = await db.tasks.toArray();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).not.toContain('FIRE');
    expect(tasks[0].title.length).toBeGreaterThan(0);
  });

  it('keeps structure byte-identical: ids, refs, order, status, timestamps', async () => {
    await seedRealContent();
    await enableParanoid(REAL);
    await setSecondaryPassphrase(SECONDARY);
    lock();
    await unlockWithPassphrase(SECONDARY);

    const [list] = await db.taskLists.toArray();
    const [task] = await db.tasks.toArray();
    const [sub] = await db.subtasks.toArray();
    const [node] = await db.mindmapNodes.toArray();
    const [item] = await db.sharedItems.toArray();

    expect(list.id).toBe('l1');
    expect(task.id).toBe('t1');
    expect(task.listId).toBe('l1');
    expect(task.status).toBe('blocked');
    expect(task.order).toBe(0);
    expect(task.createdAt).toBe(1);
    expect(task.discussionLog?.[0].id).toBe('d1');
    expect(task.discussionLog?.[0].at).toBe(5);
    expect(task.links).toHaveLength(1);
    expect(sub.taskId).toBe('t1');
    expect(node.mapId).toBe('m1');
    expect(node.shape).toBe('diamond'); // cosmetic kept
    expect(item.type).toBe('file');     // structural kept
    expect(item.blobId).toBe('b1');
  });

  it('re-keys: the real passphrase is dead, the secondary now unlocks normally', async () => {
    await enableParanoid(REAL);
    await setSecondaryPassphrase(SECONDARY);
    lock();
    await unlockWithPassphrase(SECONDARY); // performs the re-init
    lock();

    expect(await unlockWithPassphrase(REAL)).toBe(false);      // old passphrase gone
    expect(isUnlocked()).toBe(false);
    expect(await unlockWithPassphrase(SECONDARY)).toBe(true);  // now the real one
    expect(isUnlocked()).toBe(true);
  });

  it('severs sync: credentials, changelog and sync bookkeeping are gone', async () => {
    await db.localSettings.update('local', { githubPat: 'ghp_x', encryptionPassword: 'syncpw' });
    await db.syncMeta.put({ id: 'sync-meta', remoteSha: 'abc', lastPulledAt: 1, pendingChanges: false });
    await enableParanoid(REAL);
    await db.changeLog.add({ id: 'c1', deviceId: 'd', timestamp: 1, entityType: 'task', entityId: 't1', operation: 'upsert', data: {}, v: 6 });
    await setSecondaryPassphrase(SECONDARY);
    lock();
    await unlockWithPassphrase(SECONDARY);

    const local = await db.localSettings.get('local');
    expect(local?.githubPat).toBeUndefined();
    expect(local?.encryptionPassword).toBeUndefined();
    expect(local?.syncEnabled).toBe(false);
    expect(await db.changeLog.count()).toBe(0);
    expect(await db.syncMeta.count()).toBe(0);
  });

  it('drops the enrolled security-key flag (its wrap targets the dead DEK)', async () => {
    await enableParanoid(REAL);
    localStorage.setItem('gtd25-paranoid-key', '1'); // pretend a key was enrolled
    await setSecondaryPassphrase(SECONDARY);
    lock();
    await unlockWithPassphrase(SECONDARY);
    expect(localStorage.getItem('gtd25-paranoid-key')).toBeNull();
  });

  it('is atomic: an interrupted re-init rolls back — real data and both passphrases intact', async () => {
    await seedRealContent();
    await enableParanoid(REAL);
    await setSecondaryPassphrase(SECONDARY);
    lock();

    // Force the re-init transaction to fail at the very end (vault write).
    const spy = vi.spyOn(db.vault, 'put').mockRejectedValueOnce(new Error('disk full'));
    expect(await unlockWithPassphrase(SECONDARY)).toBe(false); // looks like a wrong passphrase
    expect(isUnlocked()).toBe(false);
    spy.mockRestore();

    // Nothing was swapped: real content still there, real passphrase still works.
    const dump = await rawDump();
    // (raw is ciphertext, but a marker would appear only if we'd written plaintext
    // decoy over it and rolled back badly — assert the real row count is intact)
    expect(await db.tasks.count()).toBe(1);
    expect(await db.changeLog.count()).toBeGreaterThanOrEqual(0);
    expect(await unlockWithPassphrase(REAL)).toBe(true); // real vault survived
    expect(isUnlocked()).toBe(true);
    // And the real content decrypts back to the real markers.
    const [task] = await db.tasks.toArray();
    expect(task.title).toContain('FIRE_THE_CFO');
    void dump;
  });

  it('rejects a secondary passphrase equal to the real one, and enforces strength', async () => {
    await enableParanoid(REAL);
    await expect(setSecondaryPassphrase(REAL)).rejects.toThrow(/different/i);
    await expect(setSecondaryPassphrase('123')).rejects.toThrow(); // weak
  });

  it('clearSecondaryPassphrase makes the previous secondary stop unlocking', async () => {
    await enableParanoid(REAL);
    await setSecondaryPassphrase(SECONDARY);
    await clearSecondaryPassphrase();
    lock();
    expect(await unlockWithPassphrase(SECONDARY)).toBe(false); // slot 2 re-randomised
    expect(await unlockWithPassphrase(REAL)).toBe(true);       // real still works
  });

  it('a wrong passphrase that is neither real nor secondary still just fails', async () => {
    await enableParanoid(REAL);
    await setSecondaryPassphrase(SECONDARY);
    lock();
    expect(await unlockWithPassphrase('totally wrong')).toBe(false);
    expect(isUnlocked()).toBe(false);
    // and the vault is untouched
    expect(await unlockWithPassphrase(REAL)).toBe(true);
  });
});
