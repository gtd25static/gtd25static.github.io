// Threat-model review, batch 1: what someone holding the PAT — backend write
// access, no sync password (Scenario 7) — could make a Paranoid device do, on
// the production build against the fake GitHub. Before the fix, one forged
// changelog entry made the device keep a record's real content in PLAINTEXT on
// disk, silently, and broke re-key and the secondary passphrase on it.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  MAIN_PASSPHRASE, closeSettings, configureSync, createList, createTask, dumpDeviceStorage, enableParanoid,
  findMarkers, lock, openApp, openSettings, readSyncSettings, taskCards, unlock,
} from './helpers';

const MARKER = 'ZEBRA_SECRET_TITLE';

async function syncNow(page: Page): Promise<void> {
  const dialog = await openSettings(page, 'General');
  await dialog.getByRole('button', { name: 'Sync Now', exact: true }).click();
  await expect(page.getByText(/Sync complete|Initial sync complete|Synced from remote/).first()).toBeVisible({ timeout: 60_000 });
  await closeSettings(page);
}

test('a forged `_enc` in the changelog cannot make a Paranoid device store content in plaintext', async ({ page, github }) => {
  test.setTimeout(300_000);
  await openApp(page);
  await createList(page, 'Work');
  await createTask(page, `${MARKER} for Monday`);
  await enableParanoid(page, MAIN_PASSPHRASE);
  await closeSettings(page);
  await configureSync(page, github, undefined, { vaultPassphrase: MAIN_PASSPHRASE });
  await closeSettings(page);
  await expect.poll(() => github.readText('gtd25-snapshot.json')?.length ?? 0, { timeout: 60_000 }).toBeGreaterThan(0);

  // The attacker reads the task's id (plaintext metadata) and appends one upsert.
  const snapshot = JSON.parse(github.readText('gtd25-snapshot.json')!) as { tasks: Array<{ id: string; listId: string }> };
  const changelog = JSON.parse(github.readText('gtd25-changelog.json') ?? '[]') as Array<Record<string, unknown>>;
  const fromChangelog = changelog.filter((e) => e.entityType === 'task').map((e) => ({ id: e.entityId as string, listId: (e.data as { listId: string }).listId }));
  const target = snapshot.tasks[0] ?? fromChangelog[0];
  expect(target, 'the task reached the repository').toBeTruthy();
  changelog.push({
    id: 'forged-entry', deviceId: 'attacker-device', timestamp: Date.now(), entityType: 'task', entityId: target.id,
    operation: 'upsert', v: 8,
    data: { id: target.id, listId: target.listId, title: 'x', status: 'todo', order: 0, createdAt: 1, updatedAt: 1, _enc: 1, fieldTimestamps: { _enc: 9e15 } },
  });
  github.writeText('gtd25-changelog.json', JSON.stringify(changelog));

  await syncNow(page);
  await expect(taskCards(page).filter({ hasText: MARKER })).toBeVisible(); // still reads its own task
  await lock(page);
  expect(findMarkers(await dumpDeviceStorage(page), [MARKER]), 'real content in plaintext on the locked disk').toEqual([]);
  expect(await unlock(page, MAIN_PASSPHRASE)).toBe(true);
});

test('on a Paranoid device the sync settings never show the saved PAT or sync password', async ({ page, github }) => {
  test.setTimeout(240_000);
  await openApp(page);
  await enableParanoid(page, MAIN_PASSPHRASE);
  await closeSettings(page);
  await configureSync(page, github, undefined, { vaultPassphrase: MAIN_PASSPHRASE });
  await closeSettings(page);

  const sync = await readSyncSettings(page);
  expect(sync.token).toBe('');
  expect(sync.password).toBe('');
  expect(sync.tokenSaved).toBe(true);
  expect(sync.passwordSaved).toBe(true);
  expect(await page.content(), 'the PAT anywhere in the page').not.toContain(github.token);
});
