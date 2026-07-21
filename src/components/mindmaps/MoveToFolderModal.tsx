import { useMemo, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import type { MindmapFolder } from '../../db/models';

interface Props {
  open: boolean;
  onClose: () => void;
  folders: MindmapFolder[];
  /** Exclude this folder and its subtree from the choices (moving a folder). */
  excludeSubtreeOf?: string;
  /** Preselected location (undefined = top level). */
  current?: string;
  onMove: (folderId: string | undefined) => void;
}

interface FolderOption {
  folder: MindmapFolder;
  depth: number;
}

export function MoveToFolderModal({ open, onClose, folders, excludeSubtreeOf, current, onMove }: Props) {
  const [selected, setSelected] = useState<string | undefined>(current);

  const options = useMemo(() => {
    const excluded = new Set<string>();
    if (excludeSubtreeOf) {
      excluded.add(excludeSubtreeOf);
      let grew = true;
      while (grew) {
        grew = false;
        for (const f of folders) {
          if (f.parentId && excluded.has(f.parentId) && !excluded.has(f.id)) {
            excluded.add(f.id);
            grew = true;
          }
        }
      }
    }
    const byParent = new Map<string | undefined, MindmapFolder[]>();
    for (const f of folders) {
      if (excluded.has(f.id)) continue;
      const key = f.parentId;
      const list = byParent.get(key) ?? [];
      list.push(f);
      byParent.set(key, list);
    }
    const result: FolderOption[] = [];
    const walk = (parentId: string | undefined, depth: number) => {
      const children = (byParent.get(parentId) ?? []).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
      for (const f of children) {
        result.push({ folder: f, depth });
        walk(f.id, depth + 1);
      }
    };
    walk(undefined, 0);
    return result;
  }, [folders, excludeSubtreeOf]);

  return (
    <Modal open={open} onClose={onClose} title="Move to…">
      <div className="max-h-72 space-y-0.5 overflow-y-auto scrollbar-thin">
        <LocationRow
          label="Top level"
          depth={0}
          selected={selected === undefined}
          onSelect={() => setSelected(undefined)}
        />
        {options.map(({ folder, depth }) => (
          <LocationRow
            key={folder.id}
            label={folder.name}
            depth={depth + 1}
            selected={selected === folder.id}
            onSelect={() => setSelected(folder.id)}
          />
        ))}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button onClick={() => { onMove(selected); onClose(); }}>Move</Button>
      </div>
    </Modal>
  );
}

function LocationRow({ label, depth, selected, onSelect }: {
  label: string;
  depth: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`flex w-full min-h-[44px] md:min-h-0 items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors ${
        selected
          ? 'bg-accent-50 text-accent-700 font-medium dark:bg-accent-900/20 dark:text-accent-300'
          : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'
      }`}
      style={{ paddingLeft: `${8 + depth * 18}px` }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={selected ? 'text-accent-600' : 'text-zinc-400'}>
        <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" strokeLinejoin="round" />
      </svg>
      <span className="truncate">{label}</span>
      {selected && (
        <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" className="ml-auto text-accent-600">
          <path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-8 8a1 1 0 01-1.4 0l-4-4a1 1 0 111.4-1.4L8 12.6l7.3-7.3a1 1 0 011.4 0z" clipRule="evenodd" />
        </svg>
      )}
    </button>
  );
}
