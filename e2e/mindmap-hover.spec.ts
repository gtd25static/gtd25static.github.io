// Mindmap hover actions: on a node with children, "add child" sits past the
// collapse toggle; moving the mouse there over the toggle must not drop the
// hover (the buttons used to vanish half-way). Real UI on the production build.
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { appShell, openApp } from './helpers';

const node = (page: Page, text: string): Locator =>
  page.locator('[data-mindmap-node]').filter({ hasText: new RegExp(`^${text}$`) });

test('the mouse can travel from a parent node, over its toggle, to "add child"', async ({ page }) => {
  await openApp(page);
  await appShell(page).getByRole('button', { name: 'Mindmaps' }).click();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.getByPlaceholder(/# My map/).fill(['# Plan', '- Alpha', '  - A1', '- Beta'].join('\n'));
  await page.getByRole('button', { name: 'Import', exact: true }).last().click();
  await expect(page.locator('[data-mindmap-node]')).toHaveCount(4);

  // Hover Alpha (not selected), then glide right in small steps onto its "+".
  const alpha = (await node(page, 'Alpha').boundingBox())!;
  await page.mouse.move(alpha.x + alpha.width / 2, alpha.y + alpha.height / 2);
  const addChild = page.getByRole('button', { name: 'Add child (Tab)' });
  await expect(addChild).toBeVisible();
  const plus = (await addChild.boundingBox())!;
  await page.mouse.move(plus.x + plus.width / 2, plus.y + plus.height / 2, { steps: 40 });
  await page.mouse.down();
  await page.mouse.up();

  await expect(page.locator('[data-mindmap-node]')).toHaveCount(5);
});
