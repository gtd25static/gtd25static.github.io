// Mindmap search: the browser finds maps by name and, with "Node text" on, by
// a node inside them; opening such a result opens the map with that search,
// which lights up the matches and opens the collapsed branches hiding them —
// for the search only. Real UI on the production build.
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { appShell, openApp } from './helpers';

// No glide: node counts and boxes are final as soon as they render.
test.use({ reducedMotion: 'reduce' });

const node = (page: Page, text: string): Locator =>
  page.locator('[data-mindmap-node]').filter({ hasText: new RegExp(`^${text}$`) });

async function importMap(page: Page, outline: string[]): Promise<void> {
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.getByPlaceholder(/# My map/).fill(outline.join('\n'));
  await page.getByRole('button', { name: 'Import', exact: true }).last().click();
  await expect(page.locator('[data-mindmap-node]')).toHaveCount(outline.length);
}

test('a node found from the browser opens its map searched, its branch opened for the search only', async ({ page }) => {
  await openApp(page);
  await appShell(page).getByRole('button', { name: 'Mindmaps' }).click();
  await importMap(page, ['# Trip', '## Flights', '- Book Lisbon flight', '- Seats', '## Hotel', '- Lisbon hotel', '- Breakfast']);
  await page.getByRole('button', { name: 'Collapse all', exact: true }).click();
  await expect(page.locator('[data-mindmap-node]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Back to mindmaps' }).click();
  await importMap(page, ['# Budget', '- Rent']);
  await page.getByRole('button', { name: 'Back to mindmaps' }).click();

  const box = page.getByRole('textbox', { name: 'Search mindmaps' });
  await box.fill('lisbon');
  await expect(page.getByText('Nothing matches “lisbon”.')).toBeVisible();
  await page.getByRole('button', { name: 'Node text' }).click();
  await expect(page.getByText('Book Lisbon flight · Lisbon hotel')).toBeVisible();
  await expect(page.getByText('Budget')).toHaveCount(0);

  await page.getByText('Trip', { exact: true }).click();
  const findBox = page.getByRole('textbox', { name: 'Search this map' });
  await expect(findBox).toHaveValue('lisbon');
  await expect(findBox).not.toBeFocused();
  // Both collapsed branches opened; the matches carry the highlight, the first one selected.
  await expect(node(page, 'Book Lisbon flight')).toBeVisible();
  await expect(node(page, 'Lisbon hotel')).toBeVisible();
  await expect(page.locator('[data-search-hit]')).toHaveCount(2);
  await expect(page.getByText('1/2')).toBeVisible();

  // Escape ends the search: the way to the selected match stays, the rest folds back.
  await findBox.press('Escape');
  await expect(findBox).toHaveCount(0);
  await expect(node(page, 'Book Lisbon flight')).toBeVisible();
  await expect(node(page, 'Lisbon hotel')).toHaveCount(0);
  await expect(page.locator('[data-search-hit]')).toHaveCount(0);
});

test('Ctrl+F searches the open map; Enter steps through the matches', async ({ page }) => {
  await openApp(page);
  await appShell(page).getByRole('button', { name: 'Mindmaps' }).click();
  await importMap(page, ['# Plan', '## Alpha', '- Shared step', '## Beta', '- Shared step two']);
  await page.getByRole('button', { name: 'Collapse all', exact: true }).click();

  await page.getByTestId('mindmap-canvas').click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('Control+f');
  const findBox = page.getByRole('textbox', { name: 'Search this map' });
  await expect(findBox).toBeFocused();
  await findBox.fill('shared');
  await expect(page.getByText('1/2')).toBeVisible();
  await expect(node(page, 'Shared step')).toBeInViewport();
  await findBox.press('Enter');
  await expect(page.getByText('2/2')).toBeVisible();
  await expect(node(page, 'Shared step two')).toBeInViewport();
  // Enter stayed in the search: no node was added.
  await expect(page.locator('[data-mindmap-node]')).toHaveCount(5);
});
