// The Inbox's "Process" menu lists every other list. With many lists it came out
// as wide as the screen (its items were inline buttons, so its natural width was
// all of them side by side) and, too tall for the room below, it was pushed up
// over its own button. Now it is as wide as its longest list name, opens under
// the button and scrolls when the lists do not fit.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { appShell, createList } from './helpers';

const LISTS = 14;
const PHONE = { viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true };

async function inboxWithManyLists(page: Page, { phone }: { phone: boolean }): Promise<void> {
  for (let i = 1; i <= 6; i++) {
    await page.goto(`/?capture&title=${encodeURIComponent(`Capture ${i}`)}`);
    await expect(page.getByText('Captured to Inbox').first()).toBeVisible();
  }
  for (let i = 1; i <= LISTS; i++) {
    if (phone) await page.getByRole('button', { name: 'Open sidebar' }).click();
    await createList(page, `List number ${i}`);
  }
  if (phone) await page.getByRole('button', { name: 'Open sidebar' }).click();
  await appShell(page).getByRole('button', { name: /^Inbox/ }).click();
  await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
}

/** Open the nth card's Process menu and check it sits under its button, sized to its lists. */
async function openProcessMenu(page: Page, nth: number) {
  const trigger = page.getByRole('button', { name: 'Task options' }).nth(nth);
  await trigger.click();
  const menu = page.locator('[data-dropdown-menu]');
  await expect(menu).toBeVisible();
  const button = (await trigger.boundingBox())!;
  const box = (await menu.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.width).toBeLessThanOrEqual(320); // the names' width, not the screen's
  expect(box.y).toBeGreaterThanOrEqual(button.y + button.height); // under the button, not over it
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  expect(Math.abs(box.x + box.width - (button.x + button.width))).toBeLessThan(1); // right edges aligned
  return menu;
}

async function processLastList(page: Page, nth: number): Promise<void> {
  const menu = await openProcessMenu(page, nth);
  // Scrolling the menu to reach the last list must not close it.
  await menu.getByRole('button', { name: `List number ${LISTS}`, exact: true }).click();
  await expect(page.getByText(`Moved to List number ${LISTS}`)).toBeVisible();
}

test('on a desktop, the Process menu sits under its button and fits its lists', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await inboxWithManyLists(page, { phone: false });
  await openProcessMenu(page, 0);
  await page.keyboard.press('Escape');
  await processLastList(page, 3);
});

test.describe('on a phone', () => {
  test.use(PHONE);

  test('the Process menu sits under its button and fits its lists', async ({ page }) => {
    await inboxWithManyLists(page, { phone: true });
    await openProcessMenu(page, 0);
    await page.keyboard.press('Escape');
    await processLastList(page, 3);
  });
});
