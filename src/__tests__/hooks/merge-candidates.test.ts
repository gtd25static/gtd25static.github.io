import { isMergeCandidate } from '../../hooks/use-merge-suggestions';
import type { Task } from '../../db/models';

const task = (overrides: Record<string, unknown> = {}): Task =>
  ({ id: 't1', listId: 'l1', title: 'Call the bank', status: 'todo', order: 0, createdAt: 1, updatedAt: 1, ...overrides } as Task);

describe('merge suggestion candidates', () => {
  it('never offers a row that could not be decrypted', () => {
    // Quarantined rows all read "⚠︎ unreadable", so they look like duplicates of each
    // other; merging would destroy a row that is still recoverable by re-syncing.
    expect(isMergeCandidate(task({ title: '⚠︎ unreadable', _decryptError: true }), 'tasks')).toBe(false);
    expect(isMergeCandidate(task({ title: '⚠︎ unreadable', _decryptError: true }), 'follow-ups')).toBe(false);
  });

  it('control: open tasks are candidates; deleted, done and archived ones are not', () => {
    expect(isMergeCandidate(task(), 'tasks')).toBe(true);
    expect(isMergeCandidate(task({ deletedAt: 5 }), 'tasks')).toBe(false);
    expect(isMergeCandidate(task({ status: 'done' }), 'tasks')).toBe(false);
    expect(isMergeCandidate(task({ archived: true }), 'follow-ups')).toBe(false);
    expect(isMergeCandidate(task(), 'follow-ups')).toBe(true);
  });
});
