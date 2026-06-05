import { vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { enableParanoid, __resetVaultStateForTests } from '../../db/vault';
import { setMigrationBypass } from '../../db/vault-middleware';
import { clearErrorLog, getErrorLog } from '../../lib/diagnostics';
import type { Task } from '../../db/models';

const PASS = 'resilience passphrase';
const UNREADABLE = '⚠︎ unreadable';

function seed(id: string, title: string): Task {
  const now = Date.now();
  return { id, listId: 'l1', title, status: 'todo', order: 1, createdAt: now, updatedAt: now };
}

// Replace a row's on-disk _enc with garbage ciphertext (valid base64, wrong key).
async function corruptEnc(id: string): Promise<void> {
  setMigrationBypass(true);
  try {
    const raw = (await db.tasks.get(id)) as unknown as Record<string, unknown>;
    await db.tasks.put({ ...raw, _enc: btoa('x'.repeat(40)) } as unknown as Task);
  } finally {
    setMigrationBypass(false);
  }
}

beforeEach(async () => {
  await resetDb();
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
  await db.tasks.bulkAdd([seed('t1', 'good one'), seed('t2', 'will corrupt')]);
});

afterEach(() => {
  __resetVaultStateForTests();
  localStorage.removeItem('gtd25-paranoid');
});

describe('decrypt resilience', () => {
  it('quarantines a corrupt row instead of throwing, and logs it', async () => {
    await enableParanoid(PASS); // both rows encrypted at rest
    await corruptEnc('t2');
    clearErrorLog();

    // The corrupt row reads as a placeholder, not an exception.
    const t2 = await db.tasks.get('t2');
    expect(t2?.title).toBe(UNREADABLE);
    expect((t2 as unknown as { _decryptError?: boolean })._decryptError).toBe(true);
    expect(t2?.id).toBe('t2');         // metadata intact
    expect(t2?.status).toBe('todo');

    // The failure was recorded for diagnostics.
    expect(getErrorLog().some((e) => e.context.startsWith('vault-decrypt'))).toBe(true);
  });

  it('one corrupt row does not break reads of the others', async () => {
    await enableParanoid(PASS);
    await corruptEnc('t2');

    const all = await db.tasks.toArray();
    const byId = Object.fromEntries(all.map((t) => [t.id, t.title]));
    expect(byId.t1).toBe('good one');    // healthy row still readable
    expect(byId.t2).toBe(UNREADABLE);    // corrupt row quarantined
    expect(all).toHaveLength(2);
  });
});
