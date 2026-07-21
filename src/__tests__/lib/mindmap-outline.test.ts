import { mapToOutline, parseOutline, outlineNameFromLabel, type ParsedOutline, type OutlineNode } from '../../lib/mindmap-outline';
import { buildTree } from '../../lib/mindmap-tree';
import type { MindmapNode } from '../../db/models';

function node(id: string, overrides: Partial<MindmapNode> = {}): MindmapNode {
  return { id, mapId: 'm1', label: id, order: 0, createdAt: 1, updatedAt: 1, ...overrides };
}

function ok(result: ReturnType<typeof parseOutline>): ParsedOutline {
  if ('error' in result) throw new Error(`unexpected parse error: ${result.error}`);
  return result;
}

// Rebuild rows from a parsed outline so we can export again (round-trip check).
function rowsFromParsed(parsed: ParsedOutline): MindmapNode[] {
  const rows: MindmapNode[] = [node('root', { label: parsed.rootLabel })];
  let seq = 0;
  const add = (children: OutlineNode[], parentId: string) => {
    children.forEach((child, i) => {
      const id = `n${seq++}`;
      rows.push(node(id, { label: child.label, parentId, order: i }));
      add(child.children, id);
    });
  };
  add(parsed.children, 'root');
  return rows;
}

describe('mapToOutline', () => {
  it('emits the exact expected format', () => {
    const tree = buildTree([
      node('root', { label: 'My plan' }),
      node('a', { parentId: 'root', label: 'First **step**' }),
      node('a1', { parentId: 'a', label: 'Detail' }),
      node('b', { parentId: 'root', order: 1, label: 'Second' }),
    ]);
    expect(mapToOutline(tree)).toBe(
      '# My plan\n' +
      '\n' +
      '- First **step**\n' +
      '  - Detail\n' +
      '- Second\n',
    );
  });

  it('writes multi-line labels as content-column continuation lines, escaping "- " and empties', () => {
    const tree = buildTree([
      node('root', { label: 'Root' }),
      node('a', { parentId: 'root', label: 'line1\nline2\n- literal bullet\n\nafter blank' }),
    ]);
    expect(mapToOutline(tree)).toBe(
      '# Root\n' +
      '\n' +
      '- line1\n' +
      '  line2\n' +
      '  \\- literal bullet\n' +
      '  \\\n' +
      '  after blank\n',
    );
  });
});

describe('parseOutline', () => {
  it('parses heading + nested bullets with 2-space indent', () => {
    const parsed = ok(parseOutline('# Title\n\n- a\n  - a1\n    - a1x\n- b\n'));
    expect(parsed.name).toBe('Title');
    expect(parsed.rootLabel).toBe('Title');
    expect(parsed.children.map((c) => c.label)).toEqual(['a', 'b']);
    expect(parsed.children[0].children[0].label).toBe('a1');
    expect(parsed.children[0].children[0].children[0].label).toBe('a1x');
  });

  it('tolerates tabs as one level and clamps depth jumps', () => {
    const parsed = ok(parseOutline('# T\n- a\n\t- tabbed child\n- b\n      - overdeep child of b\n'));
    expect(parsed.children[0].children[0].label).toBe('tabbed child');
    // 6-space (depth-3) jump right after a depth-0 bullet clamps to depth 1
    expect(parsed.children[1].children[0].label).toBe('overdeep child of b');
  });

  it('no heading + single top bullet: promotes it to root', () => {
    const parsed = ok(parseOutline('- only root\n  - kid\n'));
    expect(parsed.rootLabel).toBe('only root');
    expect(parsed.children.map((c) => c.label)).toEqual(['kid']);
  });

  it('no heading + several top bullets: synthetic root with warning', () => {
    const parsed = ok(parseOutline('- a\n- b\n'));
    expect(parsed.rootLabel).toBe('Imported map');
    expect(parsed.children).toHaveLength(2);
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });

  it('errors on empty input and over-cap outlines', () => {
    expect(parseOutline('')).toHaveProperty('error');
    expect(parseOutline('   \n \n')).toHaveProperty('error');
    const big = Array.from({ length: 2001 }, (_, i) => `- n${i}`).join('\n');
    expect(parseOutline(big)).toHaveProperty('error');
  });

  it('truncates over-long labels with a warning', () => {
    const parsed = ok(parseOutline(`# T\n- ${'x'.repeat(1500)}\n`));
    expect(parsed.children[0].label).toHaveLength(1000);
    expect(parsed.warnings.some((w) => w.includes('truncated'))).toBe(true);
  });

  it('round-trips exactly: export → parse → export is identity', () => {
    const gnarly = [
      node('root', { label: 'Root **md**\nsecond root line\n- root literal' }),
      node('a', { parentId: 'root', label: 'plain' }),
      node('b', { parentId: 'root', order: 1, label: 'multi\n  indented line\n- bullet-looking\n\\already backslashed\n\nafter empty' }),
      node('b1', { parentId: 'b', label: '`code` and [link](https://x.y)' }),
      node('c', { parentId: 'root', order: 2, label: 'deep' }),
      node('c1', { parentId: 'c', label: 'deeper\nwith line' }),
      node('c2', { parentId: 'c1', label: 'deepest' }),
    ];
    const original = mapToOutline(buildTree(gnarly));
    const parsed = ok(parseOutline(original));
    const again = mapToOutline(buildTree(rowsFromParsed(parsed)));
    expect(again).toBe(original);
  });
});

describe('outlineNameFromLabel', () => {
  it('flattens markdown and takes the first line', () => {
    expect(outlineNameFromLabel('**Bold** plan\nsecond line')).toBe('Bold plan');
    expect(outlineNameFromLabel('   ')).toBe('Imported map');
    expect(outlineNameFromLabel('x'.repeat(300))).toHaveLength(120);
  });
});
