// Group H of the GUI review: small things — a completed task coming back to
// the active list after an edit, "Tomorrow" on the day the clocks change, drops
// onto an archived list, and "Send to list" without feedback. Real UI on the
// production build.
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { appShell, createList, createTask, openApp, openList, taskCards } from './helpers';

const sidebarRow = (page: Page, name: string): Locator =>
  appShell(page).locator('nav [data-focus-id]').filter({ hasText: name });

/** Press on the drag handle, move past the 5px activation distance, then drop on the target. */
async function dragOnto(page: Page, handle: Locator, target: Locator): Promise<void> {
  const from = (await handle.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
  await page.mouse.up();
}

test('editing a task completed long ago keeps it in Completed', async ({ page }) => {
  await page.clock.install();
  await openApp(page);
  await createList(page, 'Errands');
  await createTask(page, 'Buy milk');
  await taskCards(page).filter({ hasText: 'Buy milk' }).getByRole('button', { name: 'Mark complete' }).click();
  await page.clock.fastForward('01:05'); // past the minute a done task stays in view
  const completed = page.getByRole('button', { name: /^Completed \(1\)/ });
  await expect(completed).toBeVisible();

  await completed.click();
  await taskCards(page).filter({ hasText: 'Buy milk' }).getByText('Buy milk').dblclick();
  const input = page.locator('[data-task-id] input').first();
  await input.fill('Buy oat milk');
  await input.press('Enter');
  await expect(taskCards(page).filter({ hasText: 'Buy oat milk' })).toBeVisible();
  await page.clock.fastForward('00:02');
  await expect(completed).toBeVisible(); // still "Completed (1)": not back among the active tasks
});

test.describe('in Madrid on the day the clocks go back', () => {
  test.use({ timezoneId: 'Europe/Madrid' });

  test('a task due the next day says "Tomorrow"', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-10-25T08:00:00Z') }); // 09:00 on the 25th there
    await openApp(page);
    await createList(page, 'Errands');
    await page.getByRole('button', { name: 'Add a task' }).click();
    await page.getByPlaceholder('Task title').fill('Return the drill');
    await page.getByText(/^\+ description, link, due date/).click();
    await page.getByLabel('Due date').fill('2026-10-26');
    await page.getByPlaceholder('Task title').press('Enter');
    await expect(taskCards(page).filter({ hasText: 'Return the drill' }).getByText('Tomorrow')).toBeVisible();
  });
});

test('a task dropped on an archived list stays where it was', async ({ page }) => {
  await openApp(page);
  await createList(page, 'Old');
  await createList(page, 'Work');
  await createTask(page, 'Keep me here');
  const old = sidebarRow(page, 'Old');
  await old.hover();
  await old.getByRole('button', { name: 'List options' }).click();
  await page.locator('[data-dropdown-menu]').getByRole('button', { name: 'Archive', exact: true }).click();
  await appShell(page).getByRole('button', { name: /Archived/ }).click();
  await expect(sidebarRow(page, 'Old')).toBeVisible();

  const card = taskCards(page).filter({ hasText: 'Keep me here' });
  await dragOnto(page, card.locator('.cursor-grab').first(), sidebarRow(page, 'Old'));
  await expect(page.getByText('Moved to Old')).toHaveCount(0);
  await expect(card).toBeVisible();
});

test('"Send to list" says where the task went, and Undo brings it back', async ({ page }) => {
  await openApp(page);
  await createList(page, 'Personal');
  await createList(page, 'Work');
  await createTask(page, 'First');
  await createTask(page, 'Second');
  await createTask(page, 'Third');
  const titles = () => taskCards(page).allInnerTexts().then((all) => all.map((t) => t.split('\n').find((l) => /First|Second|Third/.test(l))));
  const before = await titles();

  await taskCards(page).filter({ hasText: 'Second' }).getByText('Second').click({ button: 'right' });
  await page.getByRole('button', { name: 'Send to list' }).hover();
  await page.locator('body > div.fixed').getByRole('button', { name: 'Personal', exact: true }).click();
  await expect(page.getByText('Moved to Personal')).toBeVisible();
  await expect(taskCards(page).filter({ hasText: 'Second' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(taskCards(page).filter({ hasText: 'Second' })).toBeVisible();
  await expect.poll(titles).toEqual(before);
  await openList(page, 'Personal');
  await expect(taskCards(page)).toHaveCount(0);
});
