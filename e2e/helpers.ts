// UI flows and device inspection helpers for the e2e suite. Flows drive the real
// UI (role/label selectors); inspection reads raw browser storage from the page.
import { expect, type Locator, type Page } from '@playwright/test';
import type { FakeGitHub } from './fake-github';

// Long, random-looking phrases: they must clear the app's strength gate.
export const MAIN_PASSPHRASE = 'violet anchor 83 drift quartz lantern';
export const SECONDARY_PASSPHRASE = 'copper meadow 41 silent harbor thistle';
export const ROTATED_PASSPHRASE = 'amber canyon 62 hollow signal juniper';
export const SYNC_PASSWORD = 'glacier ribbon 58 tender compass mosaic';

/** IndexedDB stores holding user content (the tables the secondary unlock rewrites). */
export const CONTENT_STORES = ['taskLists', 'tasks', 'subtasks', 'sharedItems', 'mindmapFolders', 'mindmaps', 'mindmapNodes'];
const APP_DB = 'gtd25';
export const SHARE_CACHE = 'gtd25-share-v1';

// --- Locators ---

export const lockHeading = (page: Page): Locator => page.getByRole('heading', { name: 'Vault locked' });
/** The sidebar only exists in the unlocked app shell. */
export const appShell = (page: Page): Locator => page.locator('aside');
export const taskCards = (page: Page): Locator => page.locator('[data-task-id]');
export const dialogTitled = (page: Page, title: string): Locator =>
  page.locator('dialog').filter({ has: page.getByRole('heading', { name: title, exact: true }) });

// --- App flows ---

/** Load the app and wait for either the unlocked shell or the lock screen. */
export async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(appShell(page).or(lockHeading(page))).toBeVisible();
}

export async function createList(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Create new list' }).click();
  const input = page.getByPlaceholder('List name');
  await input.fill(name);
  await input.press('Enter');
  await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
}

/** Add a task to the list open in the main pane. */
export async function createTask(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'Add a task' }).click();
  const input = page.getByPlaceholder('Task title');
  await input.fill(title);
  await input.press('Enter');
  await expect(taskCards(page).filter({ hasText: title })).toBeVisible();
}

/** Open a sidebar list by (part of) its name, or by position under "Lists". */
export async function openList(page: Page, which: string | number): Promise<void> {
  const lists = page.locator('aside nav [data-focus-id]');
  const item = typeof which === 'number' ? lists.nth(which) : lists.filter({ hasText: which });
  await item.locator(':scope > button').click();
  await expect(page.getByRole('button', { name: 'Add a task' })).toBeVisible();
}

// React renders the settings <dialog> and opens it from an effect, so give it a
// couple of frames before deciding whether it is open (the store keeps it "open"
// across a lock, so it pops back up right after an unlock).
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    setTimeout(resolve, 250);
  }));
}

export async function openSettings(page: Page, tab: 'General' | 'Security'): Promise<Locator> {
  await settle(page);
  const dialog = dialogTitled(page, 'Settings');
  if (!(await dialog.isVisible())) await appShell(page).getByRole('button', { name: 'Settings', exact: true }).click();
  await dialog.getByRole('button', { name: tab, exact: true }).click();
  return dialog;
}

export async function closeSettings(page: Page): Promise<void> {
  await settle(page);
  const dialog = dialogTitled(page, 'Settings');
  if (await dialog.isVisible()) {
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();
  }
}

export async function enableParanoid(page: Page, passphrase: string): Promise<void> {
  const dialog = await openSettings(page, 'Security');
  await dialog.getByLabel('Passphrase', { exact: true }).fill(passphrase);
  await dialog.getByLabel('Confirm passphrase', { exact: true }).fill(passphrase);
  await dialog.getByRole('button', { name: 'Enable Paranoid Mode' }).click();
  await expect(dialog.getByText('Active — local data on this device is encrypted at rest.')).toBeVisible({ timeout: 90_000 });
}

