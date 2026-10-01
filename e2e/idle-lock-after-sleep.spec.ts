// A Mac woken after hours asleep showed the Paranoid vault still unlocked: the
// idle re-lock was a plain timer, and timers run on a clock that stands still
// while the machine sleeps — so hours asleep counted as nothing, and the first
// click on waking (the update prompt's button) re-armed it for a full window.
// Playwright's clock reproduces exactly that: setSystemTime moves the wall clock
// without running any timer.
import { test, expect } from './fixtures';
import { MAIN_PASSPHRASE, appShell, closeSettings, createList, enableParanoid, lockHeading, openApp } from './helpers';

const HOUR = 60 * 60_000;

async function unlockedParanoidApp(page: import('@playwright/test').Page): Promise<number> {
  await page.clock.install();
  await openApp(page);
  await createList(page, 'Secret plans');
  await enableParanoid(page, MAIN_PASSPHRASE); // default 15-minute idle window
  await closeSettings(page);
  return page.evaluate(() => Date.now());
}

test('after sleeping past the idle window, the vault is locked on waking — the first click does not reopen it', async ({ page }) => {
  const now = await unlockedParanoidApp(page);
  await page.clock.setSystemTime(now + 3 * HOUR); // asleep: wall clock moves, timers don't
  await page.getByRole('heading', { level: 2, name: 'Secret plans' }).click();
  await expect(lockHeading(page)).toBeVisible();
});

test('woken with the app in front and nobody touching it, the vault locks by itself', async ({ page }) => {
  const now = await unlockedParanoidApp(page);
  await page.clock.setSystemTime(now + 3 * HOUR);
  await expect(lockHeading(page)).toBeVisible({ timeout: 10_000 });
});

test('a short pause inside the idle window keeps the vault open', async ({ page }) => {
  const now = await unlockedParanoidApp(page);
  await page.clock.setSystemTime(now + 5 * 60_000);
  await page.getByRole('heading', { level: 2, name: 'Secret plans' }).click();
  await page.waitForTimeout(1_000);
  await expect(appShell(page)).toBeVisible();
  await expect(lockHeading(page)).toHaveCount(0);
});
