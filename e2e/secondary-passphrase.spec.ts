// Paranoid Mode's secondary (duress) passphrase, end to end on the production build.
//
// Entering the secondary passphrase must look like a normal unlock while it
// replaces every piece of real content on this device with placeholders (same
// ids/structure), re-keys the vault so only the secondary works afterwards, drops
// the sync credentials, and leaves no trace of the real content anywhere.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  MAIN_PASSPHRASE, SECONDARY_PASSPHRASE, ROTATED_PASSPHRASE, SYNC_PASSWORD,
  appShell, changePassphrase, closeSettings, configureSync, contentRowIds, createList, createTask,
  dialogTitled, dumpDeviceStorage, enableParanoid, findMarkers, hasShareStash, lock, lockHeading,
  openApp, openList, openSettings, readSyncSettings, seenText, setSecondaryPassphrase, stashShareLikeTheServiceWorker,
  taskCards, unlock, visibleText, watchForText,
} from './helpers';

// Distinctive strings that only ever appear in the REAL content.
const MARKERS = ['FIRE_THE_CFO', 'LAYOFF_MEMO_Q3'] as const;
const REAL_LIST = 'LAYOFF_MEMO_Q3 board';
const REAL_TASKS = ['FIRE_THE_CFO before the board meeting', 'Send LAYOFF_MEMO_Q3 to legal'];
const SHARE_MARKER = 'SHARE_MARKER_BOARD_LEAK';

async function seedRealContent(page: Page): Promise<void> {
  await openApp(page);
  await createList(page, REAL_LIST);
  for (const title of REAL_TASKS) await createTask(page, title);
}

async function paranoidDeviceWithSecondary(page: Page): Promise<void> {
  await seedRealContent(page);
  await enableParanoid(page, MAIN_PASSPHRASE);
  await setSecondaryPassphrase(page, SECONDARY_PASSPHRASE);
}

/** The device shows and stores the decoy: same rows as before, no marker on screen or on disk. */
async function expectDecoyWorkspace(page: Page, realIds: Record<string, string[]>): Promise<void> {
  await closeSettings(page);
  expect(await contentRowIds(page), 'content rows keep their ids/structure').toEqual(realIds);
  await openList(page, 0);
  await expect(taskCards(page)).toHaveCount(REAL_TASKS.length);
  expect(findMarkers(await visibleText(page), MARKERS), 'real-content markers on screen').toEqual([]);
  expect(findMarkers(await dumpDeviceStorage(page), MARKERS), 'real-content markers in device storage').toEqual([]);
}

/** Mark the current document; `wasReloaded` turns true once a navigation replaced it. */
async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => { (window as unknown as { __e2eMarked?: boolean }).__e2eMarked = true; });
}
async function wasReloaded(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => !(window as unknown as { __e2eMarked?: boolean }).__e2eMarked);
  } catch {
    return false; // mid-navigation: ask again
  }
}

test('A: the secondary passphrase opens a same-shaped decoy and leaves no trace of the real content', async ({ page }) => {
  await paranoidDeviceWithSecondary(page);
  const realIds = await contentRowIds(page);
  // A search left typed in: the next session must not get it back ("No results for …").
  await closeSettings(page);
  await page.getByPlaceholder('Search...').fill(MARKERS[0]);
  await lock(page, 'button');

  expect(await unlock(page, SECONDARY_PASSPHRASE), 'the secondary passphrase unlocks').toBe(true);
  await closeSettings(page);
  await expect(page.getByPlaceholder('Search...'), 'the search typed before locking').toHaveValue('');
  await expectDecoyWorkspace(page, realIds);

  await lock(page, 'hotkey');
  expect(await unlock(page, MAIN_PASSPHRASE), 'the main passphrase no longer works').toBe(false);
  expect(await unlock(page, SECONDARY_PASSPHRASE), 'the secondary is now the working passphrase').toBe(true);
  await expectDecoyWorkspace(page, realIds);
});

test('B (control): the main passphrase opens the real content', async ({ page }) => {
  await seedRealContent(page);
  // Proves the storage dump really sees content (plaintext before Paranoid Mode).
  expect(findMarkers(await dumpDeviceStorage(page), MARKERS)).toEqual([...MARKERS]);

  await enableParanoid(page, MAIN_PASSPHRASE);
  await setSecondaryPassphrase(page, SECONDARY_PASSPHRASE);
  expect.soft(findMarkers(await dumpDeviceStorage(page), MARKERS), 'content is encrypted at rest in Paranoid Mode').toEqual([]);
  await lock(page, 'hotkey');

  expect(await unlock(page, MAIN_PASSPHRASE)).toBe(true);
  await closeSettings(page);
  await openList(page, REAL_LIST);
  const text = await visibleText(page);
  for (const title of REAL_TASKS) expect(text).toContain(title);
});