/** Answer the "Confirm your passphrase" prompt the security settings raise before changing how the vault opens. */
export async function confirmPassphrasePrompt(page: Page, passphrase = MAIN_PASSPHRASE): Promise<void> {
  await page.getByPlaceholder('Vault passphrase').fill(passphrase);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
}

export async function setSecondaryPassphrase(page: Page, passphrase: string, mainPassphrase = MAIN_PASSPHRASE): Promise<void> {
  const dialog = await openSettings(page, 'Security');
  const section = dialog.getByRole('heading', { name: 'Secondary passphrase', exact: true }).locator('..');
  await section.getByLabel('Secondary passphrase', { exact: true }).fill(passphrase);
  await section.getByLabel('Confirm', { exact: true }).fill(passphrase);
  await section.getByRole('button', { name: 'Save', exact: true }).click();
  await confirmPassphrasePrompt(page, mainPassphrase);
  await expect(page.getByText('Secondary passphrase saved', { exact: true })).toBeVisible({ timeout: 90_000 });
}

/**
 * Settings → Security → Change passphrase. Re-keys the device by default (the
 * checkbox is on); `rekey: false` unticks it so only slot 1 is re-wrapped.
 */
export async function changePassphrase(page: Page, current: string, next: string, opts: { rekey?: boolean } = {}): Promise<void> {
  const dialog = await openSettings(page, 'Security');
  const section = dialog.getByRole('heading', { name: 'Change passphrase', exact: true }).locator('..');
  await section.getByLabel('Current passphrase', { exact: true }).fill(current);
  await section.getByLabel('New passphrase', { exact: true }).fill(next);
  await section.getByLabel('Confirm new passphrase', { exact: true }).fill(next);
  if (opts.rekey === false) await section.getByLabel('Also re-key this device (recommended)').uncheck();
  await section.getByRole('button', { name: 'Change passphrase' }).click();
  const done = opts.rekey === false ? 'Passphrase changed' : 'Passphrase changed and device re-keyed';
  await expect(page.getByText(done, { exact: false }).first()).toBeVisible({ timeout: 90_000 });
}

/**
 * Settings → Security → Re-key this device. Resolves once the toast confirms
 * it, or (`expectIncorrect`) once the app has refused the passphrase.
 */
export async function rekeyVault(page: Page, passphrase: string, opts: { expectIncorrect?: boolean } = {}): Promise<void> {
  const dialog = await openSettings(page, 'Security');
  const section = dialog.getByRole('heading', { name: 'Re-key this device', exact: true }).locator('..');
  await section.getByLabel('Current passphrase', { exact: true }).fill(passphrase);
  await section.getByRole('button', { name: 'Re-key device' }).click();
  const done = opts.expectIncorrect ? 'Incorrect passphrase' : 'Device re-keyed';
  await expect(page.getByText(done, { exact: false }).first()).toBeVisible({ timeout: 90_000 });
}

/** Lock with Settings → Security → "Lock now", or with the Ctrl/Cmd+Shift+L hotkey (enabled on demand). */
export async function lock(page: Page, via: 'button' | 'hotkey' = 'button'): Promise<void> {
  const dialog = await openSettings(page, 'Security');
  if (via === 'button') {
    await dialog.getByRole('button', { name: 'Lock now' }).click();
  } else {
    const hotkey = dialog.getByRole('checkbox', { name: /Instant-lock hotkey/ });
    if (!(await hotkey.isChecked())) {
      await hotkey.click();
      await expect(hotkey).toBeChecked();
    }
    await closeSettings(page);
    await page.keyboard.press('ControlOrMeta+Shift+L');
  }
  await expect(lockHeading(page)).toBeVisible();
}

/**
 * Submit a passphrase on the lock screen. Resolves true when the app shell
 * appears, false when the lock screen stays up with an error.
 */
