import { useState } from 'react';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { isValidUrl } from '../../lib/link-utils';
import { fromInputDate, toInputDate } from '../../lib/date-utils';
import type { Subtask } from '../../db/models';

interface Props {
  onSubmit: (data: { title: string; link?: string; dueDate?: number }) => void;
  onCancel: () => void;
  initial?: Partial<Subtask>;
}

export function SubtaskForm({ onSubmit, onCancel, initial }: Props) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [link, setLink] = useState(initial?.link ?? '');
  const [dueDate, setDueDate] = useState(initial?.dueDate ? toInputDate(initial.dueDate) : '');
  const [showMore, setShowMore] = useState(!!initial?.link || !!initial?.dueDate);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    onSubmit({
      title: title.trim(),
      link: link.trim() && isValidUrl(link.trim()) ? link.trim() : undefined,
      dueDate: dueDate ? fromInputDate(dueDate) : undefined,
    });
    setTitle('');
    setLink('');
    setDueDate('');
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      <div className="flex gap-2">
        <Input
          placeholder="Subtask title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
          className="flex-1"
        />
        <Button type="submit" size="sm">{initial ? 'Save' : 'Add'}</Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
      {!showMore && (
        <button type="button" onClick={() => setShowMore(true)} className="text-xs text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300">
          + link, due date
        </button>
      )}
      {showMore && (
        <div className="grid grid-cols-2 gap-2">
          <Input placeholder="Link" type="url" value={link} onChange={(e) => setLink(e.target.value)} />
          <Input type="text" placeholder="dd/mm/yyyy" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
      )}
    </form>
  );
}
