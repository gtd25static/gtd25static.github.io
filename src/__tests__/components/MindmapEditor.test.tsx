// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import type { Mindmap } from '../../db/models';

const now = Date.now();
const map: Mindmap = { id: 'm1', name: 'Plan', folderId: 'f1', order: 0, createdAt: now, updatedAt: now };

vi.mock('../../hooks/use-mindmaps', () => ({
  useMindmap: () => map,
  useMindmapNodes: () => [],
}));
vi.mock('../../components/mindmaps/MindmapCanvas', () => ({ MindmapCanvas: () => null }));
vi.mock('../../components/mindmaps/MindmapStyleToolbar', () => ({ MindmapStyleToolbar: () => null }));

import { MindmapEditor } from '../../components/mindmaps/MindmapEditor';
import { useAppState } from '../../stores/app-state';

describe('MindmapEditor', () => {
  // "Back" returned to the top level even for a map inside a folder — also
  // when the map was opened from somewhere else, like search.
  it('Back returns to the folder the map lives in', async () => {
    useAppState.setState({ openMindmapId: 'm1', mindmapFolderId: undefined });
    const user = userEvent.setup();
    render(<MindmapEditor mapId="m1" />);

    await user.click(screen.getByRole('button', { name: 'Back to mindmaps' }));

    expect(useAppState.getState().openMindmapId).toBeNull();
    expect(useAppState.getState().mindmapFolderId).toBe('f1');
  });
});
