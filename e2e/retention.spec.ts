// Group J (after the GUI review): gtd25 keeps work, not an archive. Tasks
// completed and follow-ups resolved over 12 months ago go to the Trash at the
// next start; everything else stays. Real app on the production build, with
// old rows put straight into IndexedDB (a year can't be waited for).
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { appShell, openApp, openList } from './helpers';

const DAY = 24 * 60 * 60 * 1000;

async function seedHistory(page: Page): Promise<void> {
  await page.evaluate(async (day) => {
    const settle = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const db = await settle(indexedDB.open('gtd25'));
    try {
      const tx = db.transaction(['taskLists', 'tasks'], 'readwrite');
      const now = Date.now();
      const lists = tx.objectStore('taskLists');
      lists.put({ id: 'work', name: 'Work', type: 'tasks', order: 0, createdAt: now, updatedAt: now });
      lists.put({ id: 'people', name: 'People', type: 'follow-ups', order: 1, createdAt: now, updatedAt: now });
      const tasks = tx.objectStore('tasks');
      const base = { status: 'todo', order: 0, createdAt: now - 800 * day, updatedAt: now - 800 * day };
      tasks.put({ ...base, id: 't-old', listId: 'work', title: 'Done last year', status: 'done', completedAt: now - 400 * day });
      tasks.put({ ...base, id: 't-recent', listId: 'work', title: 'Done in spring', status: 'done', completedAt: now - 100 * day });
      tasks.put({ ...base, id: 't-open', listId: 'work', title: 'Still to do' });
      tasks.put({ ...base, id: 'f-old', listId: 'people', title: 'Settled with Ana', archived: true, fieldTimestamps: { archived: now - 400 * day } });
      tasks.put({ ...base, id: 'f-open', listId: 'people', title: 'Ask Luis' });
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    } finally {
      db.close();
    }
  }, DAY);
}

/** Ids of the tasks IndexedDB holds as deleted, read straight from the store. */
function deletedIds(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const settle = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const db = await settle(indexedDB.open('gtd25'));
    try {
      const rows = await settle(db.transaction('tasks').objectStore('tasks').getAll()) as Array<{ id: string; deletedAt?: number }>;
      return rows.filter((t) => t.deletedAt).map((t) => t.id).sort();
    } finally {
      db.close();
    }
  });
}

test('what was finished over a year ago goes to the Trash; the rest stays', async ({ page }) => {
  await openApp(page);
  await seedHistory(page);
  await page.reload();
  await expect(appShell(page)).toBeVisible();
  // Let the startup expiry land before opening the Trash. A view whose first
  // query runs while a startup write commits can miss that write until the
  // next change (a live-query race that concerns every startup write, noted
  // separately) — this test is about what gets expired.
  await expect.poll(() => deletedIds(page), { timeout: 20_000 }).toEqual(['f-old', 't-old']);

  await appShell(page).getByRole('button', { name: 'Trash', exact: true }).click();
  const trash = page.getByRole('dialog').filter({ hasText: 'Trash' });
  await expect(trash.getByText('Done last year')).toBeVisible();
  await expect(trash.getByText('Settled with Ana')).toBeVisible();
  await expect(trash.getByText('Done in spring')).toHaveCount(0);
  await expect(trash.getByText('Still to do')).toHaveCount(0);
  await trash.getByRole('button', { name: 'Close', exact: true }).click();

  await openList(page, 'Work');
  await expect(page.getByText('Still to do')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Completed \(1\)/ })).toBeVisible();
});
