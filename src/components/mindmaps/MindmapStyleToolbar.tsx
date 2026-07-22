import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MindmapNode, MindmapNodeShape } from '../../db/models';
import { setMindmapBackground, updateMindmapNodeStyle } from '../../hooks/use-mindmaps';
import { MAX_CUSTOM_PALETTES, useMindmapUi } from '../../stores/mindmap-ui';
import {
  PALETTES,
  isHexColor,
  resolveNodeStyle,
  type CustomPalette,
  type NodeStylePatch,
} from '../../lib/mindmap-style';

// Format bar for the map. Always present: the view controls (expand/collapse
// all) and the canvas background. The node half — shape, five colour presets
// previewed live on the node itself, and an advanced per-part picker — is
// disabled until something is selected.
export function MindmapStyleToolbar({ mapId, node, isRoot, nodes, background }: {
  mapId: string;
  node: MindmapNode | undefined;
  isRoot: boolean;
  nodes: MindmapNode[];
  background: string | undefined;
}) {
  const setPreview = useMindmapUi((s) => s.setStylePreview);
  const collapseAll = useMindmapUi((s) => s.collapseAll);
  const customPalettes = useMindmapUi((s) => s.customPalettes);
  const addCustomPalette = useMindmapUi((s) => s.addCustomPalette);
  const removeCustomPalette = useMindmapUi((s) => s.removeCustomPalette);
  const expandAll = useMindmapUi((s) => s.expandAll);
  const [openPopover, setOpenPopover] = useState<'node' | 'canvas' | null>(null);
  const nodeAnchorRef = useRef<HTMLDivElement>(null);
  const canvasAnchorRef = useRef<HTMLDivElement>(null);

  const apply = (patch: NodeStylePatch) => {
    if (!node) return;
    setPreview(null);
    void updateMindmapNodeStyle(node.id, patch);
  };
  const preview = (patch: NodeStylePatch | null) => {
    if (node) setPreview(patch);
  };

  // A preview must never outlive the toolbar (node deleted, selection changed).
  useEffect(() => () => setPreview(null), [setPreview]);
  useEffect(() => {
    if (!node) setOpenPopover((p) => (p === 'node' ? null : p));
  }, [node]);

  const current = node ? resolveNodeStyle(node, { isRoot }) : null;
  const usesPalette = (id: string | null) =>
    !!node && (id === null ? !node.palette : node.palette === id);
  const disabled = !node;

  return (
    <div className="flex items-center gap-1 overflow-x-auto border-b border-zinc-200 px-3 py-1.5 dark:border-zinc-800">
      <span className="mr-1 hidden shrink-0 text-xs text-zinc-400 sm:inline">Shape</span>
      {(['rect', 'circle', 'diamond'] as MindmapNodeShape[]).map((shape) => (
        <ToolButton
          key={shape}
          label={SHAPE_LABEL[shape]}
          active={!!node && (node.shape ?? 'rect') === shape}
          disabled={disabled}
          onClick={() => apply({ shape })}
          onPreview={(on) => preview(on ? { shape } : null)}
        >
          <ShapeIcon shape={shape} />
        </ToolButton>
      ))}

      <Divider />

      <Swatch
        label="No colour"
        bg="var(--mm-default-bg)"
        fg="var(--mm-default-fg)"
        border="var(--mm-default-border)"
        active={usesPalette(null)}
        disabled={disabled}
        onClick={() => apply({ palette: null, colorBg: null, colorFg: null, colorBorder: null })}
        onPreview={(on) => preview(on ? { palette: null, colorBg: null, colorFg: null, colorBorder: null } : null)}
      />
      {PALETTES.map((p) => (
        <Swatch
          key={p.id}
          label={p.name}
          bg={`var(--mm-${p.id}-bg)`}
          fg={`var(--mm-${p.id}-fg)`}
          border={`var(--mm-${p.id}-border)`}
          active={usesPalette(p.id)}
          disabled={disabled}
          onClick={() => apply({ palette: p.id, colorBg: null, colorFg: null, colorBorder: null })}
          onPreview={(on) => preview(on ? { palette: p.id, colorBg: null, colorFg: null, colorBorder: null } : null)}
        />
      ))}

      {customPalettes.map((p) => (
        <Swatch
          key={p.id}
          label={p.name}
          bg={p.bg}
          fg={p.fg}
          border={p.border}
          active={!!node && node.colorBg === p.bg && node.colorFg === p.fg && node.colorBorder === p.border}
          disabled={disabled}
          onClick={() => apply({ palette: null, colorBg: p.bg, colorFg: p.fg, colorBorder: p.border })}
          onPreview={(on) => preview(on ? { palette: null, colorBg: p.bg, colorFg: p.fg, colorBorder: p.border } : null)}
        />
      ))}

      <div className="shrink-0" ref={nodeAnchorRef}>
        <ToolButton
          label="Advanced colours"
          active={openPopover === 'node'}
          disabled={disabled}
          onClick={() => setOpenPopover((p) => (p === 'node' ? null : 'node'))}
        >
          <GearIcon />
        </ToolButton>
        {openPopover === 'node' && node && current && (
          <Popover anchorRef={nodeAnchorRef} label="Advanced colours" onClose={() => setOpenPopover(null)}>
            {(['colorBg', 'colorFg', 'colorBorder'] as const).map((field) => (
              <ColorField
                key={field}
                label={PART_LABEL[field]}
                value={field === 'colorBg' ? current.bg : field === 'colorFg' ? current.fg : current.border}
                custom={node[field]}
                onChange={(hex) => apply({ [field]: hex })}
              />
            ))}
            <p className="px-2 pt-1 text-[11px] leading-snug text-zinc-400">
              Custom colours are fixed — unlike the presets, they don't adapt to dark mode.
            </p>
            <SavedPalettes
              palettes={customPalettes}
              onSave={(name) => addCustomPalette({
                name,
                bg: readColor(current.bg, '#ffffff'),
                fg: readColor(current.fg, '#000000'),
                border: readColor(current.border, '#d4d4d8'),
              })}
              onRemove={removeCustomPalette}
            />
          </Popover>
        )}
      </div>

      <Divider />

      <ToolButton label="Expand all" active={false} onClick={() => expandAll(mapId)}>
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M10 4v12M4 10h12" />
        </svg>
      </ToolButton>
      <ToolButton
        label="Collapse all"
        active={false}
        onClick={() => collapseAll(mapId, [...new Set(nodes.map((n) => n.parentId).filter((id): id is string => !!id))])}
      >
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M4 10h12" />
        </svg>
      </ToolButton>

      <Divider />

      <div className="shrink-0" ref={canvasAnchorRef}>
        <ToolButton
          label="Canvas background"
          active={openPopover === 'canvas'}
          onClick={() => setOpenPopover((p) => (p === 'canvas' ? null : 'canvas'))}
        >
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
            <rect x="3" y="3" width="14" height="14" rx="3" fill={background ?? 'transparent'} />
            <path d="M3 12l4-4 3 3 3-3 4 4" strokeLinecap="round" />
          </svg>
        </ToolButton>
        {openPopover === 'canvas' && (
          <Popover anchorRef={canvasAnchorRef} label="Canvas background" onClose={() => setOpenPopover(null)}>
            <div className="flex flex-wrap gap-1 px-1 pb-1">
              {CANVAS_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  aria-label={preset.label}
                  title={preset.label}
                  aria-pressed={preset.color === (background ?? null)}
                  onClick={() => void setMindmapBackground(mapId, preset.color)}
                  className={`h-8 w-8 rounded-lg border-2 ${
                    preset.color === (background ?? null)
                      ? 'border-accent-500'
                      : 'border-zinc-300 dark:border-zinc-600'
                  }`}
                  style={preset.color ? { background: preset.color } : undefined}
                >
                  {preset.color ? '' : <span className="text-[10px] text-zinc-500">auto</span>}
                </button>
              ))}
            </div>
            <ColorField
              label="Custom"
              value={background ?? '#ffffff'}
              custom={background}
              onChange={(hex) => void setMindmapBackground(mapId, hex)}
            />
            <p className="px-2 pt-1 text-[11px] leading-snug text-zinc-400">
              Used on screen and in the PNG/SVG export — set white for slides.
            </p>
          </Popover>
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

const PART_LABEL = {
  colorBg: 'Background',
  colorFg: 'Text',
  colorBorder: 'Border',
} as const;

const CANVAS_PRESETS: Array<{ label: string; color: string | null }> = [
  { label: 'Theme default', color: null },
  { label: 'White', color: '#ffffff' },
  { label: 'Paper', color: '#f8f5ef' },
  { label: 'Light grey', color: '#f1f5f9' },
  { label: 'Dark', color: '#18181b' },
];

function Divider() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-zinc-200 dark:bg-zinc-700" />;
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
    </svg>
  );
}

