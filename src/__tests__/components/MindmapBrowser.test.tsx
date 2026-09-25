// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '../setup-component';
import type { Mindmap, MindmapFolder } from '../../db/models';

const mockUseFolders = vi.fn<() => MindmapFolder[]>(() => []);
const mockUseMaps = vi.fn<() => Mindmap[]>(() => []);
const mockCreateMap = vi.fn(async (name: string) => makeMap({ name }));
const mockCreateFolder = vi.fn(async (name: string) => makeFolder({ name }));
const mockDeleteMap = vi.fn(async () => {});
const mockRenameMap = vi.fn(async () => {});

vi.mock('../../hooks/use-mindmaps', () => ({
  useMindmapFolders: () => mockUseFolders(),
  useMindmaps: () => mockUseMaps(),
  useMindmapNodeCounts: () => new Map([['m1', 5]]),
  createMindmapFolder: (...args: unknown[]) => (mockCreateFolder as (...a: unknown[]) => unknown)(...args),
  renameMindmapFolder: vi.fn(),
  moveMindmapFolder: vi.fn(),
  deleteMindmapFolder: vi.fn(),
  getFolderCascade: vi.fn(async () => ({ folderIds: ['f1'], mapIds: [], nodeCount: 0 })),
  createMindmap: (...args: unknown[]) => (mockCreateMap as (...a: unknown[]) => unknown)(...args),
  renameMindmap: (...args: unknown[]) => (mockRenameMap as (...a: unknown[]) => unknown)(...args),
  moveMindmapToFolder: vi.fn(),
  deleteMindmap: (...args: unknown[]) => (mockDeleteMap as (...a: unknown[]) => unknown)(...args),
}));

import { MindmapBrowser } from '../../components/mindmaps/MindmapBrowser';
import { useAppState } from '../../stores/app-state';

function makeFolder(overrides: Partial<MindmapFolder> = {}): MindmapFolder {
  const now = Date.now();
  return { id: 'f1', name: 'Folder', order: 0, createdAt: now, updatedAt: now, ...overrides };
}

function makeMap(overrides: Partial<Mindmap> = {}): Mindmap {
  const now = Date.now();
  return { id: 'm1', name: 'Map', order: 0, createdAt: now, updatedAt: now, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseFolders.mockReturnValue([]);
  mockUseMaps.mockReturnValue([]);
  useAppState.setState({ openMindmapId: null, mindmapFolderId: undefined });
});

describe('MindmapBrowser', () => {
  it('shows an empty state when there is nothing', () => {
    render(<MindmapBrowser />);
    expect(screen.getByText('Nothing here yet.')).toBeInTheDocument();
  });

  it('lists folders first, then maps, with counts', () => {
    mockUseFolders.mockReturnValue([makeFolder({ id: 'f1', name: 'Ideas' })]);
    mockUseMaps.mockReturnValue([makeMap({ id: 'm1', name: 'Plan' })]);
    render(<MindmapBrowser />);
    expect(screen.getByText('Ideas')).toBeInTheDocument();
    expect(screen.getByText('Plan')).toBeInTheDocument();
    expect(screen.getByText('5 node(s)')).toBeInTheDocument();
  });

  it('navigates into a folder and shows the breadcrumb', async () => {
    const user = userEvent.setup();
    mockUseFolders.mockReturnValue([makeFolder({ id: 'f1', name: 'Ideas' })]);
    mockUseMaps.mockReturnValue([
      makeMap({ id: 'm1', name: 'Inside', folderId: 'f1' }),
      makeMap({ id: 'm2', name: 'Outside' }),
    ]);
    render(<MindmapBrowser />);
    expect(screen.queryByText('Inside')).not.toBeInTheDocument();
    await user.click(screen.getByText('Ideas'));
    expect(screen.getByText('Inside')).toBeInTheDocument();
    expect(screen.queryByText('Outside')).not.toBeInTheDocument();
    // Breadcrumb back to top
    await user.click(screen.getByRole('button', { name: 'Mindmaps' }));
    expect(screen.getByText('Outside')).toBeInTheDocument();
  });

  // Opening a map unmounts the browser; its folder was local state, so "Back"
  // from a map inside a folder landed at the top level.
  it('comes back in the folder it was showing', async () => {
    const user = userEvent.setup();
    mockUseFolders.mockReturnValue([makeFolder({ id: 'f1', name: 'Ideas' })]);
    mockUseMaps.mockReturnValue([
      makeMap({ id: 'm1', name: 'Inside', folderId: 'f1' }),
      makeMap({ id: 'm2', name: 'Outside' }),
    ]);
    const { unmount } = render(<MindmapBrowser />);
    await user.click(screen.getByText('Ideas'));
    unmount();

    render(<MindmapBrowser />);
    expect(screen.getByText('Inside')).toBeInTheDocument();
    expect(screen.queryByText('Outside')).not.toBeInTheDocument();
  });

  it('creates a map via the New map modal and opens it', async () => {
    const user = userEvent.setup();
    mockCreateMap.mockResolvedValue(makeMap({ id: 'new-map', name: 'Fresh' }));
    render(<MindmapBrowser />);
    await user.click(screen.getByRole('button', { name: 'New map' }));
    await user.type(screen.getByPlaceholderText('Name'), 'Fresh');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(mockCreateMap).toHaveBeenCalledWith('Fresh', undefined));
    expect(useAppState.getState().openMindmapId).toBe('new-map');
  });

  it('a double click on Create makes one map, not two', async () => {
    const user = userEvent.setup();
    let resolve!: (m: Mindmap) => void;
    mockCreateMap.mockImplementation(() => new Promise((r) => { resolve = r; }));
    render(<MindmapBrowser />);
    await user.click(screen.getByRole('button', { name: 'New map' }));
    await user.type(screen.getByPlaceholderText('Name'), 'Once');
    const create = screen.getByRole('button', { name: 'Create' });
    await user.dblClick(create);
    resolve(makeMap({ id: 'once' }));
    await waitFor(() => expect(mockCreateMap).toHaveBeenCalledTimes(1));
  });

  it('a double click on Create makes one folder, not two', async () => {
    const user = userEvent.setup();
    let resolve!: (f: MindmapFolder) => void;
    mockCreateFolder.mockImplementation(() => new Promise((r) => { resolve = r; }));
    render(<MindmapBrowser />);
    await user.click(screen.getByRole('button', { name: 'New folder' }));
    await user.type(screen.getByPlaceholderText('Name'), 'Once');
    await user.dblClick(screen.getByRole('button', { name: 'Create' }));
    resolve(makeFolder({ id: 'once' }));
    await waitFor(() => expect(mockCreateFolder).toHaveBeenCalledTimes(1));
  });

  it('opens a map from its row', async () => {
    const user = userEvent.setup();
    mockUseMaps.mockReturnValue([makeMap({ id: 'm1', name: 'Plan' })]);
    render(<MindmapBrowser />);
    await user.click(screen.getByText('Plan'));
    expect(useAppState.getState().openMindmapId).toBe('m1');
  });

  it('creates a folder inside the current folder', async () => {
    const user = userEvent.setup();
    mockUseFolders.mockReturnValue([makeFolder({ id: 'f1', name: 'Ideas' })]);
    render(<MindmapBrowser />);
    await user.click(screen.getByText('Ideas'));
    await user.click(screen.getByRole('button', { name: 'New folder' }));
    await user.type(screen.getByPlaceholderText('Name'), 'Nested');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(mockCreateFolder).toHaveBeenCalledWith('Nested', 'f1'));
  });
});
