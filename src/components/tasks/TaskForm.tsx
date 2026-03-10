import { useState } from 'react';
import { Modal } from '../ui/Modal';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { isValidUrl, extractHostname } from '../../lib/link-utils';
import { fromInputDate, toInputDate } from '../../lib/date-utils';
import type { Task, TaskLink } from '../../db/models';
import { AddLinkForm } from '../shared/AddLinkForm';
import { computeNextOccurrence } from '../../hooks/use-recurring';

interface Props {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: {
    title: string;
    description?: string;
    link?: string;
    dueDate?: number;
    links?: TaskLink[];
    recurrenceType?: 'time-based' | 'date-based';
    recurrenceInterval?: number;
    recurrenceUnit?: 'hours' | 'days' | 'weeks' | 'months';
    nextOccurrence?: number;
    skipFirst?: boolean;
  }) => void;
  initial?: Partial<Task>;
}

export function TaskForm({ open, onClose, onSubmit, initial }: Props) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [link, setLink] = useState(initial?.link ?? '');
  const [dueDate, setDueDate] = useState(initial?.dueDate ? toInputDate(initial.dueDate) : '');
  const [links, setLinks] = useState<TaskLink[]>(initial?.links ?? []);
  const [addingLink, setAddingLink] = useState(false);

  // Recurrence
  const [recurring, setRecurring] = useState(!!initial?.recurrenceType);
  const [recurrenceType, setRecurrenceType] = useState<'time-based' | 'date-based'>(initial?.recurrenceType ?? 'time-based');
  const [recurrenceInterval, setRecurrenceInterval] = useState(initial?.recurrenceInterval ?? 1);
  const [recurrenceUnit, setRecurrenceUnit] = useState<'hours' | 'days' | 'weeks' | 'months'>(initial?.recurrenceUnit ?? 'days');
  const [skipFirst, setSkipFirst] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;

    const data: Parameters<typeof onSubmit>[0] = {
      title: title.trim(),
      description: description.trim() || undefined,
      link: link.trim() && isValidUrl(link.trim()) ? link.trim() : undefined,
      links: links.length > 0 ? links : undefined,
    };

    if (recurring) {
      data.recurrenceType = recurrenceType;
      data.recurrenceInterval = recurrenceInterval;
      data.recurrenceUnit = recurrenceUnit;
      // Clear dueDate when recurring
      data.dueDate = undefined;
      // Set initial nextOccurrence if not already set
      if (!initial?.nextOccurrence) {
        data.nextOccurrence = computeNextOccurrence(Date.now(), recurrenceInterval, recurrenceUnit);
      }
      if (!initial && skipFirst) data.skipFirst = true;
    } else {
      data.dueDate = dueDate ? fromInputDate(dueDate) : undefined;
      // Clear recurrence when using dueDate
      if (initial?.recurrenceType) {
        data.recurrenceType = undefined;
        data.recurrenceInterval = undefined;
        data.recurrenceUnit = undefined;
        data.nextOccurrence = undefined;
      }
    }

    onSubmit(data);
    setTitle('');
    setDescription('');
    setLink('');
    setDueDate('');
    setLinks([]);
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
        {/* Due date — hidden when recurring */}
        {!recurring && (
          <Input label="Due date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        )}

        {/* Additional links */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Additional links</label>
          {links.map((l, i) => (
            <div key={i} className="flex items-center gap-2 text-sm">
              <a href={l.url} target="_blank" rel="noopener noreferrer" className="text-accent-600 hover:underline dark:text-accent-400 truncate">
                {l.title || extractHostname(l.url)}
              </a>
              <button type="button" onClick={() => setLinks(links.filter((_, j) => j !== i))} className="text-xs text-red-400 hover:text-red-600">
                Remove
              </button>
            </div>
          ))}
          {addingLink ? (
            <AddLinkForm
              onAdd={(url, title) => {
                setLinks([...links, { url, title }]);
                setAddingLink(false);
              }}
              onCancel={() => setAddingLink(false)}
            />
          ) : (
            <button type="button" onClick={() => setAddingLink(true)} className="text-xs text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 text-left">
              + Add link
            </button>
          )}
        </div>

        {/* Recurrence — hidden when dueDate is set */}
        {!dueDate && (
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
              <input type="checkbox" checked={recurring} onChange={(e) => { setRecurring(e.target.checked); if (e.target.checked) setDueDate(''); }} className="shrink-0 rounded" />
              Recurring
            </label>
            {recurring && (
              <>
                <div className="flex items-center gap-2 ml-5">
                  <select
                    value={recurrenceType}
                    onChange={(e) => setRecurrenceType(e.target.value as 'time-based' | 'date-based')}
                    className="rounded border border-zinc-300 bg-white px-2 py-2 md:py-1 text-sm md:text-xs dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                  >
                    <option value="time-based">Time-based</option>
                    <option value="date-based">Date-based</option>
                  </select>
                  <span className="text-sm md:text-xs text-zinc-500">every</span>
                  <input
                    type="number"
                    min={1}
                    value={recurrenceInterval}
                    onChange={(e) => setRecurrenceInterval(Math.max(1, parseInt(e.target.value) || 1))}
                    className="w-16 rounded border border-zinc-300 bg-white px-2 py-2 md:py-1 text-sm md:text-xs dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                  />
                  <select
                    value={recurrenceUnit}
                    onChange={(e) => setRecurrenceUnit(e.target.value as 'hours' | 'days' | 'weeks' | 'months')}
                    className="rounded border border-zinc-300 bg-white px-2 py-2 md:py-1 text-sm md:text-xs dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                  >
                    <option value="hours">hours</option>
                    <option value="days">days</option>
                    <option value="weeks">weeks</option>
                    <option value="months">months</option>
                  </select>
                </div>
                {!initial && (
                  <label className="flex items-center gap-2 ml-5 text-xs text-zinc-500 dark:text-zinc-400">
                    <input type="checkbox" checked={skipFirst} onChange={(e) => setSkipFirst(e.target.checked)} className="shrink-0 rounded" />
                    Skip first (create as done)
                  </label>
                )}
              </>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit">{initial ? 'Save' : 'Create'}</Button>
        </div>
      </form>
    </Modal>
  );
}