export async function unlock(page: Page, passphrase: string): Promise<boolean> {
  await expect(lockHeading(page)).toBeVisible();
  await page.getByPlaceholder('Enter vault passphrase').fill(passphrase);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  let outcome = 'pending';
  await expect.poll(async () => {
    // One atomic read: a failed attempt clears the field and shows an error, so a
    // stale error from an earlier attempt can't be mistaken for this one.
    outcome = await page.evaluate(() => {
      if (document.querySelector('aside')) return 'unlocked';
      const field = document.querySelector<HTMLInputElement>('input[placeholder="Enter vault passphrase"]');
      const error = /Incorrect passphrase|Could not unlock the vault|Vault data is unreadable|unlock could not finish/
        .test(document.body.innerText);
      return field && !field.disabled && field.value === '' && error ? 'rejected' : 'pending';
    });
    return outcome;
  }, { message: 'the unlock attempt neither opened the app nor was rejected', timeout: 90_000 }).not.toBe('pending');
  return outcome === 'unlocked';
}

// --- GitHub sync settings ---

async function syncSection(page: Page): Promise<Locator> {
  const dialog = await openSettings(page, 'General');
  return dialog.getByRole('heading', { name: 'GitHub Sync', exact: true }).locator('..');
}

/**
 * Link sync through Settings. Linking a device that has content of its own to a
 * repository that already holds data asks before replacing it; pass
 * `replaceLocalData` where the test means to accept that, anywhere else the
 * question fails the test.
 */
export async function configureSync(
  page: Page,
  github: FakeGitHub,
  syncPassword = SYNC_PASSWORD,
  { replaceLocalData = false }: { replaceLocalData?: boolean } = {},
): Promise<void> {
  const section = await syncSection(page);
  await section.getByLabel('Personal Access Token', { exact: true }).fill(github.token);
  await section.getByLabel('Repository (owner/name)', { exact: true }).fill(github.fullName);
  await section.getByLabel('Encryption Password', { exact: true }).fill(syncPassword);
  await section.getByLabel('Confirm Password', { exact: true }).fill(syncPassword);
  await section.getByRole('button', { name: 'Save', exact: true }).click();
  const saved = page.getByText('Sync settings saved', { exact: true });
  const replace = page.getByRole('button', { name: 'Connect and replace', exact: true });
  await expect(saved.or(replace)).toBeVisible();
  if (await replace.isVisible()) {
    expect(replaceLocalData, 'linking asked to replace this device\'s data').toBe(true);
    await replace.click();
  }
  await expect(saved).toBeVisible();
}

export async function readSyncSettings(page: Page): Promise<{ token: string; repo: string; password: string }> {
  const section = await syncSection(page);
  return {
    token: await section.getByLabel('Personal Access Token', { exact: true }).inputValue(),
    repo: await section.getByLabel('Repository (owner/name)', { exact: true }).inputValue(),
    password: await section.getByLabel('Encryption Password', { exact: true }).inputValue(),
  };
}

// --- Share target ---

/** Stash a share exactly as the service worker's share-target handler does (src/lib/sw-handlers.ts). */
export async function stashShareLikeTheServiceWorker(page: Page, title: string): Promise<void> {
  await page.evaluate(async ({ cacheName, shareTitle }) => {
    const cache = await caches.open(cacheName);
    const meta = { title: shareTitle, text: '', url: 'https://secret.example/x', ts: Date.now(), files: [] };
    await cache.put(
      new Request('/__gtd25-share/meta'),
      new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }),
    );
  }, { cacheName: SHARE_CACHE, shareTitle: title });
}

export const hasShareStash = (page: Page): Promise<boolean> => page.evaluate((name) => caches.has(name), SHARE_CACHE);

// --- Device inspection ---

export async function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => `${document.title}\n${document.body.innerText}`);
}

/**
 * Everything the origin persists, as one string: every IndexedDB database/store
 * (keys + values), localStorage, sessionStorage and every Cache Storage entry
 * (URL + body). Binary values are decoded as UTF-8 text so plaintext inside them
 * is searchable too.
 */
