import { describe, expect, it } from 'vitest';
import type { MindmapNode } from '../../db/models';
import {
  EXPORT_FONT_SIZE,
  buildMindmapSvg,
  escapeXml,
  labelLines,
  wrapLabel,
  type MeasureRun,
} from '../../lib/mindmap-export-svg';

// Deterministic stand-in for canvas text measurement: every glyph is 8px wide.
const CHAR_W = 8;
const measure: MeasureRun = (run) => run.text.length * CHAR_W;

function node(id: string, overrides: Partial<MindmapNode> = {}): MindmapNode {
  return { id, mapId: 'm', label: id, order: 0, createdAt: 1, updatedAt: 1, ...overrides };
}

const MAP = [
  node('root', { label: 'Root topic' }),
  node('a', { parentId: 'root', label: 'Child A', palette: 'mint' }),
  node('b', { parentId: 'root', label: 'Child B', order: 1, shape: 'diamond' }),
  node('a1', { parentId: 'a', label: 'Grandchild', shape: 'circle' }),
];

/** Concatenated text content — words are separate <tspan>s, so raw substring
 *  matching would miss "Child A". */
function textOf(svg: string): string {
  return svg.replace(/<[^>]*>/g, '');
}

function build(nodes: MindmapNode[] = MAP, collapsed?: Set<string>) {
  return buildMindmapSvg({
    nodes,
    collapsed,
    measure,
    resolveColor: (v) => (v.startsWith('var(') ? '#123456' : v),
    background: '#ffffff',
    edgeColor: '#cccccc',
  });
}

describe('buildMindmapSvg', () => {
  it('returns null for a map with no live root', () => {
    expect(build([])).toBeNull();
  });

  it('draws one shape per node, of the right kind, plus the edges', () => {
    const out = build()!;
    expect(out.svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(out.svg.match(/<rect /g)!.length).toBe(3); // background + root + 'a'
    expect(out.svg.match(/<polygon /g)!.length).toBe(1); // the diamond
    expect(out.svg.match(/<ellipse /g)!.length).toBe(1); // the circle
    expect(out.svg.match(/<path d="M /g)!.length).toBe(3); // 3 edges for 4 nodes
  });

  it('emits real SVG text, never a foreignObject (vector editors ignore those)', () => {
    const out = build()!;
    expect(out.svg).not.toContain('foreignObject');
    expect(out.svg).toContain('<text ');
    expect(textOf(out.svg)).toContain('Grandchild');
  });

  it('resolves CSS variables to literal colours — the app is not there to define them', () => {
    const out = build()!;
    expect(out.svg).not.toContain('var(--');
    expect(out.svg).toContain('#123456');
  });

  it('sizes the document around the whole map, with padding', () => {
    const out = build()!;
    expect(out.width).toBeGreaterThan(200);
    expect(out.height).toBeGreaterThan(50);
    expect(out.svg).toContain(`viewBox="0 0 ${out.width} ${out.height}"`);
  });

  it('leaves collapsed subtrees out and marks the fold with a "+"', () => {
    const out = build(MAP, new Set(['a']))!;
    expect(textOf(out.svg)).not.toContain('Grandchild');
    expect(textOf(out.svg)).toContain('Child A');
    expect(out.svg.match(/<circle /g)!.length).toBe(1); // the collapsed badge
  });

  it('keeps bold/italic/code/link styling from the label markdown', () => {
    const out = build([node('root', { label: '**bold** *it* `code` [link](https://x.test)' })])!;
    expect(out.svg).toContain('font-weight="600"');
    expect(out.svg).toContain('font-style="italic"');
    expect(out.svg).toContain('text-decoration="underline"');
    expect(out.svg).toContain('monospace');
    expect(out.svg).not.toContain('https://x.test'); // the URL is not drawn
  });

  it('escapes label content instead of letting it become markup', () => {
    const out = build([node('root', { label: '</text><script>alert(1)</script> A & B "q"' })])!;
    expect(out.svg).not.toContain('<script>');
    expect(out.svg).toContain('&lt;/text&gt;');
    expect(out.svg).toContain('&amp;');
    // The label survives intact once the markup is stripped — escaped, not eaten
    expect(textOf(out.svg).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"'))
      .toContain('</text><script>alert(1)</script> A & B "q"');
  });
});

describe('label wrapping', () => {
  it('keeps the label\'s own line structure', () => {
    expect(labelLines('one\ntwo')).toHaveLength(2);
    expect(labelLines('- a\n- b')[0][0].text).toBe('• ');
  });

  it('wraps on words, dropping the space the break replaced but never the word', () => {
    const lines = wrapLabel('aaa bbb ccc ddd', 10 * CHAR_W, measure);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line[0].text.startsWith(' ')).toBe(false);
      expect(line.reduce((w, r) => w + measure(r), 0)).toBeLessThanOrEqual(10 * CHAR_W);
    }
    // Every word still there, in order — a wrap must never eat content
    expect(lines.map((l) => l.map((r) => r.text).join('')).join(' ')).toBe('aaa bbb ccc ddd');
  });

  it('hard-breaks a single word too wide to fit rather than blowing the box up', () => {
    const lines = wrapLabel('x'.repeat(50), 10 * CHAR_W, measure);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.reduce((w, r) => w + measure(r), 0)).toBeLessThanOrEqual(10 * CHAR_W);
    }
  });

  it('always yields at least one line, so an empty label still measures', () => {
    expect(wrapLabel('', 100, measure)).toEqual([[{ text: '' }]]);
  });

  it('carries the run style through the wrap', () => {
    const lines = wrapLabel('**aaa bbb ccc**', 5 * CHAR_W, measure);
    expect(lines.flat().every((run) => run.bold)).toBe(true);
  });
});

describe('escapeXml', () => {
  it('escapes the five XML metacharacters', () => {
    expect(escapeXml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&apos;');
  });
});

describe('constants', () => {
  it('measures at the size it draws at', () => {
    expect(EXPORT_FONT_SIZE).toBe(14);
  });
});