test('C: after the main passphrase is changed, the secondary still opens the decoy', async ({ page }) => {
  await paranoidDeviceWithSecondary(page);
  const realIds = await contentRowIds(page);
  await changePassphrase(page, ROTATED_PASSPHRASE);
  await lock(page, 'button');

  expect(await unlock(page, SECONDARY_PASSPHRASE), 'the secondary passphrase still unlocks after a main-passphrase change').toBe(true);
  await expectDecoyWorkspace(page, realIds);

  await lock(page, 'hotkey');
  expect(await unlock(page, ROTATED_PASSPHRASE), 'the rotated main passphrase no longer works').toBe(false);
});

test('D: a share held while locked is dropped, unseen, by the secondary unlock', async ({ page }) => {
  await paranoidDeviceWithSecondary(page);
  await lock(page, 'button');
  await stashShareLikeTheServiceWorker(page, SHARE_MARKER);
  await page.reload();
  await expect(lockHeading(page)).toBeVisible();
  await expect(page.getByText('Shared content is waiting')).toBeVisible();

  const secrets = [SHARE_MARKER, 'secret.example', ...MARKERS];
  await watchForText(page, secrets);
  expect(await unlock(page, SECONDARY_PASSPHRASE)).toBe(true);

  await expect.configure({ soft: true }).poll(() => hasShareStash(page), {
    message: `the held share (Cache Storage "${'gtd25-share-v1'}") is deleted`,
    timeout: 10_000,
  }).toBe(false);
  expect.soft(await seenText(page), 'held-share / real content rendered after the secondary unlock').toEqual([]);
  await expect.soft(dialogTitled(page, 'Save shared content'), 'share destination prompt').toBeHidden();
  expect.soft(findMarkers(await dumpDeviceStorage(page), secrets), 'held-share / real content in device storage').toEqual([]);
});

test('D (control): the main passphrase offers the share held while locked', async ({ page }) => {
  await paranoidDeviceWithSecondary(page);
  await lock(page, 'button');
  await stashShareLikeTheServiceWorker(page, SHARE_MARKER);
  await page.reload();
  await expect(page.getByText('Shared content is waiting')).toBeVisible();

  expect(await unlock(page, MAIN_PASSPHRASE)).toBe(true);
  const prompt = dialogTitled(page, 'Save shared content');
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText(SHARE_MARKER);
});

test('E: a secondary unlock in another tab locks and reloads this tab, which then never shows real content', async ({ page, context }) => {
  await paranoidDeviceWithSecondary(page);
  await lock(page, 'hotkey');
  expect(await unlock(page, MAIN_PASSPHRASE)).toBe(true);
  await openList(page, REAL_LIST);
  expect(findMarkers(await visibleText(page), MARKERS), 'tab 1 shows the real content').toEqual([...MARKERS]);
  await markDocument(page);

  const tab2 = await context.newPage();
  await tab2.goto('/');
  expect(await unlock(tab2, SECONDARY_PASSPHRASE), 'tab 2 unlocks with the secondary').toBe(true);

  // Tab 1 must not keep what it held in memory under the real key: it reloads.
  await expect.poll(() => wasReloaded(page), { message: 'tab 1 reloads after the re-key', timeout: 15_000 }).toBe(true);
  await expect(lockHeading(page), 'tab 1 comes back locked').toBeVisible();
  await watchForText(page, MARKERS);
  await page.waitForTimeout(5_000); // observation window for "never shows a marker afterwards"
  expect.soft(await seenText(page), 'markers rendered in tab 1 after the other tab\'s secondary unlock').toEqual([]);
  expect(findMarkers(await visibleText(page), MARKERS), 'markers on tab 1').toEqual([]);

  // …and it opens the placeholder vault with what is now the only passphrase.
  expect(await unlock(page, SECONDARY_PASSPHRASE), 'tab 1 unlocks with the secondary').toBe(true);
  await closeSettings(page);
  await openList(page, 0);
  expect(findMarkers(await visibleText(page), MARKERS), 'markers on tab 1 after unlocking it').toEqual([]);
});

