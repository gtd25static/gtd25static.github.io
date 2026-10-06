import { db } from '../../db';
import { resetDb } from '../helpers/db-helpers';
import { captureToInbox, formatCaptureResult } from '../../hooks/use-url-capture';
import { MAX_TITLE_LENGTH, MAX_DESCRIPTION_LENGTH } from '../../lib/constants';

vi.mock('../../components/ui/Toast', () => ({ toast: vi.fn() }));
import { toast } from '../../components/ui/Toast';

// Reliability review 2026-10-06 (A4): a capture too long for a title lost
// everything past 500 characters, and text shared next to a URL was dropped.

beforeEach(async () => {
  await resetDb();
  vi.mocked(toast).mockClear();
});

async function inboxTasks() {
  return db.tasks.filter((t) => !t.deletedAt).toArray();
}

it('a capture longer than a title keeps a short title and the whole text in the description', async () => {
  const text = 'First line of a long note\n' + 'y'.repeat(3000) + ' END';
  await captureToInbox({ title: text });

  const [task] = await inboxTasks();
  expect(task.title.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
  expect(task.title.startsWith('First line of a long note')).toBe(true);
  expect(task.description).toBe(text);
});

it('says so when the text is longer than a description can hold', async () => {
  const text = 'z'.repeat(MAX_DESCRIPTION_LENGTH + 100);
  await captureToInbox({ title: text });

  const [task] = await inboxTasks();
  expect(task.description?.length).toBe(MAX_DESCRIPTION_LENGTH);
  expect(vi.mocked(toast).mock.calls.some(([, kind]) => kind === 'error' || kind === 'info')).toBe(true);
});

it('text shared next to a URL becomes the description instead of being dropped', () => {
  expect(formatCaptureResult('Page', 'https://main.com', 'Look at the second chart')).toEqual({
    title: 'Page', link: 'https://main.com', linkTitle: 'Page', description: 'Look at the second chart',
  });
  expect(formatCaptureResult('My title', '', 'Have a look https://example.com/p')).toEqual({
    title: 'My title', link: 'https://example.com/p', description: 'Have a look',
  });
});
