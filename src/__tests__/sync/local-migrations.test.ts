import { runLocalMigrations } from '../../sync/local-migrations';
import { db } from '../../db';

describe('runLocalMigrations', () => {
  it('is a no-op when from equals to', async () => {
    // Should not throw or do anything
    await runLocalMigrations(db, 2, 2);
  });

  it('is a no-op when from equals 0 and to equals 0', async () => {
    await runLocalMigrations(db, 0, 0);
  });

  it('throws when no migration path exists', async () => {
    await expect(runLocalMigrations(db, 99, 100)).rejects.toThrow(
      'No local migration found from version 99',
    );
  });

  it('throws for non-contiguous version gap with no migrations', async () => {
    await expect(runLocalMigrations(db, 50, 55)).rejects.toThrow(
      'No local migration found from version 50',
    );
  });
});
