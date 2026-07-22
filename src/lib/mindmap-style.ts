import type { MindmapNode, MindmapNodeShape } from '../db/models';

// Node formatting: shape + colours. Colours are resolved to CSS custom
// properties (defined, light and dark, in styles/index.css) rather than to
// literal hex, so a preset looks right in both themes without storing two sets
// of values. Only the advanced picker writes literal colours, and those are
// validated to '#rrggbb' both when stored and when read back — a colour string
// ends up in a style attribute, so nothing else may ever reach it.

export const NODE_SHAPES: readonly MindmapNodeShape[] = ['rect', 'circle', 'diamond'] as const;

export function isNodeShape(v: unknown): v is MindmapNodeShape {
  return typeof v === 'string' && (NODE_SHAPES as readonly string[]).includes(v);
}

export interface Palette {
  id: string;
  name: string;
}

/** The five presets, in toolbar order. `null` id = "no palette", the default look. */
export const PALETTES: readonly Palette[] = [
  { id: 'sky', name: 'Sky' },
  { id: 'mint', name: 'Mint' },
  { id: 'amber', name: 'Amber' },
  { id: 'rose', name: 'Rose' },
  { id: 'slate', name: 'Slate' },
] as const;

const PALETTE_IDS = new Set(PALETTES.map((p) => p.id));

export function isPaletteId(v: unknown): v is string {
  return typeof v === 'string' && PALETTE_IDS.has(v);
}

const HEX = /^#[0-9a-f]{6}$/i;

export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX.test(v);
}

/** CSS variables for a palette (or the built-in default / root looks). */
function paletteVars(id: 'default' | 'root' | string): { bg: string; fg: string; border: string } {
  return {
    bg: `var(--mm-${id}-bg)`,
    fg: `var(--mm-${id}-fg)`,
    border: `var(--mm-${id}-border)`,
  };
}

export interface NodeStylePatch {
  shape?: MindmapNodeShape;
  /** null clears the preset back to the default look. */
  palette?: string | null;
  colorBg?: string | null;
  colorFg?: string | null;
  colorBorder?: string | null;
}

export interface ResolvedNodeStyle {
  shape: MindmapNodeShape;
  bg: string;
  fg: string;
  border: string;
}

type StyledNode = Pick<MindmapNode, 'shape' | 'palette' | 'colorBg' | 'colorFg' | 'colorBorder'>;

/**
 * The colours and shape to actually draw. Precedence, lowest first:
 * default look (accent-tinted for the root) → preset → per-part override →
 * live preview (the toolbar hovering a preset).
 */
export function resolveNodeStyle(
  node: StyledNode,
  { isRoot = false, preview }: { isRoot?: boolean; preview?: NodeStylePatch | null } = {},
): ResolvedNodeStyle {
  const merged = {
    shape: preview?.shape ?? node.shape,
    palette: preview && 'palette' in preview ? preview.palette : node.palette,
    colorBg: preview && 'colorBg' in preview ? preview.colorBg : node.colorBg,
    colorFg: preview && 'colorFg' in preview ? preview.colorFg : node.colorFg,
    colorBorder: preview && 'colorBorder' in preview ? preview.colorBorder : node.colorBorder,
  };

  const base = isPaletteId(merged.palette)
    ? paletteVars(merged.palette)
    : paletteVars(isRoot ? 'root' : 'default');

  return {
    shape: isNodeShape(merged.shape) ? merged.shape : 'rect',
    bg: isHexColor(merged.colorBg) ? merged.colorBg : base.bg,
    fg: isHexColor(merged.colorFg) ? merged.colorFg : base.fg,
    border: isHexColor(merged.colorBorder) ? merged.colorBorder : base.border,
  };
}

/** True when the node has any formatting of its own (used to enable "Reset"). */
export function hasCustomStyle(node: StyledNode): boolean {
  return !!(node.shape || node.palette || node.colorBg || node.colorFg || node.colorBorder);
}

/** How wide the label may get before wrapping, per shape. */
export const SHAPE_TEXT_MAX_WIDTH: Record<MindmapNodeShape, number> = {
  rect: 240,
  circle: 132,
  diamond: 120, // a diamond has to be ~1.7x its text to contain it — keep the text short
};

const MIN_SIDE = 48;
/** Decision diamonds are always this much wider than tall — a flow-chart look. */
const DIAMOND_ASPECT = 1.4;

/**
 * Outer box for a measured label. A circle takes the label's diagonal.
 *
 * A diamond has to grow both ways: an axis-aligned w×h label fits inside a
 * rhombus W×H only while w/W + h/H ≤ 1. Rather than splitting that budget by a
 * fixed ratio (which made short labels come out taller than wide), the aspect
 * is pinned to DIAMOND_ASPECT and the equation solved for it — W = r·H with
 * H = w/r + h satisfies it exactly, so this is the *smallest* diamond of that
 * shape that still contains the label.
 */
export function shapeSize(shape: MindmapNodeShape, textW: number, textH: number): { w: number; h: number } {
  switch (shape) {
    case 'circle': {
      const d = Math.max(Math.ceil(Math.hypot(textW, textH)) + 16, MIN_SIDE);
      return { w: d, h: d };
    }
    case 'diamond': {
      const w0 = textW + 12; // breathing room before solving, or the label
      const h0 = textH + 8;  // touches the sloped edges
      const h = Math.max(Math.ceil(w0 / DIAMOND_ASPECT + h0), MIN_SIDE);
      return { w: Math.ceil(h * DIAMOND_ASPECT), h };
    }
    default:
      return { w: textW + 28, h: textH + 16 };
  }
}

/** SVG points for a diamond filling the given box. */
export function diamondPoints(x: number, y: number, w: number, h: number): string {
  const cx = x + w / 2;
  const cy = y + h / 2;
  return `${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}`;
}
