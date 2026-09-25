// Group G of the GUI review: keyboard and accessibility — where the caret lands
// in dialogs, what d/b/n do where they shouldn't, a blank search, names for the
// icon-only buttons, and focus after closing Discussed. Real keyboard on the
// production build.
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { MAIN_PASSPHRASE, appShell, createList, dialogTitled, enableParanoid, openApp, openSettings } from './helpers';

async function createFollowUpList(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Create new list' }).click();
  const input = page.getByPlaceholder('List name');
  await input.fill(name);
  await page.getByRole('button', { name: 'Follow-ups', exact: true }).click();
  await input.press('Enter');
  await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
}

const followUpCard = (page: Page, title: string): Locator =>
  page.locator('[data-focus-id]').filter({ hasText: title }).filter({ has: page.getByRole('button', { name: 'Discussed' }) });

/** Move the keyboard ring onto `card` with h/l/j, the way a keyboard user would. */
async function ringOnto(page: Page, card: Locator): Promise<void> {
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('Escape');
  await page.keyboard.press('h');
  await page.keyboard.press('l');
  for (let i = 0; i < 10; i++) {
    if (/ring-2/.test((await card.getAttribute('class')) ?? '')) return;
    await page.keyboard.press('j');
  }
  await expect(card).toHaveClass(/ring-2/);
}

// Reported by the review, not reproduced: Chromium's showModal() already puts
// the caret in the first field. Kept as a guard — these dialogs are typed into.
test('dialogs that need typing put the caret in their field', async ({ page }) => {
  await openApp(page);
  await appShell(page).getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = dialogTitled(page, 'Settings');
  await settings.getByRole('button', { name: 'Backups', exact: true }).click();
  await settings.getByRole('button', { name: 'Wipe All Data', exact: true }).click();
  await expect(page.getByPlaceholder('Type "yes" to confirm')).toBeFocused();
  await page.getByRole('button', { name: 'Cancel', exact: true }).last().click();
  await settings.getByRole('button', { name: 'Close', exact: true }).first().click();

  await enableParanoid(page, MAIN_PASSPHRASE);
  const security = await openSettings(page, 'Security');
  const hotkey = security.getByRole('checkbox', { name: /Instant-lock hotkey/ });
  await hotkey.click(); // on (free)
  await hotkey.click(); // off: asks for the passphrase
  await expect(page.getByPlaceholder('Vault passphrase')).toBeFocused();
});

test('d asks before resolving a follow-up, and b leaves it alone', async ({ page }) => {
  await openApp(page);
  await createFollowUpList(page, 'People');
  await page.getByRole('button', { name: 'Add a follow-up' }).click();
  await page.getByPlaceholder('Task title').fill('Call Ana');
  await page.getByPlaceholder('Task title').press('Enter');
  const card = followUpCard(page, 'Call Ana');
  await expect(card).toBeVisible();

  await ringOnto(page, card);
  await page.keyboard.press('b');
  await page.keyboard.press('d');
  const question = page.getByRole('dialog').filter({ hasText: 'Resolve this follow-up?' });
  await expect(question).toBeVisible();
  await question.getByRole('button', { name: 'Cancel' }).click();
  await expect(card).toBeVisible();
  // Nothing blocked: Attention only shows up when something needs it.
  await expect(appShell(page).getByRole('button', { name: /Attention/ })).toHaveCount(0);

  await page.keyboard.press('d');
  await question.getByRole('button', { name: 'Resolve' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Resolved (1)' })).toBeVisible();
});

test('n in Focus leaves no form behind in the next list', async ({ page }) => {
  await openApp(page);
  await page.keyboard.press('n'); // in Focus: nothing to add a task to
  await createList(page, 'Errands');
  await expect(page.getByPlaceholder('Task title')).toHaveCount(0);
});

test('a search of only spaces hides nothing', async ({ page }) => {
  await openApp(page);
  await createList(page, 'Errands');
  await page.locator('[data-search-input]').fill('   ');
  await expect(appShell(page).locator('nav [data-focus-id]').filter({ hasText: 'Errands' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Errands' })).toBeVisible();
});

test('icon-only buttons have names, and Escape from Discussed returns to its button', async ({ page }) => {
  await openApp(page);
  await createList(page, 'Errands');
  await expect(appShell(page).getByRole('button', { name: 'List options' }).first()).toBeAttached();

  await createFollowUpList(page, 'People');
  await page.getByRole('button', { name: 'Add a follow-up' }).click();
  await page.getByPlaceholder('Task title').fill('Call Ana');
  await page.getByPlaceholder('Task title').press('Enter');
  const discussed = followUpCard(page, 'Call Ana').getByRole('button', { name: 'Discussed' });
  await discussed.click();
  await expect(page.getByPlaceholder('What came of it?')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByPlaceholder('What came of it?')).toHaveCount(0);
  await expect(discussed).toBeFocused();

  await appShell(page).getByRole('button', { name: 'Mindmaps' }).click();
  await page.getByRole('button', { name: 'New map', exact: true }).click();
  await page.getByPlaceholder('Name').fill('Plan');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeVisible();
  await page.locator('[data-mindmap-node]').filter({ hasText: 'Plan' }).click();
  await expect(page.getByRole('button', { name: 'Add child (Tab)' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit (F2 / double-tap)' })).toBeVisible();
});