function ShapeIcon({ shape }: { shape: MindmapNodeShape }) {
  if (shape === 'circle') return <svg width="16" height="16" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>;
  if (shape === 'diamond') return <svg width="16" height="16" viewBox="0 0 20 20"><path d="M10 2 L18 10 L10 18 L2 10 Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" /></svg>;
  return <svg width="16" height="16" viewBox="0 0 20 20"><rect x="2.5" y="4.5" width="15" height="11" rx="3" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>;
}

function ToolButton({ label, active, disabled, onClick, onPreview, children }: {
  label: string;
  active: boolean;
  disabled?: boolean;
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
      disabled={disabled}
      onClick={onClick}
      onPointerEnter={(e) => { if (e.pointerType === 'mouse' && !disabled) onPreview?.(true); }}
      onPointerLeave={() => onPreview?.(false)}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg md:h-8 md:w-8 ${
        disabled
          ? 'cursor-not-allowed text-zinc-300 dark:text-zinc-600'
          : active
            ? 'bg-accent-100 text-accent-700 dark:bg-accent-900 dark:text-accent-200'
            : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800'
      }`}
    >
      {children}
    </button>
  );
}

function Swatch({ label, bg, fg, border, active, disabled, onClick, onPreview }: {
  label: string;
  bg: string;
  fg: string;
  border: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  onPreview: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={disabled ? `${label} — select a node first` : `${label} — hover to preview`}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      onPointerEnter={(e) => { if (e.pointerType === 'mouse' && !disabled) onPreview(true); }}
      onPointerLeave={() => onPreview(false)}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg md:h-8 md:w-8 ${
        disabled ? 'cursor-not-allowed opacity-40' : ''
      } ${active ? 'ring-2 ring-accent-500 ring-offset-1 ring-offset-white dark:ring-offset-zinc-900' : ''}`}
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

/** A colour picker plus the hex itself, because typing #1a73e8 beats hunting for it. */
function ColorField({ label, value, custom, onChange }: {
  label: string;
  value: string;
  custom: string | undefined;
  onChange: (hex: string | null) => void;
}) {
  const resolved = readColor(value, '#ffffff');
  const [text, setText] = useState(custom ?? resolved);
  const lastAppliedRef = useRef(custom ?? resolved);

  // Follow the node/map while the field isn't being edited into an invalid state
  useEffect(() => {
    const next = custom ?? resolved;
    if (next !== lastAppliedRef.current) {
      lastAppliedRef.current = next;
      setText(next);
    }
  }, [custom, resolved]);

  const commit = (raw: string) => {
    setText(raw);
    const hex = raw.startsWith('#') ? raw : `#${raw}`;
    if (isHexColor(hex)) {
      lastAppliedRef.current = hex.toLowerCase();
      onChange(hex.toLowerCase());
    }
  };

  const valid = isHexColor(text.startsWith('#') ? text : `#${text}`);

  return (
    <div className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm text-zinc-700 dark:text-zinc-200">
      <span className="shrink-0">{label}</span>
      <span className="flex items-center gap-1.5">
        {custom && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-xs text-zinc-400 underline hover:text-zinc-600 dark:hover:text-zinc-200"
          >
            clear
          </button>
        )}
        <input
          type="text"
          aria-label={`${label} hex`}
          value={text}
          spellCheck={false}
          maxLength={7}
          onChange={(e) => commit(e.target.value.trim())}
          className={`w-20 rounded border bg-transparent px-1.5 py-1 font-mono text-xs outline-none ${
            valid
              ? 'border-zinc-300 dark:border-zinc-600'
              : 'border-red-400 text-red-600 dark:text-red-400'
          }`}
        />
        <input
          type="color"
          aria-label={label}
          value={resolved}
          onChange={(e) => commit(e.target.value)}
          className="h-7 w-9 shrink-0 cursor-pointer rounded border border-zinc-300 bg-transparent p-0.5 dark:border-zinc-600"
        />
      </span>
    </div>
  );
}

