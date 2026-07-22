// @vitest-environment jsdom
import '../setup-component';
import type { MindmapNode } from '../../db/models';

const mockExportData =
  vi.fn<() => Promise<{ safeName: string; nodes: MindmapNode[]; background?: string } | null>>();
const mockToast = vi.fn();

vi.mock('../../hooks/use-mindmaps', () => ({
  getMindmapExportData: () => mockExportData(),
}));
vi.mock('../../components/ui/Toast', () => ({ toast: (...a: unknown[]) => mockToast(...a) }));

import {
  copyMindmapPng,
  downloadMindmapPng,
  downloadMindmapSvg,
  createTextMeasurer,
} from '../../components/mindmaps/image-actions';
import { useMindmapUi } from '../../stores/mindmap-ui';

function node(id: string, overrides: Partial<MindmapNode> = {}): MindmapNode {
  return { id, mapId: 'map-1', label: id, order: 0, createdAt: 1, updatedAt: 1, ...overrides };
}

let downloads: Array<{ name: string; blob: Blob }>;

beforeEach(() => {
  vi.clearAllMocks();
  downloads = [];
  useMindmapUi.setState({ collapsed: {} });
  mockExportData.mockResolvedValue({
    safeName: 'My map',
    nodes: [node('root', { label: 'Root' }), node('a', { parentId: 'root', label: 'Child' })],
  });

  const blobs = new Map<string, Blob>();
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
    const url = `blob:mock/${blobs.size}`;
    blobs.set(url, blob as Blob);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, blob: blobs.get(this.href)! });
  });
});

afterEach(() => vi.restoreAllMocks());

describe('mindmap image export', () => {
  it('downloads a standalone .svg named after the map', async () => {
    await downloadMindmapSvg('map-1');
    expect(downloads).toHaveLength(1);
    expect(downloads[0].name).toBe('My map.svg');
    expect(downloads[0].blob.type).toContain('image/svg+xml');

    const svg = await downloads[0].blob.text();
    expect(svg.startsWith('<svg xmlns=')).toBe(true);
    expect(svg).not.toContain('var(--'); // colours resolved, no app stylesheet needed
    expect(svg).not.toContain('foreignObject');
  });

  it('says so instead of downloading an empty file when the map has no nodes', async () => {
    mockExportData.mockResolvedValue({ safeName: 'Empty', nodes: [] });
    await downloadMindmapSvg('map-1');
    expect(downloads).toHaveLength(0);
    expect(mockToast).toHaveBeenCalledWith('Nothing to export.', 'error');
  });

  it('leaves collapsed subtrees out of the export, like the canvas', async () => {
    useMindmapUi.setState({ collapsed: { 'map-1': ['root'] } });
    await downloadMindmapSvg('map-1');
    const svg = await downloads[0].blob.text();
    expect(svg).toContain('Root');
    expect(svg).not.toContain('Child');
  });

  it('reports a PNG failure rather than downloading a broken file', async () => {
    // jsdom neither loads images nor rasterises; stand in for a decoder that
    // rejects the document, the failure a real browser could hit.
    class FailingImage {
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onerror?.()); }
    }
    vi.stubGlobal('Image', FailingImage);
    await downloadMindmapPng('map-1');
    vi.unstubAllGlobals();
    expect(downloads).toHaveLength(0);
    expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('Could not render the PNG'), 'error');
  });

  it("paints the map's own canvas colour into the export", async () => {
    mockExportData.mockResolvedValue({
      safeName: 'My map',
      nodes: [node('root', { label: 'Root' })],
      background: '#ff00ff',
    });
    await downloadMindmapSvg('map-1');
    expect(await downloads[0].blob.text()).toContain('fill="#ff00ff"');
  });

  it('says so instead of failing silently when the browser cannot copy images', async () => {
    vi.stubGlobal('ClipboardItem', undefined);
    await copyMindmapPng('map-1');
    vi.unstubAllGlobals();
    expect(mockToast).toHaveBeenCalledWith(expect.stringContaining('cannot copy images'), 'error');
  });

  it('measures text without throwing where there is no 2D canvas', () => {
    const measure = createTextMeasurer();
    expect(measure({ text: 'hello' })).toBeGreaterThan(0);
    expect(measure({ text: '' })).toBe(0);
  });
});