test('F: after a secondary unlock the device stays off GitHub, and re-linking sync recovers the real content', async ({ page, browser, github }) => {
  test.setTimeout(420_000);
  const DECOY_EDIT = 'COERCED_DECOY_EDIT';
  await seedRealContent(page);
  const realIds = await contentRowIds(page);

  await test.step('sync the real content to the remote', async () => {
    await configureSync(page, github);
    await expect.poll(() => realIds.tasks.every((id) => github.readText('gtd25-snapshot.json')?.includes(id) ?? false), {
      message: 'the real tasks reach gtd25-snapshot.json', timeout: 60_000,
    }).toBe(true);
    // A page's first successful sync schedules the remote backups after a 0–30 s
    // jitter. Let that one-off write land so the quiet window below measures the
    // secondary unlock, not a write scheduled before Paranoid Mode existed.
    await expect.poll(() => ['hourly', 'daily', 'weekly'].every((tier) => github.hasFile(`gtd25-backup-${tier}.json`)), {
      message: 'remote backups written', timeout: 90_000,
    }).toBe(true);
    await closeSettings(page);
  });

  await enableParanoid(page, MAIN_PASSPHRASE);
  await setSecondaryPassphrase(page, SECONDARY_PASSPHRASE);
  await lock(page, 'button');

  const remoteBefore = github.repoContents();
  const unlockStartedAt = Date.now();
  expect(await unlock(page, SECONDARY_PASSPHRASE)).toBe(true);

  await test.step('the decoy device has no sync and makes no GitHub traffic', async () => {
    // Use the decoy like a coercer would: a local edit that sync would want to push.
    await closeSettings(page);
    await openList(page, 0);
    await createTask(page, DECOY_EDIT);

    const sync = await readSyncSettings(page);
    expect(sync.token, 'PAT in the sync settings').toBe('');
    expect(sync.repo, 'repository in the sync settings').toBe('');
    expect(sync.password, 'sync password in the sync settings').toBe('');
    await closeSettings(page);

    const dump = await dumpDeviceStorage(page);
    expect(dump.includes(github.token), 'PAT anywhere in device storage').toBe(false);
    expect(dump.includes(SYNC_PASSWORD), 'sync password anywhere in device storage').toBe(false);
    expect(findMarkers(dump, MARKERS), 'real-content markers in device storage').toEqual([]);
    expect(dump.includes(github.fullName), 'sync repository name left in device storage').toBe(false);

    await page.waitForTimeout(Math.max(0, unlockStartedAt + 15_000 - Date.now()));
    expect(github.requestsSince(unlockStartedAt), 'GitHub requests since the secondary unlock').toEqual([]);
    expect(github.repoContents(), 'remote files are byte-identical').toEqual(remoteBefore);
  });

  await test.step('re-linking sync on this device brings the real content back', async () => {
    await configureSync(page, github);
    await closeSettings(page);
    await expect.poll(async () => findMarkers(await visibleText(page), MARKERS), {
      message: 'real content back on screen', timeout: 90_000,
    }).toEqual([...MARKERS]);
    for (const title of REAL_TASKS) await expect(taskCards(page).filter({ hasText: title })).toBeVisible();
    await expect.soft(appShell(page).getByText(DECOY_EDIT)).toHaveCount(0);
  });

  await test.step('the remote still holds the real data: a fresh device pulls it intact', async () => {
    const freshContext = await browser.newContext({ baseURL: test.info().project.use.baseURL });
    try {
      await github.install(freshContext);
      const fresh = await freshContext.newPage();
      await openApp(fresh);
      await configureSync(fresh, github);
      await closeSettings(fresh);
      await expect(appShell(fresh).getByText(REAL_LIST)).toBeVisible({ timeout: 90_000 });
      await openList(fresh, REAL_LIST);
      for (const title of REAL_TASKS) await expect(taskCards(fresh).filter({ hasText: title })).toBeVisible();
      await expect(taskCards(fresh)).toHaveCount(REAL_TASKS.length);
      expect(findMarkers(await visibleText(fresh), [DECOY_EDIT]), 'the decoy edit reached the remote').toEqual([]);
    } finally {
      await freshContext.close();
    }
  });
});

test('G: locking in the middle of a sync interrupts it cleanly, and the next unlock syncs normally', async ({ page, github }) => {
  test.setTimeout(420_000);
  const PENDING_EDIT = 'PENDING_EDIT_MADE_BEFORE_LOCKING';
  await seedRealContent(page);
  await configureSync(page, github);
  await expect.poll(() => ['hourly', 'daily', 'weekly'].every((tier) => github.hasFile(`gtd25-backup-${tier}.json`)), {
    message: 'first sync and its remote backups written', timeout: 120_000,
  }).toBe(true);
  await closeSettings(page);
  await enableParanoid(page, MAIN_PASSPHRASE);
  await closeSettings(page);

  // A slow network: the next sync stalls on its first request, and the vault locks meanwhile.
  const release = github.hold();
  const tasksBefore = (await contentRowIds(page)).tasks;
  await openList(page, REAL_LIST);
  await createTask(page, PENDING_EDIT);
  const pendingId = (await contentRowIds(page)).tasks.find((id) => !tasksBefore.includes(id));
  expect(pendingId, 'the new task has a row').toBeTruthy();
  // The sync indicator is rendered for both the mobile and the desktop layout.
  await page.getByTitle(/click to (sync|retry)|^Syncing/).filter({ visible: true }).first().click();
  await expect.poll(() => github.held, { message: 'a sync request is stalled on the network', timeout: 60_000 }).toBeGreaterThan(0);
  await lock(page, 'hotkey');
  release();

  await page.waitForTimeout(3_000);
  await expect(lockHeading(page), 'still locked, no error screen').toBeVisible();
  expect(findMarkers(await dumpDeviceStorage(page), [PENDING_EDIT, ...MARKERS]), 'plaintext content on disk').toEqual([]);

  // Unlocking starts a fresh sync session, which must not be blocked by the
  // interrupted one (a stuck sync lock would only clear after its 45 s timeout).
  expect(await unlock(page, MAIN_PASSPHRASE)).toBe(true);
  await expect.poll(() => github.readText('gtd25-changelog.json')?.includes(pendingId!) ?? false, {
    message: 'the edit made before locking reaches the remote', timeout: 30_000,
  }).toBe(true);
});

