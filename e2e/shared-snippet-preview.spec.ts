// Shared Folder text snippets: read in a preview and copied with one press,
// without downloading them. Real UI on the production build.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { appShell, openApp } from './helpers';

const TEXT = 'Line one\n<b>stays literal</b> — ñ';

/**
 * A snippet as an upload leaves it: the item row plus its bytes in the local
 * blob cache (plaintext with Paranoid off). Seeded straight into IndexedDB —
 * the fake GitHub has no git-refs API for the blob branch — so the preview
 * reads the cache and never needs the network.
 */
async function seedSnippet(page: Page, text: string): Promise<void> {
  await page.evaluate(async (content) => {
    const settle = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const db = await settle(indexedDB.open('gtd25'));
    try {
      const bytes = new TextEncoder().encode(content);
      const now = Date.now();
      const tx = db.transaction(['sharedItems', 'sharedBlobs'], 'readwrite');
      tx.objectStore('sharedItems').put({
        id: 'snip-1', type: 'snippet', name: 'Meeting notes', size: bytes.length, blobId: 'blob-1',
        mimeType: 'text/plain', order: 0, createdAt: now, updatedAt: now,
      });
      tx.objectStore('sharedBlobs').put({ id: 'blob-1', data: bytes, cachedAt: now });
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    } finally {
      db.close();
    }
  }, text);
}

test('a snippet opens in a preview and copies, from the preview or straight from its card', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openApp(page);
  await seedSnippet(page, TEXT);
  await page.reload();
  await appShell(page).getByRole('button', { name: /^Shared/ }).click();
  const name = page.getByRole('button', { name: 'Meeting notes', exact: true });

  let downloaded = false;
  page.on('download', () => { downloaded = true; });

  await name.click();
  const text = page.getByTestId('snippet-text');
  await expect(text).toHaveText(TEXT, { useInnerText: true });
  await expect(text.locator('b')).toHaveCount(0);
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(TEXT);
  await page.keyboard.press('Escape');
  await expect(text).toHaveCount(0);

  await page.evaluate(() => navigator.clipboard.writeText('something else'));
  await name.hover();
  await page.getByRole('button', { name: 'Copy text', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(TEXT);
  expect(downloaded).toBe(false);
});
