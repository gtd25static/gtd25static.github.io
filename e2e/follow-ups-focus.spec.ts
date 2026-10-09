// Group E of the GUI review: follow-ups (no recurrence, Attention resolves them,
// "Sort by date", the custom snooze), Focus filling up at once, and a capture
// keeping its angle brackets. Real UI on the production build.
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { appShell, createList, createTask, openApp } from './helpers';

async function createFollowUpList(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Create new list' }).click();
  const input = page.getByPlaceholder('List name');
  await input.fill(name);
  await page.getByRole('button', { name: 'Follow-ups', exact: true }).click();
  await input.press('Enter');
  await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
}

/** Add a follow-up through the list's inline form, optionally with a due date (yyyy-mm-dd). */
async function addFollowUp(page: Page, title: string, dueDate?: string): Promise<void> {
  await page.getByRole('button', { name: 'Add a follow-up' }).click();
  const input = page.getByPlaceholder('Task title');
  await input.fill(title);
  if (dueDate) {
    await page.getByText(/^\+ description, link, due date/).click();
    await page.getByLabel('Due date').fill(dueDate);
  }
  await input.press('Enter');
  await expect(followUpCard(page, title)).toBeVisible();
}

/** The follow-up card itself (its title also shows in the "Ready to discuss" banner). */
const followUpCard = (page: Page, title: string): Locator =>
  page.locator('[data-focus-id]').filter({ hasText: title }).filter({ has: page.getByRole('button', { name: 'Discussed' }) });

const cardTitles = (page: Page, titles: readonly string[]): Promise<string[]> =>
  page.locator('[data-focus-id]').filter({ has: page.getByRole('button', { name: 'Discussed' }) }).evaluateAll(
    (cards, known) => cards.map((card) => known.find((t) => card.textContent?.includes(t)) ?? '?'),
    titles,
  );

