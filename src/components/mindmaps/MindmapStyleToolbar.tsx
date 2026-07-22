import { useEffect, useRef, useState } from 'react';
import type { MindmapNode, MindmapNodeShape } from '../../db/models';
import { updateMindmapNodeStyle } from '../../hooks/use-mindmaps';
import { useMindmapUi } from '../../stores/mindmap-ui';
import {
  PALETTES,
  isHexColor,
  resolveNodeStyle,
  type NodeStylePatch,
} from '../../lib/mindmap-style';

// Format bar for the selected node: shape, five colour presets (previewed on
// the node itself while hovered) and an advanced popover for per-part colours.
// Rendered as a row of the editor, only while something is selected.
export function MindmapStyleToolbar({ node, isRoot }: { node: MindmapNode; isRoot: boolean }) {
  const setPreview = useMindmapUi((s) => s.setStylePreview);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const apply = (patch: NodeStylePatch) => {
    setPreview(null);
    void updateMindmapNodeStyle(node.id, patch);
  };

  // A preview must never outlive the toolbar (node deleted, selection changed).
  useEffect(() => () => setPreview(null), [setPreview]);

  const current = resolveNodeStyle(node, { isRoot });
  const usesPalette = (id: string | null) =>
    id === null ? !node.palette : node.palette === id;

  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b border-zinc-200 px-3 py-1.5 dark:border-zinc-800">
      <span className="mr-1 hidden shrink-0 text-xs text-zinc-400 sm:inline">Shape</span>
      {(['rect', 'circle', 'diamond'] as MindmapNodeShape[]).map((shape) => (
        <ToolButton
          key={shape}
          label={SHAPE_LABEL[shape]}
          active={(node.shape ?? 'rect') === shape}
          onClick={() => apply({ shape })}
          onPreview={(on) => setPreview(on ? { shape } : null)}
        >
          <ShapeIcon shape={shape} />
        </ToolButton>
      ))}

      <Divider />

      <span className="mr-1 hidden shrink-0 text-xs text-zinc-400 sm:inline">Colour</span>
      <Swatch
        label="No colour"
        bg="var(--mm-default-bg)"
        fg="var(--mm-default-fg)"
        border="var(--mm-default-border)"
        active={usesPalette(null)}
        onClick={() => apply({ palette: null, colorBg: null, colorFg: null, colorBorder: null })}
        onPreview={(on) => setPreview(on ? { palette: null, colorBg: null, colorFg: null, colorBorder: null } : null)}
      />
      {PALETTES.map((p) => (
        <Swatch
          key={p.id}
          label={p.name}
          bg={`var(--mm-${p.id}-bg)`}
          fg={`var(--mm-${p.id}-fg)`}
          border={`var(--mm-${p.id}-border)`}
          active={usesPalette(p.id)}
          onClick={() => apply({ palette: p.id, colorBg: null, colorFg: null, colorBorder: null })}
          onPreview={(on) => setPreview(on ? { palette: p.id, colorBg: null, colorFg: null, colorBorder: null } : null)}
        />
      ))}

      <Divider />

      <div className="relative shrink-0">
        <ToolButton
          label="Advanced colours"
          active={advancedOpen}
          onClick={() => setAdvancedOpen((v) => !v)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
          </svg>
        </ToolButton>
        {advancedOpen && (
          <AdvancedColours
            node={node}
            current={current}
            onClose={() => setAdvancedOpen(false)}
            onApply={apply}
          />
        )}
      </div>
    </div>
  );
}

const SHAPE_LABEL: Record<MindmapNodeShape, string> = {
  rect: 'Rounded rectangle',
  circle: 'Circle',
  diamond: 'Decision diamond',
};

function Divider() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-zinc-200 dark:bg-zinc-700" />;
}

