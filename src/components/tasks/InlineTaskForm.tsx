import { useState } from 'react';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { isValidUrl, extractHostname } from '../../lib/link-utils';
import { fromInputDate } from '../../lib/date-utils';
import { computeNextOccurrence } from '../../hooks/use-recurring';
import { AddLinkForm } from '../shared/AddLinkForm';
import type { TaskLink } from '../../db/models';

interface Props {
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
  onCancel: () => void;
}

export function InlineTaskForm({ onSubmit, onCancel }: Props) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [link, setLink] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [showMore, setShowMore] = useState(false);

  // Recurrence
  const [recurring, setRecurring] = useState(false);
  const [recurrenceType, setRecurrenceType] = useState<'time-based' | 'date-based'>('time-based');
  const [recurrenceInterval, setRecurrenceInterval] = useState(1);
  const [recurrenceUnit, setRecurrenceUnit] = useState<'hours' | 'days' | 'weeks' | 'months'>('days');
  const [skipFirst, setSkipFirst] = useState(false);

  // Additional links
  const [links, setLinks] = useState<TaskLink[]>([]);
  const [addingLink, setAddingLink] = useState(false);

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
      data.nextOccurrence = computeNextOccurrence(Date.now(), recurrenceInterval, recurrenceUnit);
      if (skipFirst) data.skipFirst = true;
    } else {
      data.dueDate = dueDate ? fromInputDate(dueDate) : undefined;
    }

    onSubmit(data);
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
          + description, link, due date, recurrence
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
          <Input placeholder="Link" type="url" value={link} onChange={(e) => setLink(e.target.value)} />

          {/* Due date OR Recurrence — mutually exclusive */}
          {!recurring && (
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} label="Due date" />
          )}
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
                <label className="flex items-center gap-2 ml-5 text-xs text-zinc-500 dark:text-zinc-400">
                  <input type="checkbox" checked={skipFirst} onChange={(e) => setSkipFirst(e.target.checked)} className="shrink-0 rounded" />
                  Skip first (create as done)
                </label>
              </>
            )}
          </div>

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
                onAdd={(url, linkTitle) => {
                  setLinks([...links, { url, title: linkTitle }]);
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
        </div>
      )}
    </form>
  );
}
