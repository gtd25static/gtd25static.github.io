// The list quick filter and its saved-search chips, on the production build:
// the strip fits a phone without a sideways scroll (the strip it sits near used
// to overflow there), chips survive a reload and bring their filter back, and a
// saved search never reaches the disk in the clear under Paranoid Mode.
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  MAIN_PASSPHRASE, closeSettings, createList, createTask, dumpDeviceStorage, enableParanoid, findMarkers, lock, openApp, openList,
  taskCards, unlock,
} from './helpers';

const PHONE = { viewport: { width: 360, height: 760 }, hasTouch: true, isMobile: true };

const filterField = (page: Page) => page.getByRole('textbox', { name: 'Filter this list' });
const chip = (page: Page, search: string) => page.getByRole('button', { name: search, exact: true });

async function saveSearch(page: Page, search: string): Promise<void> {
  await filterField(page).fill(search);
  await page.getByRole('button', { name: 'Save search' }).click();
  await expect(chip(page, search)).toBeVisible();
}

/** Every element that would scroll sideways: the page itself, or any box whose content is wider than it. */
async function sidewaysScrollers(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = [];
    if (document.documentElement.scrollWidth > window.innerWidth) found.push('the page');
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
      const { overflowX } = getComputedStyle(el);
      if ((overflowX === 'auto' || overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1) {
        found.push(`${el.tagName.toLowerCase()}.${el.className}`.slice(0, 120));
      }
    }
    return found;
  });
}

test.describe('on a phone', () => {
  test.use(PHONE);

  test('filters as you type, keeps chips across a reload, and nothing scrolls sideways', async ({ page }) => {
    await openApp(page);
    await page.getByRole('button', { name: 'Open sidebar' }).click();
    await createList(page, 'Errands');
    for (const title of ['Revisar presupuesto anual', 'Llamar a Ana', 'Comprar pan', 'Preparar agenda nueva']) {
      await createTask(page, title);
    }

    // A typo is forgiven; scattered letters are not ("pan" ≠ p…a…n of "Preparar agenda nueva").
    await filterField(page).fill('presupesto');
    await expect(taskCards(page)).toHaveCount(1);
    await expect(taskCards(page).first()).toContainText('Revisar presupuesto anual');
    await filterField(page).fill('pan');
    await expect(taskCards(page)).toHaveCount(1);
    await expect(taskCards(page).first()).toContainText('Comprar pan');

    for (const search of ['presupesto', 'llamar ana', 'comprar pan integral de centeno', 'agenda']) {
      await saveSearch(page, search);
    }
    expect(await sidewaysScrollers(page)).toEqual([]);

    await page.reload();
    await page.getByRole('button', { name: 'Open sidebar' }).click();
    await openList(page, 'Errands');
    await expect(filterField(page)).toHaveValue('');
    await expect(taskCards(page)).toHaveCount(4);
    await chip(page, 'llamar ana').click();
    await expect(filterField(page)).toHaveValue('llamar ana');
    await expect(taskCards(page)).toHaveCount(1);
    await expect(taskCards(page).first()).toContainText('Llamar a Ana');
    expect(await sidewaysScrollers(page)).toEqual([]);

    // Deleting a chip asks first.
    await page.getByRole('button', { name: 'Delete saved search “agenda”' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(chip(page, 'agenda')).toHaveCount(0);
  });
});

test('a saved search is encrypted at rest under Paranoid Mode, and back after unlocking', async ({ page }) => {
  const MARKER = 'QUOKKAFILTERMARKER';
  await openApp(page);
  await createList(page, 'Work');
  await createTask(page, 'Quarterly numbers');
  await enableParanoid(page, MAIN_PASSPHRASE);
  await closeSettings(page);
  await openList(page, 'Work');

  await saveSearch(page, MARKER);
  await lock(page);
  expect(findMarkers(await dumpDeviceStorage(page), [MARKER]), 'saved search in device storage').toEqual([]);

  expect(await unlock(page, MAIN_PASSPHRASE)).toBe(true);
  await closeSettings(page); // the store kept Settings open across the lock
  await openList(page, 'Work');
  await expect(chip(page, MARKER)).toBeVisible();
  // The filter typed before the lock is gone: only the chip remembers it.
  await expect(filterField(page)).toHaveValue('');
});
