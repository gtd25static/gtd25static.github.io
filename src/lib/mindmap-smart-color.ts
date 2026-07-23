import type { MindmapNode } from '../db/models';
import { PALETTES } from './mindmap-style';

// "Smart colouring": when enabled, every branch off the root (a direct child of
// the root node) gets its own colour, and everything created below a branch
// inherits that branch's colour. The first branches reuse the built-in presets
// (which adapt to light/dark); once those run out, new colours are synthesised
// by rotating the hue in golden-angle steps so branches stay visibly distinct
// and, in practice, never repeat. Synthesised colours are fixed hex — like the
// user's custom palettes, they don't adapt to dark mode (the built-in ones do).

/** The colour a new node should carry: a preset id, or a literal '#rrggbb' trio. */
export interface BranchStyle {
  palette?: string;
  colorBg?: string;
  colorFg?: string;
  colorBorder?: string;
}

// Golden angle: successive hues are spread as far as N points can be on the
// wheel, so no two synthesised colours land close together.
const GOLDEN_ANGLE = 137.508;
// Start the synthesised sequence away from the built-in preset hues.
const BASE_HUE = 22;
// Same saturation/lightness envelope as the built-in presets (pale bg, dark
// text, mid border) so synthesised branches sit visually alongside them.
const GEN = {
  bg: { s: 66, l: 90 },
  fg: { s: 52, l: 28 },
  border: { s: 68, l: 62 },
};

function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100;
  const lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const hp = ((((h % 360) + 360) % 360)) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = lN - c / 2;
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** The branch style for slot N: built-in presets first, then synthesised hues. */
export function branchStyleForSlot(slot: number): BranchStyle {
  if (slot < PALETTES.length) return { palette: PALETTES[slot].id };
  const h = BASE_HUE + (slot - PALETTES.length + 1) * GOLDEN_ANGLE;
  return {
    colorBg: hslToHex(h, GEN.bg.s, GEN.bg.l),
    colorFg: hslToHex(h, GEN.fg.s, GEN.fg.l),
    colorBorder: hslToHex(h, GEN.border.s, GEN.border.l),
  };
}

type Styled = Pick<MindmapNode, 'palette' | 'colorBg' | 'colorFg' | 'colorBorder'>;

/** A key identifying the branch colour a node carries (preset id or bg hex), or null. */
function colourKey(style: Styled): string | null {
  if (style.palette) return `p:${style.palette}`;
  if (style.colorBg) return `c:${style.colorBg.toLowerCase()}`;
  return null;
}

/**
 * The colour for a NEW branch (a direct child of the root): the first slot whose
 * colour no existing branch already uses. Reuses a freed colour when a branch is
 * deleted, and never repeats among the current branches.
 */
export function nextBranchStyle(existingBranches: Styled[]): BranchStyle {
  const used = new Set<string>();
  for (const b of existingBranches) {
    const key = colourKey(b);
    if (key) used.add(key);
  }
  // A free slot always exists within [0, used.size] (slots have distinct keys —
  // pigeonhole); the extra margin is a belt-and-braces guard against collision.
  const cap = used.size + PALETTES.length + 1;
  for (let slot = 0; slot < cap; slot++) {
    const style = branchStyleForSlot(slot);
    const key = colourKey(style);
    if (key && !used.has(key)) return style;
  }
  return branchStyleForSlot(used.size);
}

/** Copy a parent's branch colour so a deeper node joins the same branch. */
export function inheritBranchStyle(parent: Styled): BranchStyle {
  if (parent.palette) return { palette: parent.palette };
  const style: BranchStyle = {};
  if (parent.colorBg) style.colorBg = parent.colorBg;
  if (parent.colorFg) style.colorFg = parent.colorFg;
  if (parent.colorBorder) style.colorBorder = parent.colorBorder;
  return style;
}

/**
 * The smart-colouring style for a node about to be created under `parent`.
 * Direct children of the root open a new branch; everything else inherits the
 * parent's branch colour. Returns undefined when there's nothing to apply (no
 * parent, or an uncoloured parent) so the node keeps the default look.
 */
export function smartStyleForNewChild(
  parent: MindmapNode | undefined,
  allNodes: MindmapNode[],
): BranchStyle | undefined {
  if (!parent) return undefined;
  const style = parent.parentId
    ? inheritBranchStyle(parent)
    : nextBranchStyle(allNodes.filter((n) => n.parentId === parent.id && !n.deletedAt));
  return colourKey(style) ? style : undefined;
}
