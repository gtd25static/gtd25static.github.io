import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppState } from '../../stores/app-state';
import { useMindmap, useMindmapNodes } from '../../hooks/use-mindmaps';
import { MindmapCanvas } from './MindmapCanvas';
import { DropdownMenu } from '../ui/DropdownMenu';
import { downloadOutline, copyOutline } from './outline-actions';

export function MindmapEditor({ mapId }: { mapId: string }) {
  const map = useMindmap(mapId);
  const nodes = useMindmapNodes(mapId);
  const { setOpenMindmapId } = useAppState(useShallow((s) => ({ setOpenMindmapId: s.setOpenMindmapId })));

  // Map deleted (locally or by sync) → back to the browser.
  useEffect(() => {
    if (map && map.deletedAt) setOpenMindmapId(null);
  }, [map, setOpenMindmapId]);

  if (!map || map.deletedAt) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">
        This mindmap no longer exists.
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
        <button
          onClick={() => setOpenMindmapId(null)}
          aria-label="Back to mindmaps"
          className="flex h-10 w-10 md:h-8 md:w-8 shrink-0 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <h1 className="min-w-0 flex-1 truncate text-base font-medium text-zinc-800 dark:text-zinc-100">
          {map.name}
        </h1>
        <span className="shrink-0 text-xs text-zinc-400">{nodes.length} node(s)</span>
        <DropdownMenu
          trigger={
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-500 dark:text-zinc-400" aria-label="Export">
              <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />
            </svg>
          }
          items={[
            { label: 'Download outline (.md)', onClick: () => void downloadOutline(mapId) },
            { label: 'Copy outline', onClick: () => void copyOutline(mapId) },
          ]}
        />
      </div>
      <MindmapCanvas mapId={mapId} />
    </div>
  );
}
