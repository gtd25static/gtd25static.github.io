// Group I (after the GUI review): Focus leaves the Inbox alone, and the keyboard
// ring no longer stops on the blocked-task banner, which is no longer shown.
// Real UI on the production build.
import { test, expect } from './fixtures';
import { appShell, createList, createTask, openApp, taskCards } from './helpers';

test('Focus never picks raw captures from the Inbox', async ({ page }) => {
  for (let i = 1; i <= 3; i++) {
    await page.goto(`/?capture&title=${encodeURIComponent(`Capture ${i}`)}`);
    await expect(page.getByText('Captured to Inbox').first()).toBeVisible();
  }
  await createList(page, 'Work');
  await createTask(page, 'Real task');

  await appShell(page).getByRole('button', { name: /^Focus/ }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Focus' })).toBeVisible();
  await expect(page.getByText('Real task', { exact: true })).toBeVisible();
  await expect(page.locator('main, body').getByText(/^Capture \d$/)).toHaveCount(0);
});

test('with a task blocked, k from "Add a task" goes nowhere invisible', async ({ page }) => {
  await openApp(page);
  await createList(page, 'Work');
  await createTask(page, 'Stuck');
  const card = taskCards(page).filter({ hasText: 'Stuck' });
  await card.getByText('Stuck').click({ button: 'right' });
  await page.locator('body > div.fixed').getByRole('button', { name: 'Block', exact: true }).click(); // the context menu

  await page.keyboard.press('Escape');
  await page.keyboard.press('h');
  await page.keyboard.press('l'); // onto "Add a task", the first thing in the list
  const add = page.getByRole('button', { name: 'Add a task' });
  await expect(add).toHaveClass(/ring-2/);
  await page.keyboard.press('k'); // nothing above it on screen
  await expect(add).toHaveClass(/ring-2/);
  await page.keyboard.press('j');
  await expect(card).toHaveClass(/ring-2/);
});