/** A local calendar date `days` from today, as a date input takes it. */
function localDate(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

async function openMenu(page: Page, card: Locator, item: string): Promise<void> {
  await card.hover();
  await card.locator('[data-dropdown-trigger]').last().click();
  await page.locator('[data-dropdown-menu]').getByRole('button', { name: item, exact: true }).click();
}

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

test('a follow-up can\'t be made to recur, and Attention resolves it instead of marking it done', async ({ page }) => {
  await openApp(page);
  await createFollowUpList(page, 'People');

  await page.getByRole('button', { name: 'Add a follow-up' }).click();
  await page.getByText(/^\+ description, link, due date/).click();
  await expect(page.getByLabel('Due date')).toBeVisible();
  await expect(page.getByText('Recurring', { exact: true })).toHaveCount(0);
  await page.getByPlaceholder('Task title').fill('Call Ana');
  await page.getByPlaceholder('Task title').press('Enter');
  const card = followUpCard(page, 'Call Ana');
  await expect(card).toBeVisible();

  await openMenu(page, card, 'Edit');
  const editor = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Save' }) });
  await expect(editor.getByLabel('Due date')).toBeVisible();
  await expect(editor.getByText('Recurring', { exact: true })).toHaveCount(0);
  await editor.getByRole('button', { name: 'Cancel' }).click();

  await openMenu(page, card, 'Warn');
  await appShell(page).getByRole('button', { name: /Attention/ }).click();
  const row = page.locator('div.group').filter({ hasText: 'Call Ana' });
  await expect(row.getByRole('button', { name: 'Done' })).toHaveCount(0);
  await row.getByRole('button', { name: 'Resolve' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Resolve' }).click();
  await expect(row).toHaveCount(0);

  await appShell(page).locator('nav [data-focus-id]').filter({ hasText: 'People' }).locator(':scope > button').click();
  await expect(page.getByRole('button', { name: 'Resolved (1)' })).toBeVisible();
  await expect(followUpCard(page, 'Call Ana')).toHaveCount(0);
});

test('"Sort by date" orders follow-ups by due date, and dragging is refused while it\'s on', async ({ page }) => {
  await openApp(page);
  await createFollowUpList(page, 'People');
  await addFollowUp(page, 'Later', localDate(5));
  await addFollowUp(page, 'Sooner', localDate(1));
  await addFollowUp(page, 'Undated');
  const titles = ['Later', 'Sooner', 'Undated'];
  const manual = await cardTitles(page, titles);

  const header = page.getByRole('heading', { level: 2, name: 'People' }).locator('xpath=ancestor::div[contains(@class,"justify-between")][1]');
  await header.locator('[data-dropdown-trigger]').click();
  await page.getByRole('button', { name: 'Sort by date', exact: true }).click();
  await expect.poll(() => cardTitles(page, titles)).toEqual(['Sooner', 'Later', 'Undated']);

  await dragOnto(page, followUpCard(page, 'Undated').locator('.cursor-grab').first(), followUpCard(page, 'Sooner'));
  await expect(page.getByText(/Turn off “Sort by date” to rearrange/)).toBeVisible();
  expect(await cardTitles(page, titles)).toEqual(['Sooner', 'Later', 'Undated']);

  await header.locator('[data-dropdown-trigger]').click();
  await page.getByRole('button', { name: 'Sort by date ✓', exact: true }).click();
  await expect.poll(() => cardTitles(page, titles)).toEqual(manual); // the refused drag changed nothing
});

test('a click on a follow-up opens its log: notes go in without snoozing, the two newest show, the rest behind "Show more"', async ({ page }) => {
  await openApp(page);
  await createFollowUpList(page, 'People');
  await addFollowUp(page, 'Ping Bob');
  await addFollowUp(page, 'Ping Eve');
  const bob = followUpCard(page, 'Ping Bob');
  const box = bob.getByPlaceholder('What was discussed?');

  await bob.getByText('Ping Bob').click();
  for (const note of ['first chat', 'second chat', 'third chat']) {
    await box.fill(note);
    await box.press('Enter');
    await expect(bob.getByText(note)).toBeVisible();
  }
  await expect(bob.getByText('first chat')).toHaveCount(0);
  await bob.getByRole('button', { name: 'Show more (1)' }).click();
  await expect(bob.getByText('first chat')).toBeVisible();
  // Logging never snoozes: nothing went to the snoozed pile.
  await expect(page.getByRole('button', { name: /Show snoozed/ })).toHaveCount(0);

  // Another click on the card closes it; the History chip opens it again.
  await bob.getByText('Ping Bob').click();
  await expect(box).toHaveCount(0);
  await page.reload();
  await page.locator('aside nav [data-focus-id]').filter({ hasText: 'People' }).locator(':scope > button').click();
  await expect(page.getByRole('heading', { level: 2, name: 'People', exact: true })).toBeVisible();
  await bob.getByRole('button', { name: 'History · 3', exact: true }).click();
  await expect(bob.getByText('third chat')).toBeVisible();
  await expect(bob.getByText('second chat')).toBeVisible();
  await bob.getByRole('button', { name: 'History · 3', exact: true }).click();
  await expect(box).toHaveCount(0);

  // Reordering by the handle is a drag, not a click: no log opens.
  await dragOnto(page, followUpCard(page, 'Ping Eve').locator('.cursor-grab').first(), bob);
  await expect(page.getByPlaceholder('What was discussed?')).toHaveCount(0);
});

test('a custom snooze is remembered: the card says "every 11d" and Discussed reopens on that date', async ({ page }) => {
  await openApp(page);
  await createFollowUpList(page, 'People');
  await addFollowUp(page, 'Ping Bob');

  await followUpCard(page, 'Ping Bob').getByRole('button', { name: 'Discussed' }).click();
  await page.getByRole('button', { name: 'custom', exact: true }).click();
  await page.locator('input[type="date"]').fill(localDate(11));
  await page.getByRole('button', { name: 'Snooze', exact: true }).click();

  await page.getByRole('button', { name: /Show snoozed \(1\)/ }).click();
  const card = followUpCard(page, 'Ping Bob');
  await expect(card.getByText('every 11d')).toBeVisible();
  await card.getByRole('button', { name: 'Discussed' }).click();
  await expect(page.getByRole('button', { name: 'custom', exact: true })).toHaveClass(/bg-indigo-600/);
  await expect(page.locator('input[type="date"]')).toHaveValue(localDate(11));
});

test.describe('in Madrid just after midnight', () => {
  test.use({ timezoneId: 'Europe/Madrid' });

  test('the earliest custom snooze date is tomorrow, not today', async ({ page }) => {
    await page.clock.install({ time: new Date('2026-09-25T22:30:00Z') }); // 00:30 on the 26th there
    await openApp(page);
    await createFollowUpList(page, 'People');
    await addFollowUp(page, 'Ping Bob');
    await followUpCard(page, 'Ping Bob').getByRole('button', { name: 'Discussed' }).click();
    await page.getByRole('button', { name: 'custom', exact: true }).click();
    await expect(page.locator('input[type="date"]')).toHaveAttribute('min', '2026-09-27');
  });
});

test('Focus is ready on a fresh install and replaces a deleted focus task at once', async ({ page }) => {
  // Its maintenance also runs once a minute: everything here has to happen
  // well before that, because the data changed.
  const soon = { timeout: 10_000 };
  await openApp(page);
  await expect(page.getByText('Nothing to focus on')).toBeVisible(soon);

  await createList(page, 'Work');
  for (let i = 0; i < 4; i++) await createTask(page, `Focus task ${i}`);
  await appShell(page).getByRole('button', { name: /^Focus/ }).first().click();
  const shown = page.getByText(/^Focus task \d$/);
  await expect(shown).toHaveCount(3);
  const before = await shown.allTextContents();

  const card = page.locator('div.cursor-pointer').filter({ hasText: before[0] });
  await card.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();

  await expect(page.getByText(before[0], { exact: true })).toHaveCount(0);
  await expect(shown).toHaveCount(3, soon);
});

test('a capture keeps the text between "<" and ">"', async ({ page }) => {
  await page.goto(`/?capture&title=${encodeURIComponent('Check a<b and c>d')}`);
  await expect(page.getByText('Captured to Inbox')).toBeVisible();
  await appShell(page).getByRole('button', { name: /^Inbox/ }).click();
  await expect(page.getByText('Check a<b and c>d', { exact: true })).toBeVisible();
});

// QoL review (2026-10-08), batch A: a follow-up list keeps its view, a "go to"
// lands on the card shown and open, the keyboard walks what's on screen, and a
// snoozed topic comes back on its own when it wakes.

const listRow = (page: Page, name: string): Locator =>
  appShell(page).locator('nav [data-focus-id]').filter({ hasText: name });

test('a snoozed follow-up found by search is on screen with its log open, and the list keeps its view', async ({ page }) => {
  await openApp(page);
  await createFollowUpList(page, 'People');
  await addFollowUp(page, 'Ping Bob');
  await addFollowUp(page, 'Ping Eve');
  await followUpCard(page, 'Ping Bob').getByRole('button', { name: 'Discussed' }).click();
  await page.getByRole('button', { name: 'Snooze', exact: true }).click();
  await expect(followUpCard(page, 'Ping Bob')).toHaveCount(0);

  await page.locator('[data-search-input]').fill('Bob');
  await page.locator('button[data-redact]').filter({ hasText: 'Ping Bob' }).click();
  const bob = followUpCard(page, 'Ping Bob');
  await expect(bob).toBeVisible();
  await expect(bob.getByPlaceholder('What was discussed?')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hide snoozed (1)' })).toBeVisible();

  // Leaving the list and coming back keeps "Show snoozed" on.
  await createList(page, 'Work');
  await listRow(page, 'People').locator(':scope > button').click();
  await expect(followUpCard(page, 'Ping Bob')).toBeVisible();
});

test('j/k walk only the follow-ups on screen: a hidden snoozed one is skipped', async ({ page }) => {
  await openApp(page);
  await createFollowUpList(page, 'People');
  await addFollowUp(page, 'Ping Bob');
  await addFollowUp(page, 'Ping Eve');
  await addFollowUp(page, 'Ping Ann');
  await followUpCard(page, 'Ping Eve').getByRole('button', { name: 'Discussed' }).click();
  await page.getByRole('button', { name: 'Snooze', exact: true }).click();
  await expect(followUpCard(page, 'Ping Eve')).toHaveCount(0);

  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('Escape');
  await page.keyboard.press('h');
  await page.keyboard.press('l');
  // From "Add a follow-up": Ann, then Bob, then nothing further (Eve is hidden).
  for (let i = 0; i < 3; i++) await page.keyboard.press('j');
  await expect(followUpCard(page, 'Ping Bob')).toHaveClass(/ring-2/);
  await expect(followUpCard(page, 'Ping Ann')).not.toHaveClass(/ring-2/);
});

test('"Stalest first" puts the topic left longest first, says how long each has been idle, and is remembered', async ({ page }) => {
  await openApp(page);
  await createFollowUpList(page, 'People');
  await addFollowUp(page, 'Old topic');
  await addFollowUp(page, 'New topic');
  const titles = ['Old topic', 'New topic'];
  expect(await cardTitles(page, titles)).toEqual(['New topic', 'Old topic']);

  const fresh = followUpCard(page, 'New topic');
  await fresh.getByText('New topic').click();
  await fresh.getByPlaceholder('What was discussed?').fill('talked just now');
  await fresh.getByPlaceholder('What was discussed?').press('Enter');
  await expect(fresh.getByText('talked just now')).toBeVisible();

  const stalest = page.getByRole('button', { name: 'Stalest first', exact: true });
  await stalest.click();
  await expect(stalest).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => cardTitles(page, titles)).toEqual(['Old topic', 'New topic']);
  await expect(followUpCard(page, 'Old topic').getByText(/^idle \d+m$/)).toBeVisible();

  // Discussed, then Unsnooze: still handled just now, so it goes after the other.
  const old = followUpCard(page, 'Old topic');
  await old.getByRole('button', { name: 'Discussed' }).click();
  await page.getByRole('button', { name: 'Snooze', exact: true }).click();
  await page.getByRole('button', { name: /show snoozed/i }).click();
  await followUpCard(page, 'Old topic').getByRole('button', { name: /^Unsnooze/ }).click();
  await expect(followUpCard(page, 'Old topic').getByRole('button', { name: /^Unsnooze/ })).toHaveCount(0);
  await expect.poll(() => cardTitles(page, titles)).toEqual(['New topic', 'Old topic']);

  // Kept on this device, for every follow-up list.
  await page.reload();
  await expect(appShell(page)).toBeVisible();
  await listRow(page, 'People').locator(':scope > button').click();
  await expect(page.getByRole('button', { name: 'Stalest first', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => cardTitles(page, titles)).toEqual(['New topic', 'Old topic']);
});

test('a snoozed topic comes back on its own when it wakes, and the sidebar counts the awake ones', async ({ page }) => {
  await page.clock.install();
  await openApp(page);
  await createFollowUpList(page, 'People');
  await addFollowUp(page, 'Ping Bob');
  await addFollowUp(page, 'Ping Eve');
  const count = listRow(page, 'People').locator(':scope > button span.text-xs');
  await expect(count).toHaveText('2');

  await followUpCard(page, 'Ping Bob').getByRole('button', { name: 'Discussed' }).click();
  await page.getByRole('button', { name: '20h', exact: true }).click();
  await page.getByRole('button', { name: 'Snooze', exact: true }).click();
  await expect(followUpCard(page, 'Ping Bob')).toHaveCount(0);
  await expect(count).toHaveText('1');
  await expect(count).toHaveAttribute('title', '1 awake · 1 snoozed');

  await page.clock.fastForward('20:01:00');
  await expect(followUpCard(page, 'Ping Bob')).toBeVisible();
  await expect(count).toHaveText('2');
});

// QoL review (2026-10-08), batch B: the logbook — what the closed card tells,
// a note that isn't lost, notes logged back to back, and finding what was said.

test('the closed card tells what was said last; an unsent note waits for you; quick notes are all kept', async ({ page }) => {
  await openApp(page);
  await createFollowUpList(page, 'People');
  await addFollowUp(page, 'Budget Q4');
  const card = followUpCard(page, 'Budget Q4');
  const box = card.getByPlaceholder('What was discussed?');

  await card.getByText('Budget Q4').click();
  await expect(box).toBeFocused(); // opened with the mouse: ready to type
  // Back to back, without waiting for the first to show: the second used to drop it.
  await box.fill('Finance wants the breakdown');
  await box.press('Enter');
  await box.fill('Sent it\nwaiting for sign-off');
  await box.press('Enter');
  await expect(card.getByText('Finance wants the breakdown')).toBeVisible();
  await expect(card.getByText(/Sent it/)).toBeVisible();
  await expect(card.getByRole('heading', { name: 'Discussion log · 2' })).toBeVisible();

  await box.fill('half a thought');
  await card.getByText('Budget Q4').click(); // closed with the note unsent
  await expect(card.getByText('Unsent note')).toBeVisible();
  await expect(card.getByText('Sent it', { exact: true })).toBeVisible(); // the last note's first line
  await expect(card.getByText('just now')).toBeVisible();
  await expect(card.getByRole('button', { name: 'History · 2' })).toBeVisible();

  await createList(page, 'Work');
  await listRow(page, 'People').locator(':scope > button').click();
  await followUpCard(page, 'Budget Q4').getByText('Budget Q4').click();
  await expect(followUpCard(page, 'Budget Q4').getByPlaceholder('What was discussed?')).toHaveValue('half a thought');
});

test('what was said is found: by the list filter, and by search with an excerpt of the note', async ({ page }) => {
  await openApp(page);
  await createFollowUpList(page, 'People');
  await addFollowUp(page, 'Budget Q4');
  await addFollowUp(page, 'Onboarding');
  const card = followUpCard(page, 'Budget Q4');
  await card.getByText('Budget Q4').click();
  await card.getByPlaceholder('What was discussed?').fill('Finance wants the breakdown by department');
  await card.getByPlaceholder('What was discussed?').press('Enter');
  await expect(card.getByText(/breakdown by department/)).toBeVisible();

  await page.getByPlaceholder('Filter…').fill('department');
  await expect(followUpCard(page, 'Budget Q4')).toBeVisible();
  await expect(followUpCard(page, 'Onboarding')).toHaveCount(0);
  await page.getByPlaceholder('Filter…').fill('');

  await page.locator('[data-search-input]').fill('department');
  const result = page.locator('button[data-redact]').filter({ hasText: 'Budget Q4' });
  await expect(result).toContainText('breakdown by department');
  await expect(result).not.toContainText('todo');
});
