import { useId, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { useConflicts, resolveConflict, type ConflictChoice } from '../../hooks/use-conflicts';
import type { SyncConflict, TaskLink } from '../../db/models';

// Edits two devices made without seeing each other's (sync/conflicts.ts). The
// newer version is already applied; here the user picks the one to keep — or,
// for a text field, writes the one to keep. Nothing waits on this.

const TYPE_LABEL: Record<SyncConflict['entityType'], string> = {
  task: 'Task', subtask: 'Subtask', taskList: 'List', mindmapFolder: 'Mind map folder', mindmap: 'Mind map', mindmapNode: 'Mind map node',
};

const FIELD_LABEL: Record<string, string> = {
  title: 'Title', description: 'Description', link: 'Link', linkTitle: 'Link title', links: 'Links', name: 'Name', label: 'Label',
};

function fieldLabel(conflict: SyncConflict): string {
  if (conflict.kind === 'deleted-remotely') return 'Deleted on another device, edited here';
  if (conflict.kind === 'deleted-locally') return 'Deleted here, edited on another device';
  if (conflict.field.startsWith('discussionLog:')) return 'Discussion note';
  return FIELD_LABEL[conflict.field] ?? conflict.field;
}

/** A text field the user can write a merged version of. */
function isText(conflict: SyncConflict): boolean {
  return conflict.kind === 'field' && conflict.field !== 'links';
}

function ValueView({ value }: { value: unknown }) {
  if (value === undefined || value === null || value === '') {
    return <span className="italic text-zinc-400 dark:text-zinc-500">(empty)</span>;
  }
  if (Array.isArray(value)) {
    return (
      <ul className="list-disc pl-4">
        {(value as TaskLink[]).map((l, i) => <li key={i} className="break-all">{l.title ? `${l.title} — ` : ''}{l.url}</li>)}
      </ul>
    );
  }
  return <span className="whitespace-pre-wrap break-words">{String(value)}</span>;
}

function ConflictCard({ conflict }: { conflict: SyncConflict }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Every card has the same buttons: they point at their card's heading so a
  // screen reader says which item and field they decide.
  const headingId = useId();
  const choose = async (choice: ConflictChoice) => {
    setBusy(true);
    try {
      await resolveConflict(conflict, choice);
    } finally {
      setBusy(false);
    }
  };
  const shown = conflict.applied === 'local' ? conflict.localValue : conflict.remoteValue;

  return (
    <li className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-700">
      <div id={headingId}>
        <div className="text-sm font-medium text-zinc-800 dark:text-zinc-100">
          {TYPE_LABEL[conflict.entityType]}: <span data-redact="true">“{conflict.label || 'untitled'}”</span>
        </div>
        <div className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">{fieldLabel(conflict)}</div>
      </div>

      {conflict.kind === 'field' ? (
        <>
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <div className="rounded-lg bg-zinc-50 p-2 dark:bg-zinc-800/60">
              <div className="mb-1 text-[11px] uppercase tracking-wide text-zinc-400">
                This device{conflict.applied === 'local' ? ' · showing now' : ''}
              </div>
              <div data-redact="true"><ValueView value={conflict.localValue} /></div>
            </div>
            <div className="rounded-lg bg-zinc-50 p-2 dark:bg-zinc-800/60">
              <div className="mb-1 text-[11px] uppercase tracking-wide text-zinc-400">
                Another device{conflict.applied === 'remote' ? ' · showing now' : ''}
              </div>
              <div data-redact="true"><ValueView value={conflict.remoteValue} /></div>
            </div>
          </div>
          {editing !== null ? (
            <div className="mt-2 space-y-2">
              <textarea
                aria-label={`Version of ${fieldLabel(conflict).toLowerCase()} to keep`}
                className="w-full rounded-lg border border-zinc-300 bg-white p-2 text-sm dark:border-zinc-600 dark:bg-zinc-900"
                rows={conflict.field === 'description' || conflict.field.startsWith('discussionLog:') ? 5 : 2}
                value={editing}
                onChange={(e) => setEditing(e.target.value)}
                data-redact="true"
              />
              <div className="flex flex-wrap gap-2">
                <Button aria-describedby={headingId} size="sm" disabled={busy} onClick={() => choose({ value: editing })}>Keep this version</Button>
                <Button aria-describedby={headingId} size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button aria-describedby={headingId} size="sm" variant="secondary" disabled={busy} onClick={() => choose({ keep: 'local' })}>Keep this device’s</Button>
              <Button aria-describedby={headingId} size="sm" variant="secondary" disabled={busy} onClick={() => choose({ keep: 'remote' })}>Keep the other device’s</Button>
              {isText(conflict) && (
                <Button aria-describedby={headingId} size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(typeof shown === 'string' ? shown : '')}>Edit…</Button>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button aria-describedby={headingId} size="sm" variant="secondary" disabled={busy} onClick={() => choose({ restore: true })}>Restore it</Button>
          <Button aria-describedby={headingId} size="sm" variant="secondary" disabled={busy} onClick={() => choose({ restore: false })}>Keep it deleted</Button>
        </div>
      )}
    </li>
  );
}

export function ConflictsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const conflicts = useConflicts();
  return (
    <Modal open={open} onClose={onClose} title="Sync conflicts">
      <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-300">
        These were changed on two devices before either had synced the other’s change. The newer version is shown
        meanwhile; pick the one to keep and it reaches your other devices like any edit.
      </p>
      {conflicts.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">No conflicts.</p>
      ) : (
        <ul className="max-h-[60vh] space-y-3 overflow-y-auto">
          {conflicts.map((c) => <ConflictCard key={c.id} conflict={c} />)}
        </ul>
      )}
    </Modal>
  );
}
