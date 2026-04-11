// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import { InlineTaskForm } from '../../components/tasks/InlineTaskForm';

describe('InlineTaskForm', () => {
  const onSubmit = vi.fn();
  const onCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderForm() {
    const user = userEvent.setup();
    render(<InlineTaskForm onSubmit={onSubmit} onCancel={onCancel} />);
    return { user };
  }

  it('renders the title input and buttons', () => {
    renderForm();
    expect(screen.getByPlaceholderText('Task title')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('submits with title and calls onCancel', async () => {
    const { user } = renderForm();
    const titleInput = screen.getByPlaceholderText('Task title');
    await user.type(titleInput, 'New task');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ title: 'New task' }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('does not submit with empty title', async () => {
    const { user } = renderForm();
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('trims whitespace from title', async () => {
    const { user } = renderForm();
    await user.type(screen.getByPlaceholderText('Task title'), '  Trimmed  ');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ title: 'Trimmed' }));
  });

  it('calls onCancel when Cancel is clicked', async () => {
    const { user } = renderForm();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('submits on Enter key', async () => {
    const { user } = renderForm();
    await user.type(screen.getByPlaceholderText('Task title'), 'Enter task{Enter}');
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ title: 'Enter task' }));
  });

  it('shows more fields when "+" button is clicked', async () => {
    const { user } = renderForm();
    await user.click(screen.getByText(/description, link, due date/));
    expect(screen.getByPlaceholderText('Description')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Link')).toBeInTheDocument();
    expect(screen.getByLabelText('Due date')).toBeInTheDocument();
  });

  it('submits with description and link', async () => {
    const { user } = renderForm();
    await user.type(screen.getByPlaceholderText('Task title'), 'Full task');
    await user.click(screen.getByText(/description, link, due date/));
    await user.type(screen.getByPlaceholderText('Description'), 'Some details');
    await user.type(screen.getByPlaceholderText('Link'), 'https://example.com');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Full task',
      description: 'Some details',
      link: 'https://example.com',
    }));
  });

  it('shows recurrence fields when Recurring is checked', async () => {
    const { user } = renderForm();
    await user.click(screen.getByText(/description, link, due date/));
    await user.click(screen.getByLabelText('Recurring'));
    expect(screen.getByDisplayValue('days')).toBeInTheDocument();
    // Due date should be hidden when recurring
    expect(screen.queryByLabelText('Due date')).not.toBeInTheDocument();
  });

  it('submits with recurrence data', async () => {
    const { user } = renderForm();
    await user.type(screen.getByPlaceholderText('Task title'), 'Recurring task');
    await user.click(screen.getByText(/description, link, due date/));
    await user.click(screen.getByLabelText('Recurring'));
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Recurring task',
      recurrenceType: 'time-based',
      recurrenceInterval: 1,
      recurrenceUnit: 'days',
      nextOccurrence: expect.any(Number),
    }));
  });
});
