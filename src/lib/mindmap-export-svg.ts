import type { MindmapNode } from '../db/models';
import { buildTree } from './mindmap-tree';
import { edgePath, layoutMindmap, type NodeSize } from './mindmap-layout';
import { SHAPE_TEXT_MAX_WIDTH, diamondPoints, resolveNodeStyle, shapeSize } from './mindmap-style';
import { parseMiniMarkdown, type MdInline } from './mini-markdown';

// Standalone SVG of a whole map, built from the layout rather than by
// serialising the live canvas. The canvas draws labels in a <foreignObject>
// (HTML), which browsers render but vector editors — and SVG-loaded-as-<img>,
// which is how the PNG is rasterised — do not handle reliably. Here every
// label is real SVG <text>, every colour is a literal (the canvas uses CSS
// variables, which mean nothing outside the app), and nothing references the
// document: the output opens the same in Chrome, Inkscape and Illustrator.

export const EXPORT_FONT_STACK = "'Google Sans', 'Roboto', system-ui, -apple-system, sans-serif";
export const EXPORT_FONT_SIZE = 14;
const LINE_HEIGHT = 19; // text-sm / leading-snug
const PADDING = 32;

export interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: boolean;
}

/** Width of one run in px, at EXPORT_FONT_SIZE. */
export type MeasureRun = (run: TextRun) => number;

export interface SvgExportOptions {
  nodes: MindmapNode[];
  /** Collapsed subtrees are left out, so the export matches what's on screen. */
  collapsed?: Set<string>;
  measure: MeasureRun;
  /** Turn a `var(--x)` reference from resolveNodeStyle into a literal colour. */
  resolveColor: (value: string) => string;
  background: string;
  edgeColor: string;
}

export interface SvgExport {
  svg: string;
  width: number;
  height: number;
}

export function buildMindmapSvg(opts: SvgExportOptions): SvgExport | null {
  const tree = buildTree(opts.nodes);
  if (!tree.root) return null;
  const collapsed = opts.collapsed ?? new Set<string>();

  // 1. Lay the labels out first — the box sizes follow from the wrapped text.
  const wrapped = new Map<string, TextRun[][]>();
  const sizes = new Map<string, NodeSize>();
  for (const treeNode of tree.byId.values()) {
    const node = treeNode.node;
    const shape = resolveNodeStyle(node).shape;
    const lines = wrapLabel(node.label, SHAPE_TEXT_MAX_WIDTH[shape], opts.measure);
    wrapped.set(node.id, lines);
    const textW = Math.max(0, ...lines.map((line) => lineWidth(line, opts.measure)));
    sizes.set(node.id, shapeSize(shape, Math.ceil(textW), lines.length * LINE_HEIGHT));
  }

  const layout = layoutMindmap(tree, sizes, collapsed);
  const { minX, minY, maxX, maxY } = layout.bounds;
  const width = Math.ceil(maxX - minX) + PADDING * 2;
  const height = Math.ceil(maxY - minY) + PADDING * 2;
  const dx = PADDING - minX;
  const dy = PADDING - minY;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" font-family="${escapeXml(EXPORT_FONT_STACK)}">`,
  );
  parts.push(`<rect width="${width}" height="${height}" fill="${escapeXml(opts.background)}"/>`);
  parts.push(`<g transform="translate(${round(dx)},${round(dy)})">`);

  parts.push(`<g fill="none" stroke="${escapeXml(opts.edgeColor)}" stroke-width="1.5">`);
  for (const edge of layout.edges) parts.push(`<path d="${edgePath(edge)}"/>`);
  parts.push('</g>');

  for (const [id, rect] of layout.rects) {
    const treeNode = tree.byId.get(id);
    if (!treeNode) continue;
    const node = treeNode.node;
    const style = resolveNodeStyle(node, { isRoot: tree.root.node.id === id });
    const fill = opts.resolveColor(style.bg);
    const stroke = opts.resolveColor(style.border);
    const color = opts.resolveColor(style.fg);

    parts.push(shapeMarkup(style.shape, rect, fill, stroke));
    parts.push(textMarkup(wrapped.get(id) ?? [], rect, color));
    // A collapsed parent gets the same "+" the canvas shows, so a reader can
    // tell a leaf from a folded-away subtree.
    if (collapsed.has(id) && treeNode.children.length > 0) {
      parts.push(collapsedBadge(rect.x + rect.w + 12, rect.y + rect.h / 2, stroke, color));
    }
  }

  parts.push('</g></svg>');
  return { svg: parts.join(''), width, height };
}

// --- label → lines of styled runs ---

function flattenInline(inlines: MdInline[], inherited: Omit<TextRun, 'text'>): TextRun[] {
  const out: TextRun[] = [];
  for (const inline of inlines) {
    switch (inline.type) {
      case 'text': out.push({ ...inherited, text: inline.text }); break;
      case 'code': out.push({ ...inherited, text: inline.text, code: true }); break;
      case 'bold': out.push(...flattenInline(inline.children, { ...inherited, bold: true })); break;
      case 'italic': out.push(...flattenInline(inline.children, { ...inherited, italic: true })); break;
      case 'link': out.push(...flattenInline(inline.children, { ...inherited, link: true })); break;
    }
  }
  return out;
}