function ShapeIcon({ shape }: { shape: MindmapNodeShape }) {
  if (shape === 'circle') return <svg width="16" height="16" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>;
  if (shape === 'diamond') return <svg width="16" height="16" viewBox="0 0 20 20"><path d="M10 2 L18 10 L10 18 L2 10 Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>;
  return <svg width="16" height="16" viewBox="0 0 20 20"><rect x="2.5" y="4.5" width="15" height="11" rx="3" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>;
}

function ToolButton({ label, active, onClick, onPreview, children }: {
  label: string;
  active: boolean;
  onClick: () => void;
  onPreview?: (on: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={onClick}
      onPointerEnter={(e) => { if (e.pointerType === 'mouse') onPreview?.(true); }}
      onPointerLeave={() => onPreview?.(false)}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg md:h-8 md:w-8 ${
        active
          ? 'bg-accent-100 text-accent-700 dark:bg-accent-900 dark:text-accent-200'
          : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'
      }`}
    >
      {children}
    </button>
  );
}

function Swatch({ label, bg, fg, border, active, onClick, onPreview }: {
  label: string;
  bg: string;
  fg: string;
  border: string;
  active: boolean;
  onClick: () => void;
  onPreview: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={`${label} — hover to preview`}
      aria-pressed={active}
      onClick={onClick}
      onPointerEnter={(e) => { if (e.pointerType === 'mouse') onPreview(true); }}
      onPointerLeave={() => onPreview(false)}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg md:h-8 md:w-8 ${
        active ? 'ring-2 ring-accent-500 ring-offset-1 ring-offset-white dark:ring-offset-zinc-900' : ''
      }`}
    >
      <span
        className="flex h-6 w-6 items-center justify-center rounded-md border-2 text-[11px] font-semibold"
        style={{ background: bg, color: fg, borderColor: border }}
      >
        A
      </span>
    </button>
  );
}

/** Resolve a `var(--x)` reference to the hex the theme currently gives it. */
function readColor(value: string, fallback: string): string {
  const name = value.startsWith('var(') ? value.slice(4, -1).trim() : null;
  if (!name) return isHexColor(value) ? value : fallback;
  if (typeof window === 'undefined') return fallback;
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return isHexColor(resolved) ? resolved : fallback;
}

function AdvancedColours({ node, current, onClose, onApply }: {
  node: MindmapNode;
  current: { bg: string; fg: string; border: string };
  onClose: () => void;
  onApply: (patch: NodeStylePatch) => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && !popoverRef.current?.contains(e.target)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const rows: Array<{ field: 'colorBg' | 'colorFg' | 'colorBorder'; label: string; value: string }> = [
    { field: 'colorBg', label: 'Background', value: readColor(current.bg, '#ffffff') },
    { field: 'colorFg', label: 'Text', value: readColor(current.fg, '#000000') },
    { field: 'colorBorder', label: 'Border', value: readColor(current.border, '#d4d4d8') },
  ];

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Advanced colours"
      className="absolute right-0 top-full z-30 mt-1 w-56 rounded-xl border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-800"
    >
      {rows.map((row) => (
        <label key={row.field} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm text-zinc-700 hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-700/50">
          <span>{row.label}</span>
          <span className="flex items-center gap-2">
            {node[row.field] && (
              <button
                type="button"
                onClick={() => onApply({ [row.field]: null })}
                className="text-xs text-zinc-400 underline hover:text-zinc-600 dark:hover:text-zinc-200"
              >
                clear
              </button>
            )}
            <input
              type="color"
              value={row.value}
              onChange={(e) => onApply({ [row.field]: e.target.value })}
              className="h-7 w-10 cursor-pointer rounded border border-zinc-300 bg-transparent p-0.5 dark:border-zinc-600"
            />
          </span>
        </label>
      ))}
      <p className="px-2 pt-1 text-[11px] leading-snug text-zinc-400">
        Custom colours are fixed — unlike the presets, they don't adapt to dark mode.
      </p>
    </div>
  );
}
