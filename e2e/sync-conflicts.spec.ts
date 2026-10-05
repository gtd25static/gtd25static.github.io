// The conflict manager on the production build, two devices on the fake GitHub:
// the same task title changed on both before either synced the other's change
// shows "1 conflict" on BOTH devices; nothing blocks (the newer title is shown);
// a pick on one device travels as an edit and closes the conflict on the other.
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import type { FakeGitHub } from './fake-github';
import { closeSettings, configureSync, createList, createTask, dialogTitled, openApp, openList, openSettings, taskCards } from './helpers';

const LIST = 'Conflict list';

async function newDevice(browser: Browser, github: FakeGitHub): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  await github.install(context);
  const page = await context.newPage();
  await openApp(page);
  return { context, page };
}

async function rename(page: Page, from: string, to: string): Promise<void> {
  await taskCards(page).filter({ hasText: from }).getByText(from).dblclick();
  const input = page.locator('[data-task-id] input').first();
  await input.fill(to);
  await input.press('Enter');
  await expect(taskCards(page).filter({ hasText: to })).toBeVisible();
}

async function syncNow(page: Page): Promise<void> {
  const dialog = await openSettings(page, 'General');
  await dialog.getByRole('button', { name: 'Sync Now', exact: true }).click();
  await closeSettings(page);
}

const conflictsButton = (page: Page) => page.getByRole('button', { name: /sync conflict/ }).filter({ visible: true });

test('the same title changed on two devices shows on both, and one pick settles both', async ({ page, browser, github }) => {
  await openApp(page);
  await createList(page, LIST);
  await createTask(page, 'Shared task');
  await configureSync(page, github);
  await closeSettings(page);
  await expect.poll(() => github.readText('gtd25-changelog.json') ?? '', { timeout: 60_000 }).toBe('[]');

  const other = await newDevice(browser, github);
  await configureSync(other.page, github);
  await closeSettings(other.page);
  await openList(other.page, LIST, { timeout: 60_000 });
  await expect(taskCards(other.page).filter({ hasText: 'Shared task' })).toBeVisible({ timeout: 60_000 });

  // The phone is offline when it renames; the laptop renames and pushes.
  await other.context.setOffline(true);
  await rename(other.page, 'Shared task', 'Title from B');
  await rename(page, 'Shared task', 'Title from A');
  await syncNow(page);
  await expect.poll(() => github.readText('gtd25-changelog.json') ?? '[]', { timeout: 60_000 }).not.toBe('[]');

  // Back online the phone pulls the laptop's rename — concurrent with its own.
  await other.context.setOffline(false);
  await expect(conflictsButton(other.page)).toBeVisible({ timeout: 60_000 });
  // The laptop pulls the phone's and sees it too. Nothing blocked: the newer title shows on both.
  await syncNow(page);
  await expect(conflictsButton(page)).toBeVisible({ timeout: 60_000 });
  await expect(taskCards(page).filter({ hasText: 'Title from A' })).toBeVisible();
  await expect(taskCards(other.page).filter({ hasText: 'Title from A' })).toBeVisible({ timeout: 60_000 });

  // On the phone: keep its own title after all.
  await conflictsButton(other.page).click();
  const dialog = dialogTitled(other.page, 'Sync conflicts');
  await expect(dialog.getByRole('listitem').getByText('Title from B').first()).toBeVisible();
  await expect(dialog.getByText('Another device · showing now')).toBeVisible();
  await dialog.getByRole('button', { name: 'Keep this device’s' }).click();
  await expect(dialog.getByText('No conflicts.')).toBeVisible();
  await other.page.keyboard.press('Escape');
  await expect(taskCards(other.page).filter({ hasText: 'Title from B' })).toBeVisible();

  // The pick reaches the laptop as an edit and closes the conflict there.
  await syncNow(other.page);
  await expect.poll(async () => {
    await syncNow(page);
    return taskCards(page).filter({ hasText: 'Title from B' }).count();
  }, { timeout: 90_000 }).toBeGreaterThan(0);
  await expect(conflictsButton(page)).toHaveCount(0, { timeout: 60_000 });
  await other.context.close();
});
