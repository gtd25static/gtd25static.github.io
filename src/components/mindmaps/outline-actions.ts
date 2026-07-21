import { exportMindmapOutline } from '../../hooks/use-mindmaps';
import { toast } from '../ui/Toast';

/** Download a map's markdown outline as a .md file. */
export async function downloadOutline(mapId: string): Promise<void> {
  const result = await exportMindmapOutline(mapId);
  if (!result) {
    toast('Nothing to export.', 'error');
    return;
  }
  const blob = new Blob([result.content], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = result.filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Copy a map's markdown outline to the clipboard. */
export async function copyOutline(mapId: string): Promise<void> {
  const result = await exportMindmapOutline(mapId);
  if (!result) {
    toast('Nothing to export.', 'error');
    return;
  }
  try {
    await navigator.clipboard.writeText(result.content);
    toast('Outline copied to clipboard.', 'success');
  } catch {
    toast('Could not access the clipboard.', 'error');
  }
}
