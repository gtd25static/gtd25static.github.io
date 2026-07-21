import { useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';
import { DropdownMenu } from '../ui/DropdownMenu';
import { confirmDialog } from '../ui/ConfirmDialog';
import { useAppState } from '../../stores/app-state';
import type { Mindmap, MindmapFolder } from '../../db/models';
import {
  useMindmapFolders,
  useMindmaps,
  useMindmapNodeCounts,
  createMindmapFolder,
  renameMindmapFolder,
  moveMindmapFolder,
  deleteMindmapFolder,
  getFolderCascade,
  createMindmap,
  renameMindmap,
  moveMindmapToFolder,
  deleteMindmap,
} from '../../hooks/use-mindmaps';
import { MoveToFolderModal } from './MoveToFolderModal';

type NameDialog =
  | { kind: 'new-folder' }
  | { kind: 'new-map' }
  | { kind: 'rename-folder'; folder: MindmapFolder }
  | { kind: 'rename-map'; map: Mindmap };

type MoveDialog =
  | { kind: 'folder'; folder: MindmapFolder }
  | { kind: 'map'; map: Mindmap };

export function MindmapBrowser() {
  const folders = useMindmapFolders();
  const maps = useMindmaps();
  const nodeCounts = useMindmapNodeCounts();
  const { setOpenMindmapId } = useAppState(useShallow((s) => ({ setOpenMindmapId: s.setOpenMindmapId })));

  const [currentFolderId, setCurrentFolderId] = useState<string | undefined>(undefined);
  const [nameDialog, setNameDialog] = useState<NameDialog | null>(null);
  const [moveDialog, setMoveDialog] = useState<MoveDialog | null>(null);

  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);

  // A folder deleted (or synced away) under our feet ⇒ fall back to top level.
  const currentFolder = currentFolderId ? folderById.get(currentFolderId) : undefined;
  const effectiveFolderId = currentFolder?.id;

  const breadcrumb = useMemo(() => {
    const path: MindmapFolder[] = [];
    let cur = currentFolder;
    while (cur && path.length < 32) {
      path.unshift(cur);
      cur = cur.parentId ? folderById.get(cur.parentId) : undefined;
    }
    return path;
  }, [currentFolder, folderById]);

  const shownFolders = useMemo(
    () => folders
      .filter((f) => f.parentId === effectiveFolderId)
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)),
    [folders, effectiveFolderId],
  );
  const shownMaps = useMemo(
    () => maps
      .filter((m) => m.folderId === effectiveFolderId)
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)),
    [maps, effectiveFolderId],
  );

  const mapCountByFolder = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of maps) {
      if (m.folderId) counts.set(m.folderId, (counts.get(m.folderId) ?? 0) + 1);
    }
    for (const f of folders) {
      if (f.parentId) counts.set(f.parentId, (counts.get(f.parentId) ?? 0) + 1);
    }
    return counts;
  }, [maps, folders]);

  async function handleDeleteFolder(folder: MindmapFolder) {
    const cascade = await getFolderCascade(folder.id);
    const parts: string[] = [];
    if (cascade.folderIds.length > 1) parts.push(`${cascade.folderIds.length - 1} subfolder(s)`);
    if (cascade.mapIds.length > 0) parts.push(`${cascade.mapIds.length} map(s)`);
    const contents = parts.length > 0 ? ` It contains ${parts.join(' and ')}.` : '';
    const ok = await confirmDialog(
      `Delete folder “${folder.name}”?${contents} Everything goes to Trash for 30 days.`,
      { confirmLabel: 'Delete', danger: true },
    );
    if (ok) await deleteMindmapFolder(folder.id);
  }

  async function handleDeleteMap(map: Mindmap) {
    const nodes = nodeCounts.get(map.id) ?? 0;
    const ok = await confirmDialog(
      `Delete mindmap “${map.name}”${nodes > 1 ? ` and its ${nodes} nodes` : ''}? It goes to Trash for 30 days.`,
      { confirmLabel: 'Delete', danger: true },
    );
    if (ok) await deleteMindmap(map.id);
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="flex flex-wrap items-center gap-2">
          <nav className="flex min-w-0 flex-1 items-center gap-1 text-sm" aria-label="Folder path">
            <button
              onClick={() => setCurrentFolderId(undefined)}
              className={`shrink-0 rounded px-1 py-0.5 ${breadcrumb.length === 0 ? 'font-medium text-zinc-800 dark:text-zinc-100' : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'}`}
            >
              Mindmaps
            </button>
            {breadcrumb.map((f, i) => (
              <span key={f.id} className="flex min-w-0 items-center gap-1">
                <span className="text-zinc-300 dark:text-zinc-600">›</span>
                <button
                  onClick={() => setCurrentFolderId(f.id)}
                  className={`truncate rounded px-1 py-0.5 ${i === breadcrumb.length - 1 ? 'font-medium text-zinc-800 dark:text-zinc-100' : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'}`}
                >
                  {f.name}
                </button>
              </span>
            ))}
          </nav>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" onClick={() => setNameDialog({ kind: 'new-map' })}>New map</Button>
            <Button size="sm" variant="secondary" onClick={() => setNameDialog({ kind: 'new-folder' })}>New folder</Button>
          </div>
        </div>
      </div>

      {/* Rows */}
      <div className="flex-1 overflow-y-auto px-4 pb-6 pt-3 scrollbar-thin">
        {shownFolders.length === 0 && shownMaps.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center text-center text-zinc-400">
            <p className="text-sm">Nothing here yet.</p>
            <p className="mt-1 text-xs">Create a mindmap or a folder to get started.</p>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl space-y-1">
            {shownFolders.map((folder) => (
              <BrowserRow
                key={folder.id}
                icon={<FolderIcon />}
                name={folder.name}
                detail={`${mapCountByFolder.get(folder.id) ?? 0} item(s)`}
                onOpen={() => setCurrentFolderId(folder.id)}
                menu={[
                  { label: 'Open', onClick: () => setCurrentFolderId(folder.id) },
                  { label: 'Rename', onClick: () => setNameDialog({ kind: 'rename-folder', folder }) },
                  { label: 'Move to…', onClick: () => setMoveDialog({ kind: 'folder', folder }) },
                  { label: 'Delete', danger: true, onClick: () => void handleDeleteFolder(folder) },
                ]}
              />
            ))}
            {shownMaps.map((map) => (
              <BrowserRow
                key={map.id}
                icon={<MapIcon />}
                name={map.name}
                detail={`${nodeCounts.get(map.id) ?? 0} node(s)`}
                onOpen={() => setOpenMindmapId(map.id)}
                menu={[
                  { label: 'Open', onClick: () => setOpenMindmapId(map.id) },
                  { label: 'Rename', onClick: () => setNameDialog({ kind: 'rename-map', map }) },
                  { label: 'Move to…', onClick: () => setMoveDialog({ kind: 'map', map }) },
                  { label: 'Delete', danger: true, onClick: () => void handleDeleteMap(map) },
                ]}
              />
            ))}
          </div>
        )}
      </div>

      {nameDialog && (
        <NameModal
          dialog={nameDialog}
          onClose={() => setNameDialog(null)}
          currentFolderId={effectiveFolderId}
          onOpenMap={(id) => setOpenMindmapId(id)}
        />
      )}
      {moveDialog && (
        <MoveToFolderModal
          open
          onClose={() => setMoveDialog(null)}
          folders={folders}
          excludeSubtreeOf={moveDialog.kind === 'folder' ? moveDialog.folder.id : undefined}
          current={moveDialog.kind === 'folder' ? moveDialog.folder.parentId : moveDialog.map.folderId}
          onMove={(target) => {
            if (moveDialog.kind === 'folder') void moveMindmapFolder(moveDialog.folder.id, target);
            else void moveMindmapToFolder(moveDialog.map.id, target);
          }}
        />
      )}
    </div>
  );
}

