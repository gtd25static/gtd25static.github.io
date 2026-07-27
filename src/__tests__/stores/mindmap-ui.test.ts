import { useMindmapUi } from '../../stores/mindmap-ui';

const KEY = 'gtd25-mindmap-ui';
const stored = (): Record<string, unknown> => JSON.parse(localStorage.getItem(KEY) ?? '{}');

beforeEach(() => {
  localStorage.removeItem(KEY);
  useMindmapUi.setState({ collapsed: {}, customPalettes: [], smartColoringDefault: false });
});

describe('mindmap-ui persistence', () => {
  it('remembers the smart-colouring default', () => {
    useMindmapUi.getState().setSmartColoringDefault(true);
    expect(useMindmapUi.getState().smartColoringDefault).toBe(true);
    expect(stored().smartColoringDefault).toBe(true);

    useMindmapUi.getState().setSmartColoringDefault(false);
    expect(stored().smartColoringDefault).toBe(false);
  });

  it('keeps it through writes from every other setter', () => {
    // Each setter re-serialises the whole blob, so one that forgot a field would
    // silently wipe it on the next unrelated collapse or palette change.
    useMindmapUi.getState().setSmartColoringDefault(true);
    useMindmapUi.getState().toggleCollapsed('map-1', 'n1');
    useMindmapUi.getState().addCustomPalette({ name: 'C', bg: '#112233', fg: '#ffffff', border: '#000000' });
    useMindmapUi.getState().collapseAll('map-1', ['n1', 'n2']);
    useMindmapUi.getState().expand('map-1', 'n1');
    useMindmapUi.getState().expandAll('map-1');
    useMindmapUi.getState().pruneMaps(new Set());

    expect(useMindmapUi.getState().smartColoringDefault).toBe(true);
    expect(stored().smartColoringDefault).toBe(true);
    expect(stored().customPalettes).toHaveLength(1);
  });

  it('reads back what was stored, and defaults to off for pre-setting blobs', async () => {
    localStorage.setItem(KEY, JSON.stringify({ collapsed: { m: ['a'] }, customPalettes: [] }));
    vi.resetModules();
    const legacy = (await import('../../stores/mindmap-ui')).useMindmapUi;
    expect(legacy.getState().smartColoringDefault).toBe(false);
    expect(legacy.getState().collapsed).toEqual({ m: ['a'] });

    localStorage.setItem(KEY, JSON.stringify({ collapsed: {}, customPalettes: [], smartColoringDefault: true }));
    vi.resetModules();
    const restored = (await import('../../stores/mindmap-ui')).useMindmapUi;
    expect(restored.getState().smartColoringDefault).toBe(true);

    // Anything that isn't a real boolean true is off.
    localStorage.setItem(KEY, JSON.stringify({ collapsed: {}, customPalettes: [], smartColoringDefault: 'yes' }));
    vi.resetModules();
    const garbage = (await import('../../stores/mindmap-ui')).useMindmapUi;
    expect(garbage.getState().smartColoringDefault).toBe(false);
  });
});
