// `fieldTimestamps` used to ride along in the clear (SYNC_VERSION ≤ 6). Its KEYS
// are the record's field names — including the encrypted ones — and its values
// are when each last changed, so a backend reader (and a disk image of a LOCKED
// Paranoid device) learned which encrypted fields exist per record and when each
// was edited. v7 moves it inside the blob.
//
// The compatibility cases matter as much as the property itself: devices update
// at different times, and a v6 row must keep merging correctly on a v7 client.
import { deriveKey, generateSalt, encryptEntity, decryptEntity, SENSITIVE_FIELDS } from '../../sync/crypto';
import { runRemoteMigrations } from '../../sync/migrations';
import { SYNC_VERSION } from '../../sync/version';
import { mergeEntity } from '../../sync/field-timestamps';
import type { SyncData } from '../../db/models';

let key: CryptoKey;
beforeAll(async () => { key = await deriveKey('sync password for v7', generateSalt()); });

const task = () => ({
  id: 't1', listId: 'l1', status: 'todo', order: 0, createdAt: 1, updatedAt: 9,
  title: 'REAL TITLE', description: 'REAL BODY',
  discussionLog: [{ id: 'd1', at: 5, text: 'REAL NOTE' }],
  fieldTimestamps: { title: 7, description: 8, discussionLog: 9, status: 2 },
});

describe('fieldTimestamps is encrypted (v7)', () => {
  it('is on every entity type’s sensitive list', () => {
    for (const [entity, fields] of Object.entries(SENSITIVE_FIELDS)) {
      expect(fields, `${entity} must hide its field timestamps`).toContain('fieldTimestamps');
    }
  });

  it('leaves no trace of the encrypted field names or their edit times on the wire', async () => {
    const enc = await encryptEntity(key, task(), 'task');

    expect(enc.fieldTimestamps).toBeUndefined();
    const wire = JSON.stringify(enc);
    expect(wire).not.toContain('title');        // the field NAME, not just its value
    expect(wire).not.toContain('discussionLog');
    expect(wire).not.toContain('REAL TITLE');
    // Metadata the doc does declare as plaintext is still there for merging.
    expect(enc.listId).toBe('l1');
    expect(enc.updatedAt).toBe(9);
  });

  it('round-trips, so per-field merge still works', async () => {
    const enc = await encryptEntity(key, task(), 'task');
    const dec = await decryptEntity(key, enc, 'task');
    expect(dec.fieldTimestamps).toEqual(task().fieldTimestamps);
    expect(dec._enc).toBeUndefined();
  });
});

describe('a v6 device and a v7 device in the same install', () => {
  it('reads a v6 row, whose timestamps are still top-level plaintext', async () => {
    // What a v6 client wrote: everything but fieldTimestamps inside the blob.
    const v6Fields = SENSITIVE_FIELDS.task.filter((f) => f !== 'fieldTimestamps');
    const t = task();
    const sensitive = Object.fromEntries(v6Fields.map((f) => [f, (t as Record<string, unknown>)[f]]));
    const legacy: Record<string, unknown> = {
      ...Object.fromEntries(Object.entries(t).filter(([k]) => !v6Fields.includes(k))),
      _enc: (await encryptEntity(key, { id: t.id, ...sensitive }, 'task'))._enc,
    };
    expect(legacy.fieldTimestamps).toBeTruthy(); // the old plaintext copy

    const dec = await decryptEntity(key, legacy, 'task');

    expect(dec.title).toBe('REAL TITLE');
    expect(dec.fieldTimestamps).toEqual(t.fieldTimestamps); // preserved, not lost
  });

  it('merges a v6 record against a v7 record without dropping either side', () => {
    const local = { ...task(), title: 'LOCAL', fieldTimestamps: { title: 100, description: 1 } };
    const remote = { ...task(), description: 'REMOTE', fieldTimestamps: { title: 1, description: 200 } };

    const merged = mergeEntity(local, remote, 200) as Record<string, unknown>;

    expect(merged.title).toBe('LOCAL');         // newer locally
    expect(merged.description).toBe('REMOTE');  // newer remotely
  });

  it('migrates a v6 snapshot to v7 without touching a single record', () => {
    const rows = [task()];
    const data = {
      syncVersion: 6, taskLists: [], tasks: rows, subtasks: [],
      settings: { theme: 'system' as const },
    } as unknown as SyncData;

    const migrated = runRemoteMigrations(data, 6, SYNC_VERSION);

    expect(migrated.syncVersion).toBe(7);
    expect(migrated.tasks).toBe(rows); // same reference: nothing rewritten
  });
});