function BrowserRow({ icon, name, detail, onOpen, menu }: {
  icon: React.ReactNode;
  name: string;
  detail: string;
  onOpen: () => void;
  menu: { label: string; onClick: () => void; danger?: boolean }[];
}) {
  return (
    <div className="group flex min-h-[52px] md:min-h-[44px] items-center gap-3 rounded-xl border border-zinc-200 bg-white px-3 py-2 transition-colors hover:border-zinc-300 dark:border-zinc-700 dark:bg-zinc-800 dark:hover:border-zinc-600">
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="shrink-0 text-zinc-400">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-zinc-800 dark:text-zinc-100">{name}</span>
          <span className="block text-xs text-zinc-400">{detail}</span>
        </span>
      </button>
      <DropdownMenu
        trigger={
          <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" className="text-zinc-400">
            <path d="M10 6a1.5 1.5 0 110-3 1.5 1.5 0 010 3zM10 11.5a1.5 1.5 0 110-3 1.5 1.5 0 010 3zM10 17a1.5 1.5 0 110-3 1.5 1.5 0 010 3z" />
          </svg>
        }
        items={menu}
      />
    </div>
  );
}

function NameModal({ dialog, onClose, currentFolderId, onOpenMap }: {
  dialog: NameDialog;
  onClose: () => void;
  currentFolderId: string | undefined;
  onOpenMap: (id: string) => void;
}) {
  const initial = dialog.kind === 'rename-folder' ? dialog.folder.name : dialog.kind === 'rename-map' ? dialog.map.name : '';
  const [name, setName] = useState(initial);
  const title =
    dialog.kind === 'new-folder' ? 'New folder'
    : dialog.kind === 'new-map' ? 'New mindmap'
    : dialog.kind === 'rename-folder' ? 'Rename folder'
    : 'Rename mindmap';

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    switch (dialog.kind) {
      case 'new-folder':
        await createMindmapFolder(trimmed, currentFolderId);
        break;
      case 'new-map': {
        const map = await createMindmap(trimmed, currentFolderId);
        if (map) onOpenMap(map.id);
        break;
      }
      case 'rename-folder':
        await renameMindmapFolder(dialog.folder.id, trimmed);
        break;
      case 'rename-map':
        await renameMindmap(dialog.map.id, trimmed);
        break;
    }
    onClose();
  }

  return (
    <Modal open onClose={onClose} title={title}>
      <form
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
        className="space-y-4"
      >
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          maxLength={200}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!name.trim()}>
            {dialog.kind.startsWith('new') ? 'Create' : 'Save'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function FolderIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" strokeLinejoin="round" />
    </svg>
  );
}

function MapIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="5" cy="12" r="2.5" />
      <circle cx="18" cy="5.5" r="2.5" />
      <circle cx="18" cy="18.5" r="2.5" />
      <path d="M7.4 11l8.2-4.3M7.4 13l8.2 4.3" strokeLinecap="round" />
    </svg>
  );
}