/** Save the node's current colours as a reusable preset (corporate colours). */
function SavedPalettes({ palettes, onSave, onRemove }: {
  palettes: CustomPalette[];
  onSave: (name: string) => void;
  onRemove: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const full = palettes.length >= MAX_CUSTOM_PALETTES;
  return (
    <div className="mt-1 border-t border-zinc-200 pt-1.5 dark:border-zinc-700">
      <div className="flex items-center gap-1.5 px-2">
        <input
          type="text"
          aria-label="Preset name"
          placeholder="Preset name"
          value={name}
          maxLength={24}
          onChange={(e) => setName(e.target.value)}
          className="min-w-0 flex-1 rounded border border-zinc-300 bg-transparent px-1.5 py-1 text-xs outline-none dark:border-zinc-600"
        />
        <button
          type="button"
          disabled={full}
          onClick={() => { onSave(name); setName(''); }}
          className="shrink-0 rounded bg-accent-600 px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
        >
          Save preset
        </button>
      </div>
      {full && <p className="px-2 pt-1 text-[11px] text-zinc-400">Preset limit reached ({MAX_CUSTOM_PALETTES}).</p>}
      {palettes.length > 0 && (
        <ul className="mt-1 max-h-32 overflow-y-auto">
          {palettes.map((p) => (
            <li key={p.id} className="flex items-center gap-2 px-2 py-1 text-xs text-zinc-600 dark:text-zinc-300">
              <span className="h-4 w-4 shrink-0 rounded border-2" style={{ background: p.bg, borderColor: p.border }} />
              <span className="min-w-0 flex-1 truncate">{p.name}</span>
              <button
                type="button"
                aria-label={`Delete preset ${p.name}`}
                onClick={() => onRemove(p.id)}
                className="shrink-0 text-zinc-400 hover:text-red-500"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Rendered into <body>: the toolbar is a horizontal scroll container
// (overflow-x), which clips absolutely-positioned children in *both* axes, so
// an in-flow popover opened here is invisible under the canvas.
function Popover({ anchorRef, label, onClose, children }: {
  anchorRef: React.RefObject<HTMLDivElement | null>;
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = 236;
      setPosition({
        top: anchor.bottom + 4,
        left: Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)),
      });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchorRef]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node)) return;
      // The trigger handles its own toggle — closing here too would re-open it
      if (popoverRef.current?.contains(e.target) || anchorRef.current?.contains(e.target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, anchorRef]);

  return createPortal(
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={label}
      style={{ top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? undefined : 'hidden' }}
      className="fixed z-50 w-[236px] rounded-xl border border-zinc-200 bg-white p-2 shadow-lg dark:border-zinc-700 dark:bg-zinc-800"
    >
      {children}
    </div>,
    document.body,
  );
}
