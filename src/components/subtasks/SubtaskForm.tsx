import { useState } from 'react';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { isValidUrl, extractHostname } from '../../lib/link-utils';
import { fromInputDate, toInputDate } from '../../lib/date-utils';
import type { Subtask, TaskLink } from '../../db/models';
import { AddLinkForm } from '../shared/AddLinkForm';

interface Props {
  onSubmit: (data: { title: string; link?: string; dueDate?: number; links?: TaskLink[] }) => void;
  onCancel: () => void;
  initial?: Partial<Subtask>;
}

export function SubtaskForm({ onSubmit, onCancel, initial }: Props) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [link, setLink] = useState(initial?.link ?? '');
  const [dueDate, setDueDate] = useState(initial?.dueDate ? toInputDate(initial.dueDate) : '');
  const [links, setLinks] = useState<TaskLink[]>(initial?.links ?? []);
  const [addingLink, setAddingLink] = useState(false);
  const [showMore, setShowMore] = useState(!!initial?.link || !!initial?.dueDate || (initial?.links ?? []).length > 0);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    onSubmit({
      title: title.trim(),
      link: link.trim() && isValidUrl(link.trim()) ? link.trim() : undefined,
      dueDate: dueDate ? fromInputDate(dueDate) : undefined,
      links: links.length > 0 ? links : undefined,
    });
    setTitle('');
    setLink('');
    setDueDate('');
    setLinks([]);
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
        <>
          <div className="grid grid-cols-2 gap-2">
            <Input placeholder="Link" type="url" value={link} onChange={(e) => setLink(e.target.value)} />
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          {links.map((l, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <a href={l.url} target="_blank" rel="noopener noreferrer" className="text-accent-600 hover:underline dark:text-accent-400 truncate">
                {l.title || extractHostname(l.url)}
              </a>
              <button type="button" onClick={() => setLinks(links.filter((_, j) => j !== i))} className="text-red-400 hover:text-red-600">
                Remove
              </button>
            </div>
          ))}
          {addingLink ? (
            <AddLinkForm
              onAdd={(url, linkTitle) => {
                setLinks([...links, { url, title: linkTitle }]);
                setAddingLink(false);
              }}
              onCancel={() => setAddingLink(false)}
            />
          ) : (
            <button type="button" onClick={() => setAddingLink(true)} className="text-xs text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300">
              + Add link
            </button>
          )}
        </>
      )}
    </form>
  );
}
