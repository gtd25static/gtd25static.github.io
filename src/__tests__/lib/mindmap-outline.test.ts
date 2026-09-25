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

  it('escapes every label line that would parse back as structure', () => {
    const tree = buildTree([
      node('root', { label: 'Root' }),
      node('a', { parentId: 'root', label: 'x\n1. numbered\n* starred\n+ plussed\n## heading\n---\n   ' }),
    ]);
    expect(mapToOutline(tree)).toBe(
      '# Root\n' +
      '\n' +
      '- x\n' +
      '  \\1. numbered\n' +
      '  \\* starred\n' +
      '  \\+ plussed\n' +
      '  \\## heading\n' +
      '  \\---\n' +
      '  \\   \n',
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

  it('nests headings and hangs bullets off the section they follow', () => {
    const parsed = ok(parseOutline(
      '# Title\n\n## Section A\n\n- a1\n- a2\n\n### Sub of A\n\n- s1\n\n## Section B\n\n- b1\n',
    ));
    expect(parsed.rootLabel).toBe('Title');
    expect(parsed.children.map((c) => c.label)).toEqual(['Section A', 'Section B']);
    const [sectionA, sectionB] = parsed.children;
    expect(sectionA.children.map((c) => c.label)).toEqual(['a1', 'a2', 'Sub of A']);
    expect(sectionA.children[2].children.map((c) => c.label)).toEqual(['s1']);
    expect(sectionB.children.map((c) => c.label)).toEqual(['b1']);
  });

  it('accepts -, *, + and numbered markers, dropping the marker', () => {
    const parsed = ok(parseOutline('# T\n* star\n+ plus\n1. first\n2) second\n- dash\n'));
    expect(parsed.children.map((c) => c.label)).toEqual(['star', 'plus', 'first', 'second', 'dash']);
  });

  it('treats --- / *** / ___ as separators, not content', () => {
    const parsed = ok(parseOutline('# T\n\n- a\n\n---\n\n- b\n***\n- c\n___\n'));
    expect(parsed.children.map((c) => c.label)).toEqual(['a', 'b', 'c']);
  });

  it('nests by indent column, so 4-space siblings stay siblings', () => {
    // The old floor(columns/2)+clamp rule made `c` a child of `b` here.
    const parsed = ok(parseOutline('# T\n- a\n    - b\n    - c\n        - c1\n- d\n'));
    expect(parsed.children.map((n) => n.label)).toEqual(['a', 'd']);
    expect(parsed.children[0].children.map((n) => n.label)).toEqual(['b', 'c']);
    expect(parsed.children[0].children[1].children.map((n) => n.label)).toEqual(['c1']);
  });

  it('nests tab-indented bullets at several levels', () => {
    const parsed = ok(parseOutline('# T\n- a\n\t- b\n\t\t- b1\n\t- c\n'));
    expect(parsed.children[0].children.map((n) => n.label)).toEqual(['b', 'c']);
    expect(parsed.children[0].children[0].children.map((n) => n.label)).toEqual(['b1']);
  });

  it('reads a bullet-less indented outline as one node per line (spaces)', () => {
    const parsed = ok(parseOutline('Root idea\n  Child one\n    Grandchild\n  Child two\n'));
    expect(parsed.format).toBe('indent');
    expect(parsed.rootLabel).toBe('Root idea');
    expect(parsed.children.map((n) => n.label)).toEqual(['Child one', 'Child two']);
    expect(parsed.children[0].children.map((n) => n.label)).toEqual(['Grandchild']);
  });

  it('reads a bullet-less indented outline with tabs', () => {
    const parsed = ok(parseOutline('Root\n\tChild\n\t\tGrandchild\n\tOther\n'));
    expect(parsed.format).toBe('indent');
    expect(parsed.children.map((n) => n.label)).toEqual(['Child', 'Other']);
    expect(parsed.children[0].children.map((n) => n.label)).toEqual(['Grandchild']);
  });

  it('keeps un-indented prose as a single root label, not one node per line', () => {
    const parsed = ok(parseOutline('First line\nSecond line\n'));
    expect(parsed.format).toBe('markdown');
    expect(parsed.rootLabel).toBe('First line\nSecond line');
    expect(parsed.children).toHaveLength(0);
  });

  it('several headings at the shallowest level: synthetic root', () => {
    const parsed = ok(parseOutline('## A\n- a1\n## B\n- b1\n'));
    expect(parsed.rootLabel).toBe('Imported map');
    expect(parsed.children.map((c) => c.label)).toEqual(['A', 'B']);
    expect(parsed.warnings.some((w) => w.includes('synthetic root'))).toBe(true);
  });

  it('a bullet before the only heading: synthetic root, heading becomes a branch', () => {
    const parsed = ok(parseOutline('- intro\n## A\n- a1\n'));
    expect(parsed.rootLabel).toBe('Imported map');
    expect(parsed.children.map((c) => c.label)).toEqual(['intro', 'A']);
  });

  it('reports the detected format and the node count it will create', () => {
    const parsed = ok(parseOutline('# T\n- a\n  - a1\n- b\n'));
    expect(parsed.format).toBe('markdown');
    expect(parsed.nodeCount).toBe(4); // root + a + a1 + b
  });

  it('parses a typical chatbot article summary', () => {
    const parsed = ok(parseOutline([
      '# How deep sleep works',
      '',
      '## Main ideas',
      '',
      '- Deep sleep clears the brain',
      '    - The glymphatic system switches on',
      '    - Cerebrospinal fluid flow rises',
      '- Body temperature drops',
      '',
      '## Key numbers',
      '',
      '1. ~20% of total sleep time',
      '2. Concentrated in the first third of the night',
      '',
      '---',
      '',
      '## Takeaway',
      '',
      'Short sleep degrades brain clearance.',
      '',
    ].join('\n')));
    expect(parsed.name).toBe('How deep sleep works');
    expect(parsed.children.map((c) => c.label.split('\n')[0])).toEqual(['Main ideas', 'Key numbers', 'Takeaway']);
    const [ideas, numbers, takeaway] = parsed.children;
    expect(ideas.children.map((c) => c.label)).toEqual(['Deep sleep clears the brain', 'Body temperature drops']);
    expect(ideas.children[0].children).toHaveLength(2);
    expect(numbers.children.map((c) => c.label)).toEqual([
      '~20% of total sleep time',
      'Concentrated in the first third of the night',
    ]);
    // Prose under a heading with no bullets extends that heading's own label.
    expect(takeaway.label).toBe('Takeaway\nShort sleep degrades brain clearance.');
    expect(parsed.warnings).toHaveLength(0);
  });

  it('does not backtrack quadratically on a huge run of leading whitespace', () => {
    const started = Date.now();
    const parsed = parseOutline(`# T\n${' '.repeat(200_000)}x\n- a\n`);
    expect('error' in parsed).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('round-trips exactly: export → parse → export is identity', () => {
    const gnarly = [
      node('root', { label: 'Root **md**\nsecond root line\n- root literal' }),
      node('a', { parentId: 'root', label: 'plain' }),
      node('b', { parentId: 'root', order: 1, label: 'multi\n  indented line\n- bullet-looking\n1. numbered-looking\n* starred\n### heading-looking\n---\n   \n\\already backslashed\n\nafter empty' }),
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

// GUI review: what chatbots actually paste.
describe('parseOutline — chatbot output', () => {
  const labels = (nodes: OutlineNode[]) => nodes.map((n) => n.label);

  it('ignores code fences, and leaves a sign-off after the list out (with a warning)', () => {
    const parsed = ok(parseOutline([
      '```markdown',
      '# Sleep',
      '- Deep sleep',
      '  - Clears the brain',
      '- REM',
      '```',
      '',
      'Let me know if you want more detail on any point.',
      'Happy to help!',
    ].join('\n')));
    expect(parsed.rootLabel).toBe('Sleep');
    expect(labels(parsed.children)).toEqual(['Deep sleep', 'REM']);
    expect(labels(parsed.children[0].children)).toEqual(['Clears the brain']);
    expect(parsed.warnings.some((w) => /left out/.test(w))).toBe(true);
  });

  it('gives prose between two sections to its section, not to the last point', () => {
    const parsed = ok(parseOutline([
      '# T', '## Ideas', '- a', '- b', '', 'These show X.', '## Numbers', '- 1',
    ].join('\n')));
    const [ideas, numbers] = parsed.children;
    expect(labels(ideas.children)).toEqual(['a', 'b']);
    expect(ideas.label).toBe('Ideas\nThese show X.');
    expect(labels(numbers.children)).toEqual(['1']);
    expect(parsed.warnings).toHaveLength(0);
  });

  it('still continues a point with an indented paragraph after a blank line', () => {
    const parsed = ok(parseOutline('# T\n- a\n\n  more about a\n- b\n'));
    expect(labels(parsed.children)).toEqual(['a\nmore about a', 'b']);
  });

  it('reads bold-only lines as sections and a./b. as sub-points', () => {
    const parsed = ok(parseOutline([
      '**Introduction**',
      '1. Background',
      '   a. History',
      '   b. Motivation',
      '2. Scope',
      '',
      '**Methods**',
      '- Survey',
    ].join('\n')));
    expect(labels(parsed.children)).toEqual(['**Introduction**', '**Methods**']);
    const [intro, methods] = parsed.children;
    expect(labels(intro.children)).toEqual(['Background', 'Scope']);
    expect(labels(intro.children[0].children)).toEqual(['History', 'Motivation']);
    expect(labels(methods.children)).toEqual(['Survey']);
  });

  it('nests bold sections under the # heading they follow', () => {
    const parsed = ok(parseOutline('# Report\n**Part one**\n- x\n**Part two**\n- y\n'));
    expect(parsed.rootLabel).toBe('Report');
    expect(labels(parsed.children)).toEqual(['**Part one**', '**Part two**']);
    expect(labels(parsed.children[1].children)).toEqual(['y']);
  });

  it('takes • ◦ ▪ ‣ as bullet markers', () => {
    const parsed = ok(parseOutline('# Trip\n• Flights\n  ◦ Book\n  ▪ Pay\n‣ Hotel\n'));
    expect(labels(parsed.children)).toEqual(['Flights', 'Hotel']);
    expect(labels(parsed.children[0].children)).toEqual(['Book', 'Pay']);
  });

  // Pasted text is untrusted: the new bold-line and marker patterns must stay
  // linear on hostile lines, like the indent handling above.
  it('does not backtrack on long near-miss bold lines', () => {
    const started = Date.now();
    for (const line of ['**' + 'a'.repeat(300_000), '**' + 'a*'.repeat(150_000), '__' + '_a'.repeat(150_000) + ' x']) {
      expect('error' in parseOutline(`# T\n${line}\n- a\n`)).toBe(false);
    }
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('keeps such lines inside a label through export and import', () => {
    const rows = [
      node('root', { label: 'Root\n**bold only**' }),
      node('a', { parentId: 'root', label: 'x\n**bold only**\n```\n~~~ tilde\na. lettered\n• dot' }),
    ];
    const original = mapToOutline(buildTree(rows));
    const parsed = ok(parseOutline(original));
    expect(parsed.rootLabel).toBe('Root\n**bold only**');
    expect(labels(parsed.children)).toEqual(['x\n**bold only**\n```\n~~~ tilde\na. lettered\n• dot']);
    expect(mapToOutline(buildTree(rowsFromParsed(parsed)))).toBe(original);
  });
});

// The cap counts every node the import creates, root included: the preview
// accepted 2001 and the import then refused it.
describe('parseOutline — node cap', () => {
  const withBullets = (n: number) => ['# Root', ...Array.from({ length: n }, (_, i) => `- n${i}`)].join('\n');

  it('accepts exactly MAX_MINDMAP_IMPORT_NODES nodes, root included', () => {
    expect(ok(parseOutline(withBullets(1999))).nodeCount).toBe(2000);
  });

  it('refuses one more', () => {
    expect(parseOutline(withBullets(2000))).toHaveProperty('error');
  });
});
