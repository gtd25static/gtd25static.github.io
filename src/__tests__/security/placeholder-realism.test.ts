import { vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import {
  enableParanoid, lock, unlockWithPassphrase, setSecondaryPassphrase, __resetVaultStateForTests,
} from '../../db/vault';
import { placeholderRow, placeholderBlobBytes, createPlaceholderContext } from '../../lib/placeholder-content';
import { sanitizeSavedSearches } from '../../lib/list-filter';
import { isInboxList, INBOX_LIST_NAME } from '../../lib/constants';
import { titleSimilarity } from '../../lib/similarity';
import type { Task, TaskList } from '../../db/models';

// What the secondary passphrase leaves on screen has to pass for someone's real
// lists (threat-model review, batch 4). It used to be visible Latin filler with
// only 24 possible values per field: duplicate banners everywhere, saved-search
// chips collapsing, and the Inbox renamed out of existence.

const FILLER = /\b(lorem|ipsum|dolor|consectetur|adipiscing|eiusmod|tempor|incididunt)\b/i;

function task(i: number, listId = 'l1'): Record<string, unknown> {
  return { id: `t${i}`, listId, title: `real ${i}`, description: 'real notes', link: 'https://real.example.org/x', linkTitle: 'Real page', status: 'todo', order: i, createdAt: 1, updatedAt: 1 };
}

describe('placeholder rows read like ordinary content', () => {
  it('no filler text, no example.com, in titles, notes or links', () => {
    const ctx = createPlaceholderContext('en');
    for (let i = 0; i < 30; i++) {
      const row = placeholderRow('task', task(i), ctx);
      expect(JSON.stringify(row)).not.toMatch(FILLER);
      expect(String(row.link)).not.toContain('example.com');
      expect(String(row.link)).toMatch(/^https:\/\/[a-z.]+\.(org|com)\//);
      expect(String(row.title).length).toBeGreaterThan(5);
    }
  });

  it('60 tasks of one list: all titles distinct, and none flagged as near-duplicates of an equal one', () => {
    const ctx = createPlaceholderContext('en');
    const titles = Array.from({ length: 60 }, (_, i) => String(placeholderRow('task', task(i), ctx).title));
    expect(new Set(titles.map((t) => t.toLowerCase())).size).toBe(60);
    expect(titles.filter((a, i) => titles.some((b, j) => j !== i && titleSimilarity(a, b) === 1))).toEqual([]);
  });

  it('list names are distinct, and the Inbox keeps its name', () => {
    const ctx = createPlaceholderContext('en');
    const inbox = placeholderRow('taskList', { id: 'inbox', name: INBOX_LIST_NAME, type: 'tasks', order: 0 }, ctx);
    expect(isInboxList(inbox as unknown as TaskList)).toBe(true);
    const names = Array.from({ length: 20 }, (_, i) => String(placeholderRow('taskList', { id: `l${i}`, name: `Real ${i}`, type: 'tasks' }, ctx).name));
    expect(new Set(names).size).toBe(20);
    expect(names).not.toContain(INBOX_LIST_NAME);
  });

  it('keeps the number of saved searches — all distinct, so none collapse when read', () => {
    const row = placeholderRow('taskList', { id: 'l1', name: 'Work', type: 'tasks', savedSearches: Array.from({ length: 12 }, (_, i) => `real ${i}`) });
    expect(sanitizeSavedSearches(row.savedSearches)).toHaveLength(12);
  });

  it('speaks the browser\'s language: Spanish for es-*', () => {
    const es = createPlaceholderContext('es-ES');
    const en = createPlaceholderContext('en-GB');
    const esTitles = Array.from({ length: 10 }, (_, i) => String(placeholderRow('task', task(i), es).title));
    const enTitles = Array.from({ length: 10 }, (_, i) => String(placeholderRow('task', task(i), en).title));
    expect(esTitles.join(' ')).not.toEqual(enTitles.join(' '));
    expect(es.vocab.tasks).toContain('Llamar al dentista');
  });

  it('a shared file is a .txt note of the size it says; a link keeps a matching title', () => {
    const ctx = createPlaceholderContext('en');
    const file = placeholderRow('sharedItem', { id: 's1', type: 'file', name: 'evidence.zip', blobId: 'b1', mimeType: 'application/zip', size: 9 }, ctx);
    expect(String(file.name)).toMatch(/\.txt$/);
    expect(file.size).toBe(placeholderBlobBytes('b1', ctx.vocab).length);
    expect(new TextDecoder().decode(placeholderBlobBytes('b1', ctx.vocab))).not.toMatch(FILLER);
    const link = placeholderRow('sharedItem', { id: 's2', type: 'link', name: 'Secret', url: 'https://real.example.org' }, ctx);
    expect(String(link.url)).toMatch(/^https:\/\//);
    expect(String(link.name).length).toBeGreaterThan(0);
  });

  it('a mindmap: the root reads like a map title, the rest like topics, all distinct within the map', () => {
    const ctx = createPlaceholderContext('en');
    const labels = [
      placeholderRow('mindmapNode', { id: 'root', mapId: 'm1', label: 'Real', order: 0 }, ctx).label,
      ...Array.from({ length: 15 }, (_, i) => placeholderRow('mindmapNode', { id: `n${i}`, mapId: 'm1', parentId: 'root', label: 'Real', order: i }, ctx).label),
    ];
    expect(new Set(labels).size).toBe(16);
  });
});

describe('after a secondary-passphrase unlock', () => {
  const REAL = 'realism real passphrase 3 harbor';
  const SECONDARY = 'realism other passphrase 9 meadow';

  beforeEach(async () => {
    await resetDb();
    __resetVaultStateForTests();
    localStorage.removeItem('gtd25-paranoid');
  });
  afterEach(() => {
    __resetVaultStateForTests();
    localStorage.removeItem('gtd25-paranoid');
  });

  it('the Inbox is still the Inbox, and no list has repeated titles', async () => {
    await db.taskLists.bulkAdd([
      { id: 'inbox', name: INBOX_LIST_NAME, type: 'tasks', order: 0, createdAt: 1, updatedAt: 1 } as TaskList,
      { id: 'l1', name: 'Real work', type: 'tasks', order: 1, createdAt: 1, updatedAt: 1 } as TaskList,
    ]);
    await db.tasks.bulkAdd(Array.from({ length: 25 }, (_, i) => task(i) as unknown as Task));
    await enableParanoid(REAL);
    await setSecondaryPassphrase(SECONDARY);
    lock();
    expect(await unlockWithPassphrase(SECONDARY)).toBe(true);

    const lists = await db.taskLists.toArray();
    expect(lists.filter((l) => isInboxList(l)).map((l) => l.id)).toEqual(['inbox']);
    const titles = (await db.tasks.where('listId').equals('l1').toArray()).map((t) => t.title.toLowerCase());
    expect(new Set(titles).size).toBe(25);
    expect(titles.join(' ')).not.toMatch(FILLER);
  });

  it('keeps every unlock-log entry, relabelled, so no old failed attempt surfaces now', async () => {
    await enableParanoid(REAL);
    await db.localSettings.update('local', {
      unlockLog: [
        { at: 1, method: 'passphrase', ok: false },
        { at: 2, method: 'security-key', ok: true },
        { at: 3, method: 'remote', ok: true },
      ],
    } as never);
    await setSecondaryPassphrase(SECONDARY);
    lock();
    expect(await unlockWithPassphrase(SECONDARY)).toBe(true);
    const log = (await db.localSettings.get('local'))?.unlockLog ?? [];
    expect(log.slice(0, 3).map((e) => [e.at, e.method, e.ok])).toEqual([[1, 'passphrase', false], [2, 'passphrase', true], [3, 'passphrase', true]]);
  });
});

describe('a share held at the lock screen', () => {
  // The lock screen promises "you will be asked where to file it": after the
  // secondary passphrase the same prompt must come, with nothing real in it.
  it('is replaced — same timestamp and number of files, no real content left', async () => {
    const { replaceShareStashWithPlaceholder, SHARE_META_PATH, shareFilePath } = await import('../../lib/share-target');
    const store = new Map<string, Response>();
    const ts = Date.now() - 60_000;
    store.set(SHARE_META_PATH, new Response(JSON.stringify({ ts, title: 'REAL title', text: 'REAL text', url: 'https://real.example.org', files: [{ name: 'REAL.pdf', type: 'application/pdf', size: 9 }] })));
    store.set(shareFilePath(0), new Response('REAL bytes'));
    let exists = true;
    vi.stubGlobal('caches', {
      has: async () => exists,
      open: async () => { exists = true; return {
        match: async (k: string) => store.get(k)?.clone(),
        put: async (req: Request, res: Response) => { store.set(new URL(req.url).pathname, res); },
      }; },
      delete: async () => { store.clear(); exists = false; return true; },
    });
    vi.stubGlobal('Request', class { url: string; constructor(u: string) { this.url = new URL(u, 'https://app.test').href; } });
    try {
      await replaceShareStashWithPlaceholder((meta) => ({
        ...meta, title: 'Placeholder', text: '', url: 'https://en.wikipedia.org/wiki/Composting',
        files: meta.files.map(() => ({ name: 'notes.txt', type: 'text/plain', size: 5, bytes: new TextEncoder().encode('notes') })),
      }));
      const meta = JSON.parse(await store.get(SHARE_META_PATH)!.text());
      expect(meta.ts).toBe(ts);
      expect(meta.files).toEqual([{ name: 'notes.txt', type: 'text/plain', size: 5 }]);
      expect(JSON.stringify(meta)).not.toContain('REAL');
      expect(await store.get(shareFilePath(0))!.text()).toBe('notes');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
