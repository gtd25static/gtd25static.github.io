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
// Rules — chosen so export→import is LOSSLESS (a test invariant):
//   - `# ` heading = root label (and the map name, single-line-ified)
//   - one bullet per node, 2 spaces of indent per depth level
//   - multi-line labels: continuation lines at the bullet's CONTENT column,
//     without `- `, re-joined with \n
//   - a label-internal line that would parse as something else gets a `\`
//     prefix on export: lines starting with `- `, lines starting with `\`,
//     and empty label lines (exported as a lone `\`). Import strips one
//     leading `\` from continuation lines.
// Import tolerances: tabs = one level, depth jumps clamp to parent+1, missing
// heading → synthetic name, node/label caps enforced with warnings.

export interface OutlineNode {
  label: string;
  children: OutlineNode[];
}

export interface ParsedOutline {
  name: string;
  rootLabel: string;
  children: OutlineNode[];
  warnings: string[];
}

// --- Export ---

function escapeLabelLine(line: string): string {
  if (line.length === 0) return '\\';
  if (/^\s*-\s/.test(line) || line.startsWith('\\')) return `\\${line}`;
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

export function parseOutline(text: string): ParsedOutline | { error: string } {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { error: 'The outline is empty.' };
  }
  // Bound the work before parsing anything.
  if (text.length > 2_000_000) {
    return { error: 'The outline is too large.' };
  }

  const warnings: string[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');

  let rootLabelLines: string[] | null = null;
  let sawHeading = false;
  const topLevel: OutlineNode[] = [];
  // Stack of (depth, node) for bullet nesting; continuation lines attach to the
  // last bullet, stripped of exactly its content column (indent + "- ") so a
  // label's own leading spaces survive the round-trip.
  const stack: Array<{ depth: number; contentCol: number; node: OutlineNode }> = [];
  let nodeCount = 0;

  const stripColumns = (line: string, col: number): string => {
    let stripped = 0;
    let i = 0;
    while (i < line.length && stripped < col) {
      if (line[i] === ' ') { stripped += 1; i++; }
      else if (line[i] === '\t') { stripped += 2; i++; }
      else break;
    }
    return line.slice(i);
  };

  const clampLabel = (label: string): string => {
    if (label.length > MAX_MINDMAP_LABEL_LENGTH) {
      warnings.push('Some labels were truncated to 1000 characters.');
      return label.slice(0, MAX_MINDMAP_LABEL_LENGTH);
    }
    return label;
  };

  for (const rawLine of lines) {
    const bulletMatch = /^([ \t]*)-\s(.*)$/.exec(rawLine);
    if (bulletMatch) {
      const indent = bulletMatch[1];
      const columns = indent.replace(/\t/g, '  ').length;
      let depth = Math.floor(columns / 2);
      const parentDepth = stack.length > 0 ? stack[stack.length - 1].depth : -1;
      if (depth > parentDepth + 1) depth = parentDepth + 1; // clamp jumps
      while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop();

      nodeCount++;
      if (nodeCount > MAX_MINDMAP_IMPORT_NODES) {
        return { error: `The outline has more than ${MAX_MINDMAP_IMPORT_NODES} nodes.` };
      }
      const node: OutlineNode = { label: bulletMatch[2], children: [] };
      if (stack.length === 0) topLevel.push(node);
      else stack[stack.length - 1].node.children.push(node);
      stack.push({ depth, contentCol: columns + 2, node });
      continue;
    }

    const headingMatch = /^#{1,6}\s+(.*)$/.exec(rawLine);
    if (headingMatch && !sawHeading && stack.length === 0 && topLevel.length === 0) {
      sawHeading = true;
      rootLabelLines = [headingMatch[1]];
      continue;
    }

    // Non-bullet line: blank = separator, anything else continues the nearest label.
    if (rawLine.trim().length === 0) continue;
    if (stack.length > 0) {
      const top = stack[stack.length - 1];
      top.node.label += `\n${unescapeLabelLine(stripColumns(rawLine, top.contentCol))}`;
    } else if (rootLabelLines) {
      rootLabelLines.push(unescapeLabelLine(rawLine));
    } else {
      // Loose text before any structure: treat it as the root label.
      rootLabelLines = [unescapeLabelLine(rawLine)];
    }
  }

  const clampTree = (nodes: OutlineNode[]) => {
    for (const n of nodes) {
      n.label = clampLabel(n.label);
      clampTree(n.children);
    }
  };
  clampTree(topLevel);

  let rootLabel = rootLabelLines ? clampLabel(rootLabelLines.join('\n')) : '';
  let children = topLevel;
  if (!rootLabel) {
    if (topLevel.length === 1) {
      // Single top-level bullet and no heading: promote it to root.
      rootLabel = topLevel[0].label;
      children = topLevel[0].children;
    } else {
      rootLabel = 'Imported map';
      if (topLevel.length > 1) warnings.push('No heading found — a synthetic root was added.');
    }
  }
  if (nodeCount === 0 && !rootLabelLines) {
    return { error: 'No outline content found (expected "# Heading" and/or "- item" lines).' };
  }

  return {
    name: outlineNameFromLabel(rootLabel),
    rootLabel,
    children,
    warnings,
  };
}
