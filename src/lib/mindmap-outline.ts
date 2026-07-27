import type { MindmapTree, MindmapTreeNode } from './mindmap-tree';
import { mdToPlainText } from './mini-markdown';
import { MAX_MINDMAP_LABEL_LENGTH, MAX_MINDMAP_IMPORT_NODES } from './constants';

// Markdown-outline interchange format for mindmaps (markmap-compatible):
//
//   # Root label
//
//   - Child A with **bold**
//   - Child B first line
//     second line of the same label
//     \- a literal "- " line inside the label
//     - an actual grandchild
//
// Export rules — chosen so export→import is LOSSLESS (a test invariant):
//   - `# ` heading = root label (and the map name, single-line-ified)
//   - one bullet per node, 2 spaces of indent per depth level
//   - multi-line labels: continuation lines at the bullet's CONTENT column,
//     without `- `, re-joined with \n
//   - a label-internal line that would parse as structure gets a `\` prefix on
//     export — any bullet/heading/rule line (see `looksLikeStructure`), a line
//     already starting with `\`, and blank-ish lines. Import strips exactly one
//     leading `\` from continuation lines.
//
// Import is deliberately more tolerant than export, because the common source
// is a chatbot ("summarize this article as an indented markdown outline"):
//   - headings nest: `##` under the nearest `#`, and bullets hang off the
//     heading they follow. One shallowest heading, first ⇒ it is the root;
//     otherwise a synthetic root holds them all.
//   - bullet markers `-`, `*`, `+`, `1.`, `1)` (the marker is dropped)
//   - nesting comes from the indent COLUMN (tab = 2), compared against the open
//     bullets — so 2-, 3- or 4-space indents and tabs all nest correctly and
//     siblings stay siblings
//   - `---` / `***` / `___` rules are separators, not content
//   - a document with no bullets and no headings but real indentation is read
//     as a plain indented outline (one node per line)
//   - node/label caps enforced with warnings

export interface OutlineNode {
  label: string;
  children: OutlineNode[];
}

/** How the text was read: markdown structure vs. plain indentation. */
export type OutlineFormat = 'markdown' | 'indent';

export interface ParsedOutline {
  name: string;
  rootLabel: string;
  children: OutlineNode[];
  format: OutlineFormat;
  /** Nodes the import will create, root included. */
  nodeCount: number;
  warnings: string[];
}

// --- Line shapes (shared by export escaping and import parsing) ---

// Applied to a line with its indent already removed, so no pattern starts with
// a greedy whitespace class — a `/^[ \t]*-/` style regex backtracks
// quadratically on a pasted megabyte of spaces.
const BULLET_RE = /^(?:[-*+]|\d{1,9}[.)])[ \t]+/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;
const RULE_RE = /^(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;
/** Indent columns a heading may carry and still be a heading (CommonMark). */
const MAX_HEADING_INDENT = 3;

/** Leading indent width in columns (tab = 2 columns) plus the rest of the line. */
function splitIndent(line: string): { columns: number; rest: string } {
  let i = 0;
  let columns = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ') columns += 1;
    else if (ch === '\t') columns += 2;
    else break;
    i++;
  }
  return { columns, rest: line.slice(i) };
}

/**
 * Would this line be read back as structure instead of label text? Ignores the
 * indent width on purpose: it must be a SUPERSET of what the parser treats as
 * structure, since over-escaping round-trips fine but under-escaping doesn't.
 */
function looksLikeStructure(line: string): boolean {
  const { rest } = splitIndent(line);
  return BULLET_RE.test(rest) || HEADING_RE.test(rest) || RULE_RE.test(rest);
}

// --- Export ---

function escapeLabelLine(line: string): string {
  // Blank-ish lines too: import treats an all-whitespace line as a separator.
  if (line.trim().length === 0) return `\\${line}`;
  if (line.startsWith('\\') || looksLikeStructure(line)) return `\\${line}`;
  return line;
}

function emitNode(node: MindmapTreeNode, depth: number, out: string[]) {
  const indent = '  '.repeat(depth);
  const lines = node.node.label.split('\n');
  out.push(`${indent}- ${lines[0]}`);
  for (const line of lines.slice(1)) {
    out.push(`${indent}  ${escapeLabelLine(line)}`);
  }
  for (const child of node.children) emitNode(child, depth + 1, out);
}

export function mapToOutline(tree: MindmapTree): string {
  if (!tree.root) return '';
  const rootLines = tree.root.node.label.split('\n');
  const out: string[] = [`# ${rootLines[0]}`];
  for (const line of rootLines.slice(1)) out.push(escapeLabelLine(line));
  out.push('');
  for (const child of tree.root.children) emitNode(child, 0, out);
  return `${out.join('\n')}\n`;
}

