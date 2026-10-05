// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '../setup-component';
import { vi, beforeEach, it, expect } from 'vitest';
import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import type { Task } from '../../db/models';

vi.mock('../../sync/sync-engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sync/sync-engine')>()),
  scheduleSyncDebounced: vi.fn(),
}));

import { ConflictsButton } from '../../components/sync/ConflictsButton';

beforeEach(async () => {
  await resetDb();
  await db.tasks.put({ id: 't1', listId: 'l1', title: 'Theirs', status: 'todo', order: 0, createdAt: 1, updatedAt: 2, fieldTimestamps: { title: 2 } } as Task);
  await db.syncConflicts.put({
    id: 'task:t1:title:1:2', entityType: 'task', entityId: 't1', field: 'title', kind: 'field',
    localValue: 'Mine', remoteValue: 'Theirs', localAt: 1, remoteAt: 2, applied: 'remote', label: 'Theirs', detectedAt: Date.now(),
  });
});

it('shows the count, both versions, and keeps the one picked', async () => {
  render(<ConflictsButton />);
  fireEvent.click(await screen.findByRole('button', { name: /1 sync conflict/ }));
  expect(await screen.findByText('Mine')).toBeInTheDocument();
  expect(screen.getAllByText('Theirs').length).toBeGreaterThan(0);
  expect(screen.getByText(/Another device · showing now/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Keep this device’s' }));
  await waitFor(async () => expect((await db.tasks.get('t1'))!.title).toBe('Mine'));
  await waitFor(async () => expect(await db.syncConflicts.count()).toBe(0));
});

it('a text field can be resolved with a version written by hand', async () => {
  render(<ConflictsButton />);
  fireEvent.click(await screen.findByRole('button', { name: /1 sync conflict/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Edit…' }));
  fireEvent.change(screen.getByLabelText(/Version of title to keep/), { target: { value: 'Mine and theirs' } });
  fireEvent.click(screen.getByRole('button', { name: 'Keep this version' }));
  await waitFor(async () => expect((await db.tasks.get('t1'))!.title).toBe('Mine and theirs'));
});

it('is not shown without conflicts', async () => {
  await db.syncConflicts.clear();
  const { container } = render(<ConflictsButton />);
  await new Promise((r) => setTimeout(r, 50));
  expect(container).toBeEmptyDOMElement();
});
