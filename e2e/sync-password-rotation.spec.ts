// Changing the sync password re-encrypts the whole repository. These run a real
// rotation on the production build against the fake GitHub, with a second device:
// the progress dialog must cover everything and hold the page open while it runs,
// the other device must ask for the new password and keep every item, and a tab
// killed half-way — before or after the point of no return — must finish cleanly
// when the new password is saved again.
import type { Browser, BrowserContext, Page, Route } from '@playwright/test';
import { test, expect } from './fixtures';
import type { FakeGitHub } from './fake-github';
import {
  SYNC_PASSWORD, appShell, closeSettings, configureSync, createList, createTask, dialogTitled, findMarkers,
  openApp, openList, openSettings, taskCards,
} from './helpers';

const NEW_PASSWORD = 'harbor velvet 91 frosty lantern orbit';
const LIST = 'Rotation list secret';
const TASKS = ['Rotation task one secret', 'Rotation task two secret'];

const progressDialog = (page: Page) => page.getByRole('dialog', { name: 'Changing the sync password' });

async function seedAndLink(page: Page, github: FakeGitHub): Promise<void> {
  await openApp(page);
  await createList(page, LIST);
  for (const title of TASKS) await createTask(page, title);
  await configureSync(page, github);
  await closeSettings(page);
  await expect.poll(() => github.readText('gtd25-snapshot.json')?.length ?? 0, { timeout: 60_000 }).toBeGreaterThan(0);
  await expect.poll(() => github.readText('gtd25-changelog.json') ?? '', { timeout: 60_000 }).toBe('[]');
}

async function newDevice(browser: Browser, github: FakeGitHub): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  await github.install(context);
  const page = await context.newPage();
  await openApp(page);
  return { context, page };
}

/** Settings → General: type a new sync password, Save, and confirm the change. */
async function startRotation(page: Page, password = NEW_PASSWORD): Promise<void> {
  const dialog = await openSettings(page, 'General');
  const section = dialog.getByRole('heading', { name: 'GitHub Sync', exact: true }).locator('..');
  await section.getByLabel('Encryption Password', { exact: true }).fill(password);
  // Asked only when the password differs from the stored one (after the commit
  // point of an interrupted change, the stored one already IS the new one).
  const confirm = section.getByLabel('Confirm Password', { exact: true });
  if (await confirm.isVisible()) await confirm.fill(password);
  await section.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
}

/**
 * Hold requests matching `match` unanswered until release() — a network stalled
 * at one exact step. With `autoReleaseMs`, each is let through after that long:
 * the app aborts any GitHub request after 15 s, so a longer hold would fail the
 * rotation instead of pausing it.
 */
async function stallRequests(
  context: BrowserContext,
  match: (method: string, path: string) => boolean,
  autoReleaseMs?: number,
) {
  const held: Route[] = [];
  let released = false;
  const letThrough = (route: Route) => route.fallback().catch(() => { /* page or request gone */ });
  await context.route('https://api.github.com/**', async (route) => {
    const url = new URL(route.request().url());
    if (released || !match(route.request().method(), url.pathname)) { await route.fallback(); return; }
    held.push(route);
    if (autoReleaseMs) setTimeout(() => { if (held.includes(route)) { held.splice(held.indexOf(route), 1); void letThrough(route); } }, autoReleaseMs);
  });
  return {
    held,
    release: async () => {
      released = true;
      for (const route of held.splice(0)) await letThrough(route);
    },
  };
}

// Step 3 (shared files) always starts by reading the blob branch's ref: after the
// new key is pinned, before the snapshot — the last step before the point of no
// return. Step 5 starts by looking up the old migration backups: after it.
const isBlobBranchRef = (method: string, path: string) => method === 'GET' && path.includes('/git/ref/heads/');
const isMigrationBackupLookup = (method: string, path: string) => method === 'GET' && /gtd25-snapshot-v\d+\.backup\.json$/.test(path);

async function expectRealContent(page: Page): Promise<void> {
  await expect(appShell(page).getByText(LIST)).toBeVisible({ timeout: 90_000 });
  await openList(page, LIST);
  for (const title of TASKS) await expect(taskCards(page).filter({ hasText: title })).toBeVisible();
}

/** The second device's next sync must ask for the new password, then show everything. */
async function joinWithNewPassword(page: Page): Promise<void> {
  const prompt = page.getByRole('dialog').filter({ hasText: 'Encryption Password Required' });
  await expect(async () => {
    if (!(await prompt.isVisible())) {
      const dialog = await openSettings(page, 'General');
      await dialog.getByRole('button', { name: 'Sync Now', exact: true }).click();
      await closeSettings(page);
    }
    await expect(prompt).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 90_000 });
  await prompt.getByPlaceholder('Enter encryption password').fill(NEW_PASSWORD);
  await prompt.getByRole('button', { name: 'Unlock' }).click();
  await expect(prompt).toBeHidden({ timeout: 60_000 });
  await expectRealContent(page);
}