export async function dumpDeviceStorage(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const decoder = new TextDecoder();
    const toPlain = async (value: unknown): Promise<unknown> => {
      if (value === null || typeof value !== 'object') return value;
      if (value instanceof ArrayBuffer) return decoder.decode(value);
      if (ArrayBuffer.isView(value)) return decoder.decode(value);
      if (value instanceof Blob) return value.text();
      if (value instanceof Date) return value.toISOString();
      if (value instanceof Map) return toPlain([...value.entries()]);
      if (value instanceof Set) return toPlain([...value]);
      if (Array.isArray(value)) return Promise.all(value.map(toPlain));
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value)) out[key] = await toPlain(inner);
      return out;
    };
    const settle = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    const indexedDb: Record<string, Record<string, unknown>> = {};
    for (const { name } of await indexedDB.databases()) {
      if (!name) continue;
      const db = await settle(indexedDB.open(name));
      try {
        const stores: Record<string, unknown> = {};
        for (const storeName of Array.from(db.objectStoreNames)) {
          const store = db.transaction(storeName, 'readonly').objectStore(storeName);
          // Both requests start before any await, while the transaction is active.
          const [keys, values] = await Promise.all([settle(store.getAllKeys()), settle(store.getAll())]);
          stores[storeName] = await toPlain({ keys, values });
        }
        indexedDb[name] = stores;
      } finally {
        db.close();
      }
    }

    const readStorage = (storage: Storage) => Object.fromEntries(Object.keys(storage).map((key) => [key, storage.getItem(key)]));

    const cacheStorage: Record<string, Array<{ url: string; body: string }>> = {};
    for (const cacheName of await caches.keys()) {
      const cache = await caches.open(cacheName);
      const entries: Array<{ url: string; body: string }> = [];
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        entries.push({ url: request.url, body: response ? await response.text() : '' });
      }
      cacheStorage[cacheName] = entries;
    }

    return JSON.stringify({
      indexedDb,
      localStorage: readStorage(localStorage),
      sessionStorage: readStorage(sessionStorage),
      cacheStorage,
    });
  });
}

/** Primary keys of every content store, sorted — the "structure" a decoy must keep. */
export async function contentRowIds(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(async ({ dbName, storeNames }) => {
    const settle = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const db = await settle(indexedDB.open(dbName));
    try {
      const ids: Record<string, string[]> = {};
      for (const storeName of storeNames) {
        if (!db.objectStoreNames.contains(storeName)) continue;
        const keys = await settle(db.transaction(storeName, 'readonly').objectStore(storeName).getAllKeys());
        ids[storeName] = keys.map(String).sort();
      }
      return ids;
    } finally {
      db.close();
    }
  }, { dbName: APP_DB, storeNames: CONTENT_STORES });
}

/**
 * A marker plus the fragments that any base64 encoding of text containing it must
 * include (one per byte alignment), so base64-wrapped plaintext is caught too.
 */
function markerForms(marker: string): string[] {
  const forms = [marker];
  for (let pad = 0; pad < 3; pad++) {
    const encoded = Buffer.concat([Buffer.alloc(pad), Buffer.from(marker)]).toString('base64');
    forms.push(encoded.slice(Math.ceil((pad * 4) / 3), -4));
  }
  return forms;
}

/** The markers that occur in `haystack`, verbatim or base64-encoded (in input order). */
export function findMarkers(haystack: string, markers: readonly string[]): string[] {
  return markers.filter((marker) => markerForms(marker).some((form) => haystack.includes(form)));
}

/**
 * Record, from now on, whether any of `needles` is ever rendered in the page
 * (document title or body text), even transiently. Read it with seenText().
 * Does not survive a navigation.
 */
export async function watchForText(page: Page, needles: readonly string[]): Promise<void> {
  await page.evaluate((list) => {
    const seen: string[] = [];
    (window as unknown as { __e2eSeenText: string[] }).__e2eSeenText = seen;
    const scan = () => {
      const text = `${document.title}\n${document.body?.textContent ?? ''}`;
      for (const needle of list) if (!seen.includes(needle) && text.includes(needle)) seen.push(needle);
    };
    scan();
    new MutationObserver(scan).observe(document, { subtree: true, childList: true, characterData: true });
  }, [...needles]);
}

export async function seenText(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __e2eSeenText?: string[] }).__e2eSeenText ?? []);
}
