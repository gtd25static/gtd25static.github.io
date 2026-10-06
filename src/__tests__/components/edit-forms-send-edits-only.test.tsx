// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { TaskForm } from '../../components/tasks/TaskForm';
import { SubtaskForm } from '../../components/subtasks/SubtaskForm';
import type { Task, Subtask } from '../../db/models';

// Reliability review 2026-10-06 (M1): an edit form sent every field it shows.
// A field another device changed while the dialog was open went back with the
// old value, stamped now — and won. An edit now sends what the user changed.

const task: Task = {
  id: 't1', listId: 'l1', title: 'Call mom', description: 'About the trip', status: 'todo', order: 0,
  createdAt: 1, updatedAt: 1, dueDate: new Date(2026, 9, 20).getTime(), links: [{ url: 'https://example.com', title: 'ex' }],
};

describe('TaskForm (edit)', () => {
  it('sends only the title when only the title was edited', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<TaskForm open onClose={() => {}} onSubmit={onSubmit} initial={task} />);

    const title = screen.getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Call mom about the trip');
    await user.click(screen.getByRole('button', { name: /save/i }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toEqual({ title: 'Call mom about the trip' });
  });

  it('sends nothing when nothing was edited', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<TaskForm open onClose={() => {}} onSubmit={onSubmit} initial={task} />);

    await user.click(screen.getByRole('button', { name: /save/i }));

    expect(onSubmit).toHaveBeenCalledWith({});
  });

  it('sends the whole schedule when the due date was edited', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<TaskForm open onClose={() => {}} onSubmit={onSubmit} initial={task} />);

    const due = screen.getByLabelText('Due date');
    await user.clear(due);
    await user.type(due, '2026-10-25');
    await user.click(screen.getByRole('button', { name: /save/i }));

    const sent = onSubmit.mock.calls[0][0];
    expect(Object.keys(sent).sort()).toEqual(['dueDate']);
    expect(sent.dueDate).toBe(new Date(2026, 9, 25).getTime());
  });

  it('a new task still sends everything', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<TaskForm open onClose={() => {}} onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText('Title'), 'New');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(onSubmit.mock.calls[0][0]).toMatchObject({ title: 'New' });
    expect('description' in onSubmit.mock.calls[0][0]).toBe(true);
  });
});

describe('SubtaskForm (edit)', () => {
  const sub: Subtask = { id: 's1', taskId: 't1', title: 'Book flights', status: 'todo', order: 0, createdAt: 1, updatedAt: 1, link: 'https://air.example' };

  it('sends only what was edited', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<SubtaskForm onSubmit={onSubmit} onCancel={() => {}} initial={sub} />);

    const title = screen.getByPlaceholderText('Subtask title');
    await user.clear(title);
    await user.type(title, 'Book flights and hotel');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSubmit.mock.calls[0][0]).toEqual({ title: 'Book flights and hotel' });
  });
});
