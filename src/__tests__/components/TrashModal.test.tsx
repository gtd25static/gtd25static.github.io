// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import '../setup-component';
import { resetDb } from '../helpers/db-helpers';
import { resetAppState } from '../helpers/component-helpers';
import { createTaskList, deleteTaskList } from '../../hooks/use-task-lists';
import { TrashModal } from '../../components/trash/TrashModal';
import { useAppState } from '../../stores/app-state';

beforeEach(async () => {
  await resetDb();
  resetAppState();
});

describe('TrashModal', { timeout: 15_000 }, () => {
  // It said "Trash is empty" until the query came back, then showed the items.
  it('does not claim the Trash is empty while it is still loading', async () => {
    const list = await createTaskList('Old errands');
    await deleteTaskList(list.id);
    useAppState.setState({ trashOpen: true });

    render(<TrashModal />);

    expect(screen.queryByText('Trash is empty')).not.toBeInTheDocument();
    expect(await screen.findByText('Old errands')).toBeInTheDocument();
  });

  it('says so once it has looked and found nothing', async () => {
    useAppState.setState({ trashOpen: true });
    render(<TrashModal />);
    expect(await screen.findByText('Trash is empty')).toBeInTheDocument();
  });
});
