// Mindmap drag and drop: a node's top/bottom edge inserts the dragged node
// before/after it (reorder within one level, or move to another level at a
// chosen spot); its middle still re-parents. Real UI on the production build.
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { appShell, openApp } from './helpers';

// No glide: the next drag reads boxes that are already where the layout put them.
test.use({ reducedMotion: 'reduce' });

const node = (page: Page, text: string): Locator =>
  page.locator('[data-mindmap-node]').filter({ hasText: new RegExp(`^${text}$`) });

async function importMap(page: Page, outline: string[]): Promise<void> {
  await appShell(page).getByRole('button', { name: 'Mindmaps' }).click();
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await page.getByPlaceholder(/# My map/).fill(outline.join('\n'));
  await page.getByRole('button', { name: 'Import', exact: true }).last().click();
  await expect(page.locator('[data-mindmap-node]')).toHaveCount(outline.length);
}

/** Drag `from` and hover `fy` of the way down `onto`'s box, then drop. */
async function drag(page: Page, from: Locator, onto: Locator, fy: number, beforeDrop?: () => Promise<void>): Promise<void> {
  const a = (await from.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  const b = (await onto.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height * fy, { steps: 8 });
  await beforeDrop?.();
  await page.mouse.up();
}

/** Labels of the given nodes, top to bottom on screen. */
async function onScreenOrder(page: Page, labels: string[]): Promise<string[]> {
  const ys = await Promise.all(labels.map(async (l) => ({ l, y: (await node(page, l).boundingBox())!.y })));
  return ys.sort((p, q) => p.y - q.y).map((p) => p.l);
}

test('dragging onto a node\'s top/bottom edge reorders at the same level; its middle re-parents', async ({ page }) => {
  await openApp(page);
  await importMap(page, ['# Plan', '- Alpha', '- Beta', '- Gamma']);

  // Gamma onto Alpha's top edge → first; the insertion line shows while hovering.
  await drag(page, node(page, 'Gamma'), node(page, 'Alpha'), 0.1, async () => {
    await expect(page.getByTestId('mindmap-drop-line')).toBeVisible();
  });
  await expect(page.getByTestId('mindmap-drop-line')).toHaveCount(0);
  await expect.poll(() => onScreenOrder(page, ['Alpha', 'Beta', 'Gamma'])).toEqual(['Gamma', 'Alpha', 'Beta']);

  // Gamma onto Beta's bottom edge → last again.
  await drag(page, node(page, 'Gamma'), node(page, 'Beta'), 0.9);
  await expect.poll(() => onScreenOrder(page, ['Alpha', 'Beta', 'Gamma'])).toEqual(['Alpha', 'Beta', 'Gamma']);

  // The middle of Beta still makes Gamma its child: one column further right.
  await drag(page, node(page, 'Gamma'), node(page, 'Beta'), 0.5);
  await expect.poll(async () => {
    const beta = (await node(page, 'Beta').boundingBox())!;
    return (await node(page, 'Gamma').boundingBox())!.x > beta.x + beta.width;
  }).toBe(true);

  // And Alpha onto Gamma's top edge joins Gamma's level, above it.
  await drag(page, node(page, 'Alpha'), node(page, 'Gamma'), 0.1);
  await expect.poll(async () => {
    const [alpha, gamma] = [(await node(page, 'Alpha').boundingBox())!, (await node(page, 'Gamma').boundingBox())!];
    return Math.abs(alpha.x - gamma.x) < 2 && alpha.y < gamma.y;
  }).toBe(true);

  // It survives a reload — written, not just drawn: Alpha and Gamma are both
  // Beta's children now, Alpha first.
  await page.reload();
  await appShell(page).getByRole('button', { name: 'Mindmaps' }).click();
  await page.getByText('Plan', { exact: true }).first().click();
  await expect.poll(async () => {
    const [alpha, beta, gamma] = await Promise.all(['Alpha', 'Beta', 'Gamma'].map(async (l) => (await node(page, l).boundingBox())!));
    return alpha.x > beta.x + beta.width && Math.abs(alpha.x - gamma.x) < 2 && alpha.y < gamma.y;
  }).toBe(true);
});
