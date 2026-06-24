import { useState } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { toast } from '../ui/Toast';
import { mergeTasks, unmergeTasks, combineTaskContent } from '../../hooks/use-merge';
import type { MergeSuggestionGroup } from '../../hooks/use-merge-suggestions';
import type { Task, ListType } from '../../db/models';

interface Props {
  group: MergeSuggestionGroup;
  listType: ListType;
  onClose: () => void;
  onMerged: () => void;
}

/** Rough "most complete" score, used to pre-select the default survivor. */
function completeness(t: Task): number {
  return (
    (t.description?.trim().length ?? 0) +
    (t.links?.length ?? 0) * 50 +
    (t.link ? 50 : 0) +
    (t.discussionLog?.length ?? 0) * 30 +
    (t.starred ? 10 : 0)
  );
}

function pickDefaultSurvivor(tasks: Task[]): string {
  return [...tasks].sort((a, b) => completeness(b) - completeness(a) || b.updatedAt - a.updatedAt)[0]?.id ?? '';
}

export function MergeModal({ group, listType, onClose, onMerged }: Props) {
  const [survivorId, setSurvivorId] = useState(() => pickDefaultSurvivor(group.tasks));
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const included = group.tasks.filter((t) => !excluded.has(t.id));
  const survivor = included.find((t) => t.id === survivorId) ?? included[0];
  const sources = survivor ? included.filter((t) => t.id !== survivor.id) : [];
  const canMerge = included.length >= 2 && !!survivor;
  const preview = survivor ? { ...survivor, ...combineTaskContent(survivor, sources) } : null;
  const previewLinks = (preview?.links?.length ?? 0) + (preview?.link ? 1 : 0);

  function toggleExclude(id: string) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleMerge() {
    if (!survivor || !canMerge || busy) return;
    setBusy(true);
    const snapshot = await mergeTasks(
      survivor.id,
      sources.map((t) => t.id),
    );
    setBusy(false);
    if (snapshot) {
      const n = sources.length + 1;
      toast(`Merged ${n} entries`, 'success', () => unmergeTasks(snapshot));
    }
    onMerged();
  }

  return (
    <Modal open onClose={onClose} title="Merge duplicates">
      <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
        Pick the entry to keep. The others are folded into it (description, links
        {listType === 'follow-ups' ? ', discussion history' : ''}) and moved to Trash.
      </p>

      <ul className="mb-4 flex flex-col gap-1.5">
        {group.tasks.map((t) => {
          const isExcluded = excluded.has(t.id);
          const isSurvivor = survivor?.id === t.id;
          return (
            <li
              key={t.id}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
                isExcluded
                  ? 'border-zinc-200 opacity-50 dark:border-zinc-800'
                  : isSurvivor
                    ? 'border-accent-300 bg-accent-50/60 dark:border-accent-800 dark:bg-accent-900/20'
                    : 'border-zinc-200 dark:border-zinc-800'
              }`}
            >
              <input
                type="radio"
                name="merge-survivor"
                checked={isSurvivor}
                disabled={isExcluded}
                onChange={() => setSurvivorId(t.id)}
                className="accent-accent-600"
                aria-label={`Keep "${t.title}"`}
              />
              <span className="min-w-0 flex-1 truncate text-sm text-zinc-700 dark:text-zinc-200">
                {t.title || '(untitled)'}
              </span>
              {isSurvivor && (
                <span className="shrink-0 rounded-full bg-accent-600 px-2 py-0.5 text-[10px] font-medium text-white">
                  Keep
                </span>
              )}
              <button
                type="button"
                onClick={() => toggleExclude(t.id)}
                className="shrink-0 rounded px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800"
              >
                {isExcluded ? 'Include' : 'Remove'}
              </button>
            </li>
          );
        })}
      </ul>

      {preview && (
        <div className="mb-4 rounded-lg bg-zinc-50 p-3 text-sm dark:bg-zinc-800/50">
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-400">Result</div>
          <div className="font-medium text-zinc-800 dark:text-zinc-100">{preview.title || '(untitled)'}</div>
          {preview.description && (
            <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-zinc-600 dark:text-zinc-300">
              {preview.description}
            </p>
          )}
          {(previewLinks > 0 ||
            (listType === 'follow-ups' && (preview.discussionLog?.length ?? 0) > 0)) && (
            <div className="mt-2 flex flex-wrap gap-3 text-xs text-zinc-500 dark:text-zinc-400">
              {previewLinks > 0 && <span>{previewLinks} link{previewLinks === 1 ? '' : 's'}</span>}
              {listType === 'follow-ups' && (preview.discussionLog?.length ?? 0) > 0 && (
                <span>
                  {preview.discussionLog!.length} discussion{' '}
                  {preview.discussionLog!.length === 1 ? 'entry' : 'entries'}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        {!canMerge && <span className="mr-auto text-xs text-zinc-400">Select at least 2 entries</span>}
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" disabled={!canMerge || busy} onClick={handleMerge}>
          {busy ? 'Merging…' : `Merge ${included.length}`}
        </Button>
      </div>
    </Modal>
  );
}
