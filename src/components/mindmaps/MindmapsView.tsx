import { useAppState } from '../../stores/app-state';
import { useVault } from '../../hooks/use-vault';
import { MindmapBrowser } from './MindmapBrowser';

export function MindmapsView() {
  const openMindmapId = useAppState((s) => s.openMindmapId);
  const { locked } = useVault();

  if (locked) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-zinc-500 dark:text-zinc-400">
        <p className="text-sm">Mindmaps are locked. Unlock the vault to view them.</p>
      </div>
    );
  }

  // The editor branch is wired in MindmapEditor once the canvas exists.
  return <MindmapBrowser key={openMindmapId ?? 'browser'} />;
}