/** Single-line plain-text name from a (possibly markdown, multi-line) label. */
export function outlineNameFromLabel(label: string): string {
  const flat = mdToPlainText(label).split('\n')[0].trim();
  return flat.length > 0 ? flat.slice(0, 120) : 'Imported map';
}

// --- Import ---

function unescapeLabelLine(line: string): string {
  return line.startsWith('\\') ? line.slice(1) : line;
}

type LineKind = 'blank' | 'rule' | 'heading' | 'bullet' | 'text';

interface ClassifiedLine {
  kind: LineKind;
  raw: string;
  columns: number;
  /** Heading level (1-6); 0 for everything else. */
  level: number;
  /** Node label for headings and bullets. */
  content: string;
  /** Column where a bullet's label starts, for continuation lines. */
  contentCol: number;
}

function classifyLines(lines: string[]): ClassifiedLine[] {
  return lines.map((raw) => {
    const { columns, rest } = splitIndent(raw);
    const base = { raw, columns, level: 0, content: '', contentCol: 0 };
    if (rest.length === 0) return { ...base, kind: 'blank' as const };
    if (RULE_RE.test(rest)) return { ...base, kind: 'rule' as const };

    const heading = columns <= MAX_HEADING_INDENT ? HEADING_RE.exec(rest) : null;
    if (heading) {
      return { ...base, kind: 'heading' as const, level: heading[1].length, content: heading[2] };
    }
    const bullet = BULLET_RE.exec(rest);
    if (bullet) {
      return {
        ...base,
        kind: 'bullet' as const,
        content: rest.slice(bullet[0].length),
        contentCol: columns + bullet[0].length,
      };
    }
    return { ...base, kind: 'text' as const };
  });
}

/** Strip up to `col` columns of leading whitespace (tab = 2), keeping the rest verbatim. */
function stripColumns(line: string, col: number): string {
  let stripped = 0;
  let i = 0;
  while (i < line.length && stripped < col) {
    if (line[i] === ' ') { stripped += 1; i++; }
    else if (line[i] === '\t') { stripped += 2; i++; }
    else break;
  }
  return line.slice(i);
}

function countNodes(nodes: OutlineNode[]): number {
  let total = 0;
  for (const n of nodes) total += 1 + countNodes(n.children);
  return total;
}

/** Returns a `spend()` that goes false once the node cap is exceeded. */
function makeNodeBudget(): () => boolean {
  let used = 0;
  return () => ++used <= MAX_MINDMAP_IMPORT_NODES;
}

/**
 * Which line (if any) is the root heading: the single shallowest heading, and
 * only when nothing structural precedes it. Anything else (no headings, several
 * at the top level, a bullet first) gets a synthetic root instead.
 */
function findRootHeading(lines: ClassifiedLine[]): number {
  let minLevel = Number.MAX_SAFE_INTEGER;
  let countAtMin = 0;
  let indexAtMin = -1;
  let firstStructural = -1;
  lines.forEach((line, i) => {
    if (line.kind !== 'heading' && line.kind !== 'bullet') return;
    if (firstStructural < 0) firstStructural = i;
    if (line.kind !== 'heading') return;
    if (line.level < minLevel) { minLevel = line.level; countAtMin = 1; indexAtMin = i; }
    else if (line.level === minLevel) countAtMin++;
  });
  return countAtMin === 1 && indexAtMin === firstStructural ? indexAtMin : -1;
}

