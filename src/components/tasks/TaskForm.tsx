import { useState } from 'react';
import { Modal } from '../ui/Modal';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { isValidUrl } from '../../lib/link-utils';
import { fromInputDate, toInputDate } from '../../lib/date-utils';
import type { Task } from '../../db/models';

interface Props {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: {
    title: string;
    description?: string;
    link?: string;
    dueDate?: number;
  }) => void;
  initial?: Partial<Task>;
}

export function TaskForm({ open, onClose, onSubmit, initial }: Props) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [link, setLink] = useState(initial?.link ?? '');
  const [dueDate, setDueDate] = useState(initial?.dueDate ? toInputDate(initial.dueDate) : '');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    onSubmit({
      title: title.trim(),
      description: description.trim() || undefined,
      link: link.trim() && isValidUrl(link.trim()) ? link.trim() : undefined,
      dueDate: dueDate ? fromInputDate(dueDate) : undefined,
    });
    setTitle('');
    setDescription('');
    setLink('');
    setDueDate('');
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title={initial ? 'Edit Task' : 'New Task'}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus required />
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400
              focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500
              dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500"
          />
        </div>
        <Input label="Link" type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://..." />
        <Input label="Due date" type="text" placeholder="dd/mm/yyyy" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit">{initial ? 'Save' : 'Create'}</Button>
        </div>
      </form>
    </Modal>
  );
}
