import { useState } from 'react';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { isValidUrl } from '../../lib/link-utils';
import { fromInputDate } from '../../lib/date-utils';

interface Props {
  onSubmit: (data: {
    title: string;
    description?: string;
    link?: string;
    dueDate?: number;
  }) => void;
  onCancel: () => void;
}

export function InlineTaskForm({ onSubmit, onCancel }: Props) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [link, setLink] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [showMore, setShowMore] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    onSubmit({
      title: title.trim(),
      description: description.trim() || undefined,
      link: link.trim() && isValidUrl(link.trim()) ? link.trim() : undefined,
      dueDate: dueDate ? fromInputDate(dueDate) : undefined,
    });
    onCancel();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2 py-3">
      <div className="flex gap-2">
        <Input
          placeholder="Task title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
          className="flex-1"
        />
        <Button type="submit" size="sm">Add</Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
      {!showMore && (
        <button type="button" onClick={() => setShowMore(true)} className="text-xs text-zinc-400 hover:text-zinc-600 dark:text-zinc-400 dark:hover:text-zinc-300">
          + description, link, due date
        </button>
      )}
      {showMore && (
        <div className="space-y-2">
          <div className="flex flex-col gap-1">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Description"
              className="rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-900 placeholder:text-zinc-400
                focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500
                dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Input placeholder="Link" type="url" value={link} onChange={(e) => setLink(e.target.value)} />
            <Input type="text" placeholder="dd/mm/yyyy" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
        </div>
      )}
    </form>
  );
}
