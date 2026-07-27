import { vi } from 'vitest';
import { db, onDatabaseSupersededByOtherTab } from '../../db';

// When another tab (a reloaded one, running a newer build) upgrades the schema,
// Dexie closes THIS connection so the upgrade isn't blocked — with auto-open
// still on, so the next query re-opens declaring the version this older code
// knows and IndexedDB rejects it. Before this hook, the tab just stopped
// working: failing live queries and a console warning nobody sees.

// Firing the event runs Dexie's own handler too, which closes the connection —
// exactly what production does. Re-open it so the rest of the suite (files share
// a worker) doesn't inherit a closed database.
afterEach(async () => {
  if (!db.isOpen()) await db.open();
});

describe('database superseded by another tab', () => {
  it('reports a schema upgrade from another connection', () => {
    const notified = vi.fn();
    const off = onDatabaseSupersededByOtherTab(notified);
    try {
      db.on('versionchange').fire({ newVersion: 99, oldVersion: 8 } as IDBVersionChangeEvent);
      expect(notified).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it('reports a delete request too — the database is just as gone', () => {
    const notified = vi.fn();
    const off = onDatabaseSupersededByOtherTab(notified);
    try {
      // newVersion null = another connection wants to delete the database.
      db.on('versionchange').fire({ newVersion: null, oldVersion: 8 } as unknown as IDBVersionChangeEvent);
      expect(notified).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it('stops reporting once unsubscribed', () => {
    const notified = vi.fn();
    onDatabaseSupersededByOtherTab(notified)();
    db.on('versionchange').fire({ newVersion: 99, oldVersion: 8 } as IDBVersionChangeEvent);
    expect(notified).not.toHaveBeenCalled();
  });
});
