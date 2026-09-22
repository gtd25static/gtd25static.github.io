// Moving an item to a list of the OTHER type, by dragging it onto the sidebar or
// through the right-click menu: a task becomes a follow-up and back again.
// Drives dnd-kit and the hover submenu with a real pointer, which jsdom can't,
// on the production build.
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { createList, createTask, openApp, openList, taskCards } from './helpers';

const TITLE = 'Call the plumber about the leak';

async function createFollowUpList(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Create new list' }).click();
  const input = page.getByPlaceholder('List name');
  await input.fill(name);
  await page.getByRole('button', { name: 'Follow-ups', exact: true }).click();
  await input.press('Enter');
  await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
}

/** A list entry in the open right-click submenu (the menu is portaled to <body>, outside the sidebar). */
const submenuItem = (page: Page, name: string): Locator =>
  page.locator('body > div.fixed').getByRole('button', { name, exact: true });

/** The follow-up card itself (its title also shows in the "Ready to discuss" banner). */
const followUpCard = (page: Page, title: string): Locator =>
  page.locator('[data-focus-id]').filter({ hasText: title }).filter({ has: page.getByRole('button', { name: 'Discussed' }) });

const sidebarList = (page: Page, name: string): Locator =>
  page.locator('aside nav [data-focus-id]').filter({ hasText: name });

/** Press on the drag handle, move past the 5px activation distance, then drop on the target. */
async function dragOnto(page: Page, handle: Locator, target: Locator): Promise<void> {
  const from = await handle.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('drag source or target not on screen');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2 + 10, { steps: 5 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 20 });
  await page.mouse.up();
}

test('a task dragged onto a follow-up list becomes a follow-up, and drags back', async ({ page }) => {
  await openApp(page);
  await createFollowUpList(page, 'People');
  await createList(page, 'Work');
  await createTask(page, TITLE);

  // Task list -> follow-up list
  const taskHandle = taskCards(page).filter({ hasText: TITLE }).locator('.cursor-grab').first();
  await dragOnto(page, taskHandle, sidebarList(page, 'People'));
  await expect(page.getByText('Moved to People')).toBeVisible();
  await expect(taskCards(page)).toHaveCount(0);

  // openList() waits for "Add a task"; a follow-up list says "Add a follow-up".
  await sidebarList(page, 'People').locator(':scope > button').click();
  await expect(page.getByRole('heading', { level: 2, name: 'People', exact: true })).toBeVisible();
  const followUp = followUpCard(page, TITLE);
  await expect(followUp).toBeVisible();

  // Follow-up list -> task list
  await dragOnto(page, followUp.locator('.cursor-grab').first(), sidebarList(page, 'Work'));
  await expect(page.getByText('Moved to Work')).toBeVisible();
  await expect(followUp).toHaveCount(0);

  await openList(page, 'Work');
  await expect(taskCards(page).filter({ hasText: TITLE })).toBeVisible();
});

test('a task with subtasks is refused by a follow-up list and stays put', async ({ page }) => {
  await openApp(page);
  await createFollowUpList(page, 'People');
  await createList(page, 'Work');
  await createTask(page, TITLE);

  const card = taskCards(page).filter({ hasText: TITLE });
  await card.getByText(TITLE).click(); // expand
  await page.getByRole('button', { name: 'Add subtask' }).click();
  const subtaskInput = page.getByPlaceholder('Subtask title');
  await subtaskInput.fill('Find his number');
  await subtaskInput.press('Enter');
  await expect(page.getByText('Find his number')).toBeVisible();

  await dragOnto(page, card.locator('.cursor-grab').first(), sidebarList(page, 'People'));
  await expect(page.getByText("A task with subtasks can't become a follow-up")).toBeVisible();
  await expect(card).toBeVisible();
  await expect(sidebarList(page, 'People')).not.toContainText('1');
});

test('the right-click menu sends a task to a follow-up list and back', async ({ page }) => {
  await openApp(page);
  await createFollowUpList(page, 'People');
  await createList(page, 'Work');
  await createTask(page, TITLE);

  await taskCards(page).filter({ hasText: TITLE }).getByText(TITLE).click({ button: 'right' });
  await page.getByText('Send to follow-up list').hover();
  await submenuItem(page, 'People').click();
  await expect(page.getByText('Moved to People')).toBeVisible();
  await expect(taskCards(page)).toHaveCount(0);

  await sidebarList(page, 'People').locator(':scope > button').click();
  await followUpCard(page, TITLE).getByText(TITLE).click({ button: 'right' });
  await page.getByText('Send to task list').hover();
  await submenuItem(page, 'Work').click();
  await expect(page.getByText('Moved to Work')).toBeVisible();

  await openList(page, 'Work');
  await expect(taskCards(page).filter({ hasText: TITLE })).toBeVisible();
});