// --- Checking a passphrase from Settings (confirms it without using it) ---

const WRONG_PASSPHRASE = 'nothing like either passphrase here';

/** Type a passphrase into Settings → Security → "Check" and return the answer shown. */
async function checkInSettings(page: Page, passphrase: string): Promise<string> {
  const dialog = await openSettings(page, 'Security');
  const section = dialog.getByRole('heading', { name: 'Secondary passphrase', exact: true }).locator('..');
  await section.getByLabel('Passphrase to check', { exact: true }).fill(passphrase);
  await section.getByRole('button', { name: 'Check', exact: true }).click();
  const answer = page.getByText(/^(This is the secondary passphrase|This is your main passphrase|This passphrase doesn't open this vault)/);
  await expect(answer.last()).toBeVisible({ timeout: 90_000 });
  const text = (await answer.last().innerText()).trim();
  await expect(section.getByLabel('Passphrase to check', { exact: true }), 'the typed passphrase is cleared').toHaveValue('');
  return text;
}

/** The raw on-disk IndexedDB of the app (ciphertext and all), for a byte-level before/after comparison. */
async function rawAppDatabase(page: Page): Promise<unknown> {
  return (JSON.parse(await dumpDeviceStorage(page)) as { indexedDb: Record<string, unknown> }).indexedDb.gtd25;
}

test('H: checking passphrases in Settings changes nothing, and both still work afterwards', async ({ page }) => {
  await paranoidDeviceWithSecondary(page);
  const realIds = await contentRowIds(page);
  const diskBefore = await rawAppDatabase(page);
  expect(diskBefore, 'the dump sees the vault and the content').toMatchObject({ vault: expect.anything(), tasks: expect.anything() });

  expect(await checkInSettings(page, SECONDARY_PASSPHRASE)).toMatch(/^This is the secondary passphrase/);
  expect(await checkInSettings(page, MAIN_PASSPHRASE)).toBe('This is your main passphrase.');
  expect(await checkInSettings(page, WRONG_PASSPHRASE)).toBe("This passphrase doesn't open this vault.");

  expect(await rawAppDatabase(page), 'nothing on disk changed').toEqual(diskBefore);
  await expect(appShell(page), 'still unlocked').toBeVisible();
  await closeSettings(page);
  await openList(page, REAL_LIST);
  for (const title of REAL_TASKS) await expect(taskCards(page).filter({ hasText: title })).toBeVisible();

  // The main passphrase still opens the real content…
  await lock(page, 'button');
  expect(await unlock(page, MAIN_PASSPHRASE), 'the main passphrase still unlocks').toBe(true);
  await closeSettings(page);
  await openList(page, REAL_LIST);
  for (const title of REAL_TASKS) await expect(taskCards(page).filter({ hasText: title })).toBeVisible();

  // …and the secondary one, checked above, still does its job at the lock screen.
  await lock(page, 'hotkey');
  expect(await unlock(page, SECONDARY_PASSPHRASE), 'the checked secondary passphrase still unlocks').toBe(true);
  await expectDecoyWorkspace(page, realIds);
});

test('H (control): with no secondary passphrase set, checking one reads like any wrong passphrase', async ({ page }) => {
  await seedRealContent(page);
  await enableParanoid(page, MAIN_PASSPHRASE);
  expect(await checkInSettings(page, SECONDARY_PASSPHRASE)).toBe("This passphrase doesn't open this vault.");
  expect(await checkInSettings(page, MAIN_PASSPHRASE)).toBe('This is your main passphrase.');
});

test('I: the shipped bundle names none of this', async ({ page }) => {
  await openApp(page); // the webServer has just built dist/
  const dir = path.join(process.cwd(), 'dist');
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.(js|html|css|json|webmanifest)$/.test(file));
  expect(files.some((file) => file.endsWith('.js')), 'dist has scripts').toBe(true);
  const hits = files.filter((file) => /duress|decoy/i.test(readFileSync(path.join(dir, file), 'utf8')));
  expect(hits, 'telltale words in the shipped bundle').toEqual([]);
});