function expectRepoRotated(github: FakeGitHub, oldSalt: string): void {
  const snapshot = JSON.parse(github.readText('gtd25-snapshot.json')!);
  expect(snapshot.encryptionSalt, 'new salt on the snapshot').not.toBe(oldSalt);
  const dump = Object.values(github.repoContents()).map((b) => Buffer.from(b, 'base64').toString('utf8')).join('\n');
  expect(dump.includes(oldSalt), 'no file still carries the old salt').toBe(false);
  expect(findMarkers(dump, [LIST, ...TASKS]), 'no plaintext content on the remote').toEqual([]);
}

test('the rotation covers the screen, holds the page open, and the other device follows with every item', async ({ page, context, browser, github }) => {
  test.setTimeout(420_000);
  await seedAndLink(page, github);
  const other = await newDevice(browser, github);
  await configureSync(other.page, github);
  await closeSettings(other.page);
  await expectRealContent(other.page);
  const oldSalt = JSON.parse(github.readText('gtd25-snapshot.json')!).encryptionSalt as string;

  // Pause the rotation at the shared-files step (< 15 s, see stallRequests), to look at it mid-way.
  const stall = await stallRequests(context, isBlobBranchRef, 9_000);
  await startRotation(page);
  await expect(progressDialog(page)).toBeVisible();
  await expect.poll(() => stall.held.length, { timeout: 90_000 }).toBeGreaterThan(0);
  await expect(progressDialog(page).locator('li[data-state="current"]')).toContainText('Re-encrypting shared files');
  await expect(progressDialog(page).locator('li[data-state="done"]')).toHaveCount(1);

  // Nothing behind it can be used, and Escape doesn't dismiss it.
  const settingsClose = dialogTitled(page, 'Settings').getByRole('button', { name: 'Close', exact: true });
  await expect(settingsClose.click({ timeout: 1_500 })).rejects.toThrow();
  await page.keyboard.press('Escape');
  await expect(progressDialog(page)).toBeVisible();

  // Closing the tab asks first (we stay).
  const prompts: string[] = [];
  page.on('dialog', (d) => { prompts.push(d.type()); void d.dismiss(); });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => prompts).toEqual(['beforeunload']);
  expect(page.isClosed()).toBe(false);

  await stall.release();
  await expect(page.getByText(/Sync password changed/)).toBeVisible({ timeout: 120_000 });
  await expect(progressDialog(page)).toBeHidden();
  expectRepoRotated(github, oldSalt);

  await joinWithNewPassword(other.page);
  await other.context.close();
});

for (const when of ['before', 'after'] as const) {
  test(`a tab killed mid-rotation (${when} the point of no return) finishes when the password is saved again`, async ({ page, context, browser, github }) => {
    test.setTimeout(480_000);
    await seedAndLink(page, github);
    const oldSalt = JSON.parse(github.readText('gtd25-snapshot.json')!).encryptionSalt as string;

    const stall = await stallRequests(context, when === 'before' ? isBlobBranchRef : isMigrationBackupLookup);
    await startRotation(page);
    await expect.poll(() => stall.held.length, { timeout: 120_000 }).toBeGreaterThan(0);
    if (when === 'after') {
      expect(JSON.parse(github.readText('gtd25-snapshot.json')!).encryptionSalt, 'past the commit point').not.toBe(oldSalt);
    } else {
      expect(JSON.parse(github.readText('gtd25-snapshot.json')!).encryptionSalt, 'before the commit point').toBe(oldSalt);
    }
    await page.close({ runBeforeUnload: false }); // the tab dies
    await stall.release();

    const reopened = await context.newPage();
    await openApp(reopened);
    const dialog = await openSettings(reopened, 'General');
    await expect(dialog.getByText('A sync password change did not finish.')).toBeVisible({ timeout: 60_000 });
    await startRotation(reopened);
    await expect(reopened.getByText(/Sync password changed/)).toBeVisible({ timeout: 120_000 });
    await expect(progressDialog(reopened)).toBeHidden();
    await expect(dialog.getByText('A sync password change did not finish.')).toBeHidden();
    expectRepoRotated(github, oldSalt);
    await closeSettings(reopened);
    await expectRealContent(reopened);

    // A fresh device opens the repository with the new password only.
    const fresh = await newDevice(browser, github);
    await configureSync(fresh.page, github, NEW_PASSWORD);
    await closeSettings(fresh.page);
    await expectRealContent(fresh.page);
    await fresh.context.close();
    expect(SYNC_PASSWORD).not.toBe(NEW_PASSWORD);
  });
}