/** Markdown pass: headings nest, bullets hang off the current heading. */
function parseMarkdown(lines: ClassifiedLine[], spend: () => boolean): OutlineNode | null {
  const root: OutlineNode = { label: '', children: [] };
  const rootHeadingIndex = findRootHeading(lines);
  const headings: Array<{ level: number; node: OutlineNode }> = [];
  const bullets: Array<{ columns: number; contentCol: number; node: OutlineNode }> = [];
  let rootLabelStarted = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.kind === 'blank') continue;
    if (line.kind === 'rule') { bullets.length = 0; continue; }

    if (line.kind === 'heading') {
      bullets.length = 0;
      if (i === rootHeadingIndex) {
        root.label = line.content;
        rootLabelStarted = true;
        headings.length = 0;
        headings.push({ level: line.level, node: root });
        continue;
      }
      while (headings.length > 0 && headings[headings.length - 1].level >= line.level) headings.pop();
      if (!spend()) return null;
      const node: OutlineNode = { label: line.content, children: [] };
      (headings.length > 0 ? headings[headings.length - 1].node : root).children.push(node);
      headings.push({ level: line.level, node });
      continue;
    }

    if (line.kind === 'bullet') {
      while (bullets.length > 0 && bullets[bullets.length - 1].columns >= line.columns) bullets.pop();
      if (!spend()) return null;
      const node: OutlineNode = { label: line.content, children: [] };
      const parent = bullets.length > 0 ? bullets[bullets.length - 1].node
        : headings.length > 0 ? headings[headings.length - 1].node
        : root;
      parent.children.push(node);
      bullets.push({ columns: line.columns, contentCol: line.contentCol, node });
      continue;
    }

    // Plain text continues the label it sits under: the open bullet (stripped of
    // exactly its content column, so a label's own leading spaces survive), else
    // the current heading, else the root.
    if (bullets.length > 0) {
      const top = bullets[bullets.length - 1];
      top.node.label += `\n${unescapeLabelLine(stripColumns(line.raw, top.contentCol))}`;
    } else {
      const target = headings.length > 0 ? headings[headings.length - 1].node : root;
      const piece = unescapeLabelLine(line.raw);
      const started = target !== root || rootLabelStarted;
      target.label = started ? `${target.label}\n${piece}` : piece;
      if (target === root) rootLabelStarted = true;
    }
  }
  return root;
}

/** Indent-only pass: no bullets, no headings — one node per non-blank line. */
function parseIndented(lines: ClassifiedLine[], spend: () => boolean): OutlineNode | null {
  const root: OutlineNode = { label: '', children: [] };
  const stack: Array<{ columns: number; node: OutlineNode }> = [];
  for (const line of lines) {
    if (line.kind === 'blank') continue;
    if (line.kind === 'rule') { stack.length = 0; continue; }
    while (stack.length > 0 && stack[stack.length - 1].columns >= line.columns) stack.pop();
    if (!spend()) return null;
    const node: OutlineNode = { label: splitIndent(line.raw).rest.trimEnd(), children: [] };
    (stack.length > 0 ? stack[stack.length - 1].node : root).children.push(node);
    stack.push({ columns: line.columns, node });
  }
  return root;
}

export function parseOutline(text: string): ParsedOutline | { error: string } {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { error: 'The outline is empty.' };
  }
  // Bound the work before parsing anything.
  if (text.length > 2_000_000) {
    return { error: 'The outline is too large.' };
  }

  const warnings: string[] = [];
  const lines = classifyLines(text.replace(/\r\n?/g, '\n').split('\n'));

  const hasStructure = lines.some((l) => l.kind === 'bullet' || l.kind === 'heading');
  const textLines = lines.filter((l) => l.kind === 'text');
  // Only claim "indented outline" when indentation is actually carrying meaning;
  // a lone paragraph stays a single root label, as before.
  const format: OutlineFormat =
    !hasStructure && textLines.length > 1 && textLines.some((l) => l.columns > 0) ? 'indent' : 'markdown';

  const spend = makeNodeBudget();
  const root = format === 'indent' ? parseIndented(lines, spend) : parseMarkdown(lines, spend);
  if (!root) return { error: `The outline has more than ${MAX_MINDMAP_IMPORT_NODES} nodes.` };
  if (root.label.length === 0 && root.children.length === 0) {
    return { error: 'No outline content found (expected "# Heading" and/or "- item" lines).' };
  }

  const clampLabel = (label: string): string => {
    if (label.length > MAX_MINDMAP_LABEL_LENGTH) {
      warnings.push('Some labels were truncated to 1000 characters.');
      return label.slice(0, MAX_MINDMAP_LABEL_LENGTH);
    }
    return label;
  };
  const clampTree = (nodes: OutlineNode[]) => {
    for (const n of nodes) {
      n.label = clampLabel(n.label);
      clampTree(n.children);
    }
  };
  clampTree(root.children);

  let rootLabel = clampLabel(root.label);
  let children = root.children;
  if (rootLabel.length === 0) {
    if (children.length === 1) {
      // Single top-level node and no heading: promote it to root.
      rootLabel = children[0].label;
      children = children[0].children;
    } else {
      rootLabel = 'Imported map';
      warnings.push('No heading found — a synthetic root was added.');
    }
  }

  return {
    name: outlineNameFromLabel(rootLabel),
    rootLabel,
    children,
    format,
    nodeCount: 1 + countNodes(children),
    warnings: [...new Set(warnings)],
  };
}
