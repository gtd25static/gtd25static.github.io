// Group D of the GUI review: layout on a phone and at the edges of the screen —
// what the quick-capture button covered, menus that opened off-screen, the
// drawer at launch, a new mindmap node's editor off-screen, long labels.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { appShell, createList, createTask, openApp } from './helpers';

const PHONE = { viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true };
const fab = (page: Page) => page.getByRole('button', { name: 'Quick capture', exact: true });

test.describe('on a phone', () => {
  test.use(PHONE);

  test('the app opens on Focus, not behind the drawer, and a new list closes the drawer', async ({ page }) => {
    await openApp(page);
    await expect(page.getByRole('heading', { level: 1, name: 'Focus' })).toBeVisible();
    expect((await appShell(page).boundingBox())!.x).toBeLessThan(0); // drawer closed

    await page.getByRole('button', { name: 'Open sidebar' }).click();
    await page.getByRole('button', { name: 'Create new list' }).click();
    await page.getByPlaceholder('List name').fill('Errands');
    await page.getByPlaceholder('List name').press('Enter');
    await expect(page.getByRole('heading', { level: 2, name: 'Errands' })).toBeVisible();
    await expect.poll(async () => (await appShell(page).boundingBox())!.x).toBeLessThan(0);
  });

  test('while selecting, the quick-capture button is out of the way of the bulk bar', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Open sidebar' }).click();
    await createList(page, 'Chores');
    await createTask(page, 'Wash the car');
    await page.getByRole('heading', { level: 2 }).locator('..').getByRole('button').first().click();
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await expect(fab(page)).toHaveCount(0);
    await expect(fab(page)).toHaveCount(0);
  });

  test('a new mindmap node\'s editor is on screen, and a long label stays inside its node', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Open sidebar' }).click();
    await appShell(page).getByRole('button', { name: 'Mindmaps' }).click();
    await page.getByRole('button', { name: 'New map', exact: true }).click();
    await page.getByPlaceholder('Name').fill('Plan');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    const root = page.locator('[data-mindmap-node]').first();
    await expect(root).toBeVisible();
    for (let depth = 0; depth < 3; depth++) {
      await page.locator('[data-mindmap-node]').last().tap();
      // The node action buttons are SVG <g>s named by their <title>.
      await page.locator('svg g').filter({ has: page.locator('title', { hasText: 'Add child (Tab)' }) }).last().tap();
      const editor = page.locator('[data-mindmap-node] textarea');
      await expect(editor).toBeVisible();
      await expect.poll(async () => {
        const box = (await editor.boundingBox())!;
        return box.x >= 0 && box.x + Math.min(box.width, 100) <= 390;
      }, { message: 'the editor is on screen' }).toBe(true);
      await editor.fill(depth === 2 ? 'x'.repeat(300) : `Level ${depth}`);
      await editor.press('Enter');
    }
    const overflow = await page.locator('[data-mindmap-node]').last().evaluate((node) => {
      const label = node.firstElementChild as HTMLElement;
      return label.scrollWidth - label.clientWidth;
    });
    expect(overflow, 'a 300-character word wraps inside its node').toBeLessThanOrEqual(1);
  });
});

test('the last lists\' menu opens on screen, and toasts sit above the quick-capture button', async ({ page }) => {
  await page.setViewportSize({ width: 1470, height: 600 });
  await openApp(page);
  for (let i = 1; i <= 18; i++) await createList(page, `List ${String(i).padStart(2, '0')}`);
  const last = appShell(page).locator('nav [data-focus-id]').filter({ hasText: 'List 18' });
  await last.scrollIntoViewIfNeeded();
  await last.hover();
  await last.getByRole('button').last().click();
  const del = page.getByRole('button', { name: 'Delete', exact: true });
  const box = (await del.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(600);
  await del.click();
  await page.getByRole('button', { name: 'Delete', exact: true }).last().click(); // confirm
  const toast = page.getByText('List deleted');
  await expect(toast).toBeVisible();
  const t = (await toast.boundingBox())!;
  const f = (await fab(page).boundingBox())!;
  expect(t.y + t.height, 'toast above the button').toBeLessThanOrEqual(f.y);
});

test('the last Shared Folder card\'s Delete can be reached past the quick-capture button', async ({ page }) => {
  await page.setViewportSize({ width: 1470, height: 600 });
  await openApp(page);
  await appShell(page).getByRole('button', { name: /^Shared/ }).click();
  for (let i = 1; i <= 10; i++) {
    await page.evaluate((n) => {
      const data = new DataTransfer();
      data.setData('text/plain', `https://example.com/link-${n}`);
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
    }, i);
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    await expect(page.getByText(`example.com/link-${i}`).first()).toBeVisible();
  }
  // Scrolled all the way down, the last card's Delete must not sit under the button.
  await page.evaluate(() => document.querySelectorAll('.overflow-y-auto').forEach((el) => { el.scrollTop = el.scrollHeight; }));
  await page.waitForTimeout(200);
  const covered = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button[aria-label="Delete"]')];
    const last = buttons.sort((a, b) => a.getBoundingClientRect().bottom - b.getBoundingClientRect().bottom).at(-1)!;
    const r = last.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !(hit === last || last.contains(hit));
  });
  expect(covered, 'the last card\'s Delete is under the quick-capture button').toBe(false);
});
