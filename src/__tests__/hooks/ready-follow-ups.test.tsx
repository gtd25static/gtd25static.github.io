// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import '../setup-component';
import { resetDb, assertDefined } from '../helpers/db-helpers';
import { createTaskList } from '../../hooks/use-task-lists';
import { createTask, updateTask } from '../../hooks/use-tasks';
import { useReadyFollowUps } from '../../hooks/use-ready-follow-ups';

beforeEach(async () => {
  await resetDb();
});

afterEach(() => vi.restoreAllMocks());

describe('useReadyFollowUps', { timeout: 15_000 }, () => {
  // The awake check compares against Date.now() inside a liveQuery, which only
  // re-runs on DB writes: a snooze running out used to go unnoticed until
  // something unrelated was written.
  it('shows a follow-up once its snooze runs out, without any DB write', async () => {
    const base = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(base);
    const leads = await createTaskList('Leads', 'follow-ups');
    const topic = assertDefined(await createTask(leads.id, { title: 'Budget' }));
    await updateTask(topic.id, { pingedAt: base, pingCooldown: 'custom', pingCooldownUntil: base + 30_000 });

    const { result } = renderHook(() => useReadyFollowUps());
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current).toEqual([]);

    vi.spyOn(Date, 'now').mockReturnValue(base + 120_000);
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(result.current.map((i) => i.title)).toEqual(['Budget']));
  });
});
