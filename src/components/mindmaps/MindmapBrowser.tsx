import { useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';
import { DropdownMenu } from '../ui/DropdownMenu';
import { confirmDialog } from '../ui/ConfirmDialog';
import { useAppState } from '../../stores/app-state';
import { useMindmapUi } from '../../stores/mindmap-ui';
import type { Mindmap, MindmapFolder } from '../../db/models';
import { isBlankFilter, MAX_SAVED_SEARCH_LENGTH } from '../../lib/list-filter';
import { folderPathNames, searchMindmaps } from '../../lib/mindmap-search';
import {
  useMindmapFolders,
  useMindmaps,
  useMindmapNodeCounts,
  useAllMindmapNodes,
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
import { OutlineImportModal } from './OutlineImportModal';
import { downloadOutline } from './outline-actions';

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
  // The folder lives in app state: opening a map unmounts the browser, and "Back"
  // used to land at the top level instead of the folder the map was opened from.
  const { setOpenMindmapId, currentFolderId, setCurrentFolderId } = useAppState(useShallow((s) => ({
    setOpenMindmapId: s.setOpenMindmapId,
    currentFolderId: s.mindmapFolderId,
    setCurrentFolderId: s.setMindmapFolderId,
  })));
  const [nameDialog, setNameDialog] = useState<NameDialog | null>(null);
  const [moveDialog, setMoveDialog] = useState<MoveDialog | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  // The search spans every folder; with "Node text" on it also looks inside
  // each map, one node at a time (lib/mindmap-search.ts).
  const { query, setQuery, searchNodeText, setSearchNodeText, setMapSearch } = useMindmapUi(useShallow((s) => ({
    query: s.browserSearch,
    setQuery: s.setBrowserSearch,
    searchNodeText: s.searchNodeText,
    setSearchNodeText: s.setSearchNodeText,
    setMapSearch: s.setMapSearch,
  })));
  const searching = !isBlankFilter(query);
  const searchedNodes = useAllMindmapNodes(searching && searchNodeText);

  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const results = useMemo(
    () => searchMindmaps(query, folders, maps, searchNodeText ? searchedNodes : null),
    [query, folders, maps, searchNodeText, searchedNodes],
  );
  // Folder names are content: redact mode hides them here as in the breadcrumb.
  const pathLabel = (folderId: string | undefined) => (
    <span data-redact>{folderPathNames(folderId, folderById).join(' › ') || 'Top level'}</span>
  );

  // Every open from here starts the map with the search it was found by (a
  // node hit), or none — never with one left over from its last visit.
  function openMap(id: string, nodeQuery = '') {
    setMapSearch(nodeQuery ? { mapId: id, query: nodeQuery } : null);
    setOpenMindmapId(id);
  }

  function openFolder(id: string) {
    setQuery('');
    setCurrentFolderId(id);
  }

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
      .sort((a, b) => a.order - b.order || (a.name ?? '').localeCompare(b.name ?? '')), // `??`: see isMergeCandidate
    [folders, effectiveFolderId],
  );
  const shownMaps = useMemo(
    () => maps
      .filter((m) => m.folderId === effectiveFolderId)
      .sort((a, b) => a.order - b.order || (a.name ?? '').localeCompare(b.name ?? '')), // `??`: see isMergeCandidate
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

  const folderMenu = (folder: MindmapFolder) => [
    { label: 'Open', onClick: () => openFolder(folder.id) },
    { label: 'Rename', onClick: () => setNameDialog({ kind: 'rename-folder', folder }) },
    { label: 'Move to…', onClick: () => setMoveDialog({ kind: 'folder', folder }) },
    { label: 'Delete', danger: true, onClick: () => void handleDeleteFolder(folder) },
  ];
  const mapMenu = (map: Mindmap) => [
    { label: 'Open', onClick: () => openMap(map.id) },
    { label: 'Rename', onClick: () => setNameDialog({ kind: 'rename-map', map }) },
    { label: 'Move to…', onClick: () => setMoveDialog({ kind: 'map', map }) },
    { label: 'Export outline (.md)', onClick: () => void downloadOutline(map.id) },
    { label: 'Delete', danger: true, onClick: () => void handleDeleteMap(map) },
  ];

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
                  data-redact
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
            <Button size="sm" variant="secondary" onClick={() => setImportOpen(true)}>Import</Button>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <div className="relative w-52 sm:w-64">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" strokeLinecap="round" />
            </svg>
            <input
              type="text"
              enterKeyHint="search"
              data-redact
              value={query}
              maxLength={MAX_SAVED_SEARCH_LENGTH}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('');
                if (e.key === 'Escape' || e.key === 'Enter') e.currentTarget.blur();
              }}
              placeholder={searchNodeText ? 'Search maps and nodes…' : 'Search maps…'}
              aria-label="Search mindmaps"
              className="h-8 w-full rounded-full border border-transparent bg-zinc-100 pl-7 pr-7 text-sm text-zinc-800 placeholder:text-zinc-400 focus:border-accent-500 focus:bg-white focus:outline-none md:h-7 dark:bg-zinc-800 dark:text-zinc-200 dark:placeholder:text-zinc-500 dark:focus:bg-zinc-900"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
              >
                <svg width="12" height="12" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              </button>
            )}
          </div>
          <button
            type="button"
            aria-pressed={searchNodeText}
            onClick={() => setSearchNodeText(!searchNodeText)}
            title="Also search the text of every node, in every map"
            className={`flex h-8 shrink-0 items-center rounded-full px-3 text-sm md:h-7 md:text-xs ${
              searchNodeText
                ? 'bg-accent-100 text-accent-700 dark:bg-accent-900/40 dark:text-accent-300'
                : 'bg-zinc-100 text-zinc-600 hover:text-zinc-800 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:text-zinc-100'
            }`}
          >
            Node text
          </button>
        </div>
      </div>

      {/* Rows */}
      <div className="flex-1 overflow-y-auto px-4 pb-24 pt-3 scrollbar-thin">
        {searching ? (
          results.folders.length === 0 && results.maps.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center text-zinc-400">
              <p data-redact className="text-sm">Nothing matches “{query.trim()}”.</p>
              {!searchNodeText && <p className="mt-1 text-xs">Turn on “Node text” to search inside the maps too.</p>}
            </div>
          ) : (
            <div className="mx-auto w-full max-w-3xl space-y-1">
              {results.folders.map((folder) => (
                <BrowserRow
                  key={folder.id}
                  icon={<FolderIcon />}
                  name={folder.name}
                  detail={pathLabel(folder.parentId)}
                  onOpen={() => openFolder(folder.id)}
                  menu={folderMenu(folder)}
                />
              ))}
              {results.maps.map(({ map, nodeTexts }) => (
                <BrowserRow
                  key={map.id}
                  icon={<MapIcon />}
                  name={map.name}
                  detail={<>{pathLabel(map.folderId)} · {nodeCounts.get(map.id) ?? 0} node(s)</>}
                  onOpen={() => openMap(map.id, nodeTexts.length > 0 ? query : '')}
                  menu={mapMenu(map)}
                  nodeHits={nodeTexts}
                />
              ))}
            </div>
          )
        ) : shownFolders.length === 0 && shownMaps.length === 0 ? (
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
                menu={folderMenu(folder)}
              />
            ))}
            {shownMaps.map((map) => (
              <BrowserRow
                key={map.id}
                icon={<MapIcon />}
                name={map.name}
                detail={`${nodeCounts.get(map.id) ?? 0} node(s)`}
                onOpen={() => openMap(map.id)}
                menu={mapMenu(map)}
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
      <OutlineImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        folderId={effectiveFolderId}
        onImported={(id) => setOpenMindmapId(id)}
      />
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

// How many matching nodes a search result names before "+N more".
const NODE_HITS_SHOWN = 3;

function BrowserRow({ icon, name, detail, onOpen, menu, nodeHits }: {
  icon: React.ReactNode;
  name: string;
  detail: React.ReactNode;
  onOpen: () => void;
  menu: { label: string; onClick: () => void; danger?: boolean }[];
  /** A search result's matching nodes, as text. */
  nodeHits?: string[];
}) {
  return (
    <div className="group flex min-h-[52px] md:min-h-[44px] items-center gap-3 rounded-xl border border-zinc-200 bg-white px-3 py-2 transition-colors hover:border-zinc-300 dark:border-zinc-700 dark:bg-zinc-800 dark:hover:border-zinc-600">
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="shrink-0 text-zinc-400">{icon}</span>
        <span className="min-w-0 flex-1">
          <span data-redact className="block truncate text-sm text-zinc-800 dark:text-zinc-100">{name}</span>
          <span className="block truncate text-xs text-zinc-400">{detail}</span>
          {nodeHits && nodeHits.length > 0 && (
            <span data-redact className="block truncate text-xs text-amber-700 dark:text-amber-400">
              {nodeHits.slice(0, NODE_HITS_SHOWN).map((t) => t.replace(/\s+/g, ' ')).join(' · ')}
              {nodeHits.length > NODE_HITS_SHOWN && ` · +${nodeHits.length - NODE_HITS_SHOWN} more`}
            </span>
          )}
        </span>
      </button>
      <DropdownMenu
        label="Options"
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

  // A double click / double Enter submitted twice and created the map twice.
  const inFlight = useRef(false);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || inFlight.current) return;
    inFlight.current = true;
    try {
      await save(trimmed);
    } finally {
      inFlight.current = false;
    }
    onClose();
  }

  async function save(trimmed: string) {
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
  }

  return (
    <Modal open onClose={onClose} title={title}>
      <form
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
        className="space-y-4"
      >
        <Input
          data-redact
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