/** The label's own line structure (paragraph lines, list items), unwrapped. */
export function labelLines(label: string): TextRun[][] {
  const lines: TextRun[][] = [];
  for (const block of parseMiniMarkdown(label)) {
    if (block.type === 'paragraph') {
      for (const line of block.lines) lines.push(flattenInline(line, {}));
    } else {
      for (const item of block.items) lines.push([{ text: '• ' }, ...flattenInline(item, {})]);
    }
  }
  return lines.filter((line) => line.some((run) => run.text.length > 0));
}

function lineWidth(line: TextRun[], measure: MeasureRun): number {
  return line.reduce((sum, run) => sum + measure(run), 0);
}

/** Greedy word wrap to `maxWidth`, keeping each word's styling. */
export function wrapLabel(label: string, maxWidth: number, measure: MeasureRun): TextRun[][] {
  const out: TextRun[][] = [];
  for (const source of labelLines(label)) {
    let line: TextRun[] = [];
    let width = 0;
    for (const run of source) {
      for (const original of splitWords(run, maxWidth, measure)) {
        let piece = original;
        let pieceWidth = measure(piece);
        if (line.length > 0 && width + pieceWidth > maxWidth && piece.text.trim() !== '') {
          out.push(line);
          line = [];
          width = 0;
          if (piece.text.startsWith(' ')) {
            // The space this word carried is what the line break replaced.
            piece = { ...piece, text: piece.text.slice(1) };
            pieceWidth = measure(piece);
          }
        }
        line.push(piece);
        width += pieceWidth;
      }
    }
    if (line.length > 0) out.push(line);
  }
  return out.length > 0 ? out : [[{ text: '' }]];
}

/** One run → per-word runs (space kept on the leading edge), hard-breaking words wider than the box. */
function splitWords(run: TextRun, maxWidth: number, measure: MeasureRun): TextRun[] {
  const pieces: TextRun[] = [];
  for (const word of run.text.split(/(?=\s)/)) {
    if (word === '') continue;
    let piece: TextRun = { ...run, text: word };
    while (measure(piece) > maxWidth && piece.text.length > 1) {
      // Character-wise fallback: a single unbroken 900-char "word" would
      // otherwise blow the box up to its full width.
      let cut = piece.text.length - 1;
      while (cut > 1 && measure({ ...piece, text: piece.text.slice(0, cut) }) > maxWidth) cut--;
      pieces.push({ ...piece, text: piece.text.slice(0, cut) });
      piece = { ...piece, text: piece.text.slice(cut) };
    }
    pieces.push(piece);
  }
  return pieces;
}

// --- markup ---

function shapeMarkup(shape: string, rect: { x: number; y: number; w: number; h: number }, fill: string, stroke: string): string {
  const common = `fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" stroke-width="2"`;
  if (shape === 'circle') {
    return `<ellipse cx="${round(rect.x + rect.w / 2)}" cy="${round(rect.y + rect.h / 2)}" rx="${round(rect.w / 2)}" ry="${round(rect.h / 2)}" ${common}/>`;
  }
  if (shape === 'diamond') {
    return `<polygon points="${diamondPoints(round(rect.x), round(rect.y), round(rect.w), round(rect.h))}" ${common} stroke-linejoin="round"/>`;
  }
  return `<rect x="${round(rect.x)}" y="${round(rect.y)}" width="${round(rect.w)}" height="${round(rect.h)}" rx="12" ${common}/>`;
}

function textMarkup(lines: TextRun[][], rect: { x: number; y: number; w: number; h: number }, color: string): string {
  if (lines.length === 0) return '';
  const cx = round(rect.x + rect.w / 2);
  // Explicit baselines rather than dominant-baseline, which vector editors
  // interpret inconsistently.
  const first = round(rect.y + rect.h / 2 - ((lines.length - 1) * LINE_HEIGHT) / 2 + EXPORT_FONT_SIZE * 0.35);
  const body = lines
    .map((line, i) => {
      const runs = line.map((run) => {
        const attrs = [
          run.bold ? 'font-weight="600"' : '',
          run.italic ? 'font-style="italic"' : '',
          run.code ? 'font-family="ui-monospace, SFMono-Regular, Menlo, monospace"' : '',
          run.link ? 'text-decoration="underline"' : '',
        ].filter(Boolean).join(' ');
        return `<tspan${attrs ? ` ${attrs}` : ''}>${escapeXml(run.text)}</tspan>`;
      }).join('');
      return `<tspan x="${cx}"${i === 0 ? '' : ` dy="${LINE_HEIGHT}"`}>${runs}</tspan>`;
    })
    .join('');
  return `<text x="${cx}" y="${first}" text-anchor="middle" font-size="${EXPORT_FONT_SIZE}" fill="${escapeXml(color)}" xml:space="preserve">${body}</text>`;
}

function collapsedBadge(cx: number, cy: number, stroke: string, color: string): string {
  return (
    `<g><circle cx="${round(cx)}" cy="${round(cy)}" r="9" fill="${escapeXml('#ffffff')}" fill-opacity="0.9" stroke="${escapeXml(stroke)}" stroke-width="1.5"/>` +
    `<path d="M ${round(cx - 4)} ${round(cy)} H ${round(cx + 4)} M ${round(cx)} ${round(cy - 4)} V ${round(cy + 4)}" stroke="${escapeXml(color)}" stroke-width="1.5" stroke-linecap="round"/></g>`
  );
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Labels are user content going into an XML document — escape, never trust. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
