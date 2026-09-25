// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { InlineTaskForm } from '../../components/tasks/InlineTaskForm';
import { TaskForm } from '../../components/tasks/TaskForm';
import { SubtaskForm } from '../../components/subtasks/SubtaskForm';

// AddLinkForm lives inside the task/subtask <form>s. It used to render its own
// <form>, and a nested form's submit escaped to the outer one: the browser
// submitted it natively and reloaded the page, discarding everything typed.

describe('AddLinkForm inside the task forms', () => {
  beforeEach(() => vi.clearAllMocks());

  it('InlineTaskForm: inner Add adds the link without submitting the task', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<InlineTaskForm onSubmit={onSubmit} onCancel={vi.fn()} />);
    await user.type(screen.getByPlaceholderText('Task title'), 'Task with link');
    await user.click(screen.getByText(/description, link, due date/));
    await user.click(screen.getByText('+ Add link'));

    expect(container.querySelectorAll('form form')).toHaveLength(0);

    await user.type(screen.getByPlaceholderText('https://...'), 'https://example.com/extra');
    await user.type(screen.getByPlaceholderText('Title (optional)'), 'Extra');
    const addButtons = screen.getAllByRole('button', { name: 'Add' });
    await user.click(addButtons[addButtons.length - 1]);

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Extra')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Task title')).toHaveValue('Task with link');

    await user.click(screen.getAllByRole('button', { name: 'Add' })[0]);
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Task with link',
      links: [{ url: 'https://example.com/extra', title: 'Extra' }],
    }));
  });

  it('InlineTaskForm: Enter in the URL field adds the link, not the task', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<InlineTaskForm onSubmit={onSubmit} onCancel={vi.fn()} />);
    await user.type(screen.getByPlaceholderText('Task title'), 'Task two');
    await user.click(screen.getByText(/description, link, due date/));
    await user.click(screen.getByText('+ Add link'));
    await user.type(screen.getByPlaceholderText('https://...'), 'https://example.com/enter{Enter}');

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('example.com')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('https://...')).not.toBeInTheDocument();
  });

  it('InlineTaskForm: an invalid URL is not added and does not submit the task', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<InlineTaskForm onSubmit={onSubmit} onCancel={vi.fn()} />);
    await user.type(screen.getByPlaceholderText('Task title'), 'Task three');
    await user.click(screen.getByText(/description, link, due date/));
    await user.click(screen.getByText('+ Add link'));
    await user.type(screen.getByPlaceholderText('https://...'), 'not a url{Enter}');

    expect(onSubmit).not.toHaveBeenCalled();
    // The link form stays open with the value so the user can fix it.
    expect(screen.getByPlaceholderText('https://...')).toHaveValue('not a url');
  });

  it('TaskForm (Edit Task modal): inner Add adds the link without saving', async () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<TaskForm open onClose={onClose} onSubmit={onSubmit} initial={{ title: 'Edit me' }} />);
    const dialog = screen.getByRole('dialog');

    expect(dialog.querySelectorAll('form form')).toHaveLength(0);

    await user.clear(within(dialog).getByLabelText('Title'));
    await user.type(within(dialog).getByLabelText('Title'), 'Edit me renamed');
    await user.click(within(dialog).getByText('+ Add link'));
    await user.type(within(dialog).getAllByPlaceholderText('https://...').at(-1)!, 'https://example.com/edit');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(within(dialog).getByText('example.com')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Edit me renamed',
      links: [{ url: 'https://example.com/edit', title: undefined }],
    }));
  });

  it('SubtaskForm: inner Add adds the link without submitting the subtask', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    const { container } = render(<SubtaskForm onSubmit={onSubmit} onCancel={vi.fn()} />);
    await user.type(screen.getByPlaceholderText('Subtask title'), 'Linked sub');
    await user.click(screen.getByText('+ link, due date'));
    await user.click(screen.getByText('+ Add link'));

    expect(container.querySelectorAll('form form')).toHaveLength(0);

    await user.type(screen.getByPlaceholderText('https://...'), 'https://example.com/sub{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('example.com')).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Add' })[0]);
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Linked sub',
      links: [{ url: 'https://example.com/sub', title: undefined }],
    }));
  });
});
