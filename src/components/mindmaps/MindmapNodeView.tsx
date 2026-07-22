import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MindmapNode } from '../../db/models';
import type { LayoutRect } from '../../lib/mindmap-layout';
import {
  SHAPE_TEXT_MAX_WIDTH,
  diamondPoints,
  resolveNodeStyle,
  shapeSize,
  type NodeStylePatch,
} from '../../lib/mindmap-style';
import { MdLabel } from './MdLabel';

export const NODE_MAX_WIDTH = SHAPE_TEXT_MAX_WIDTH.rect;

interface Props {
  node: MindmapNode;
  /** Layout position; undefined while the node is still unmeasured. */
  rect: LayoutRect | undefined;
  selected: boolean;
  /** Pointer-resolved hover (see mindmap-hover.ts) — owns the action buttons. */
  hovered: boolean;
  editing: boolean;
  isRoot: boolean;
  isDragSource: boolean;
  isDropTarget: boolean;
  /** Animate the box in on mount (off until the canvas has settled). */
  animateIn: boolean;
  /** A ghost of a node that just left, playing its exit animation. */
  leaving?: boolean;
  /** Toolbar hovering a preset: draw the node with it, without storing it. */
  stylePreview?: NodeStylePatch | null;
  onMeasure: (id: string, size: { w: number; h: number }) => void;
  onPointerDown: (e: React.PointerEvent, id: string) => void;
  onCommitEdit: (id: string, label: string) => void;
  onCancelEdit: () => void;
}

// One mindmap node: the shape is an SVG element (a rect/ellipse/polygon can
// carry a real border, which a clip-path'd HTML box cannot) and the label lives
// in a foreignObject centred on top of it. The label measures itself
// (width: max-content, capped per shape) and the canvas lays out from
// shapeSize() of that — so a circle takes its label's diagonal and a diamond
// grows both ways. Long labels clamp to 3 lines unless selected/editing.
export const MindmapNodeView = memo(function MindmapNodeView({
  node, rect, selected, hovered, editing, isRoot, isDragSource, isDropTarget,
  animateIn, leaving, stylePreview, onMeasure, onPointerDown, onCommitEdit, onCancelEdit,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(node.label);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Pinned at mount: adding the class later (when the canvas flips to
  // "animate") would replay the entrance on every node already on screen.
  const animateInRef = useRef(animateIn);

  const style = resolveNodeStyle(node, { isRoot, preview: stylePreview });
  const textMaxWidth = SHAPE_TEXT_MAX_WIDTH[style.shape];
  const clamped = !selected && !editing;

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || leaving) return; // a ghost must not feed the layout it just left
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (w > 0 && h > 0) onMeasure(node.id, shapeSize(style.shape, w, h));
  });

  // Pressing anywhere outside the open editor commits and closes it. Blur alone
  // isn't enough: a press can land on something that never takes focus (the
  // canvas background, a toolbar icon), and on mobile Safari it may not fire at
  // all. Capture phase, so handlers that stop propagation can't swallow it.
  useEffect(() => {
    if (!editing) return;
    const onDocumentPointerDown = (e: PointerEvent) => {
      const ta = textareaRef.current;
      if (ta && e.target instanceof Node && ta.contains(e.target)) return;
      onCommitEdit(node.id, draftRef.current);
    };
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    return () => document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  }, [editing, node.id, onCommitEdit]);

  useLayoutEffect(() => {
    if (!editing) {
      setDraft(node.label);
      return;
    }
    const ta = textareaRef.current;
    if (ta) {
      ta.focus();
      ta.select();
      ta.style.height = 'auto';
      ta.style.height = `${ta.scrollHeight}px`;
    }
  }, [editing, node.label]);

  // Selection/hover draw an accent outline *around* the shape instead of
  // recolouring its border, so a node's own colours survive being pointed at.
  const outline = isDropTarget
    ? { grow: 4, color: 'var(--color-accent-500)', width: 3 }
    : selected
      ? { grow: 3, color: 'var(--color-accent-500)', width: 2 }
      : hovered
        ? { grow: 3, color: 'var(--color-accent-400)', width: 1.5 }
        : null;

  const placed = rect ?? { x: 0, y: 0, w: NODE_MAX_WIDTH + 40, h: 600 };

  return (
    <g
      className={`mm-node-box ${editing ? 'mm-node-editing' : ''} ${
        leaving ? 'mm-node-out' : animateInRef.current && rect ? 'mm-node-in' : ''
      }`}
      style={{
        transformOrigin: `${placed.x + placed.w / 2}px ${placed.y + placed.h / 2}px`,
        opacity: rect ? (isDragSource ? 0.4 : undefined) : 0,
        pointerEvents: rect && !leaving ? undefined : 'none',
      }}
    >
      {rect && (
        <>
          {outline && (
            <NodeShape
              shape={style.shape}
              rect={rect}
              grow={outline.grow}
              fill="none"
              stroke={outline.color}
              strokeWidth={outline.width}
            />
          )}
          <NodeShape
            shape={style.shape}
            rect={rect}
            className="mm-node-shape"
            fill={style.bg}
            stroke={style.border}
            strokeWidth={2}
          />
        </>
      )}
      <foreignObject
        x={placed.x}
        y={placed.y}
        width={placed.w}
        height={placed.h}
        className="overflow-visible"
      >
        <div
          // @ts-expect-error xmlns is required on HTML content inside foreignObject
          xmlns="http://www.w3.org/1999/xhtml"
          data-mindmap-node={leaving ? undefined : node.id}
          onPointerDown={(e) => onPointerDown(e, node.id)}
          className={`flex h-full w-full items-center justify-center ${editing ? 'cursor-text' : 'cursor-grab'}`}
          style={{ color: style.fg }}
        >
          <div
            ref={boxRef}
            className={`select-none px-1 text-sm leading-snug ${clamped ? 'line-clamp-3' : ''}`}
            style={{ width: 'max-content', maxWidth: textMaxWidth }}
          >
            {editing ? (
              <textarea
                ref={textareaRef}
                value={draft}
                maxLength={1000}
                rows={1}
                onChange={(e) => {
                  setDraft(e.target.value);
                  e.target.style.height = 'auto';
                  e.target.style.height = `${e.target.scrollHeight}px`;
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    onCommitEdit(node.id, draft);
                  } else if (e.key === 'Escape') {
                    onCancelEdit();
                  }
                }}
                onBlur={() => onCommitEdit(node.id, draft)}
                onPointerDown={(e) => e.stopPropagation()}
                className="block w-full resize-none bg-transparent text-center text-sm leading-snug outline-none"
                style={{ width: textMaxWidth, color: style.fg }}
              />
            ) : (
              <MdLabel label={node.label} />
            )}
          </div>
        </div>
      </foreignObject>
    </g>
  );
});

function NodeShape({ shape, rect, grow = 0, ...svg }: {
  shape: MindmapNode['shape'];
  rect: LayoutRect;
  grow?: number;
} & React.SVGProps<SVGRectElement & SVGEllipseElement & SVGPolygonElement>) {
  const x = rect.x - grow;
  const y = rect.y - grow;
  const w = rect.w + grow * 2;
  const h = rect.h + grow * 2;
  if (shape === 'circle') {
    return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...svg} />;
  }
  if (shape === 'diamond') {
    return <polygon points={diamondPoints(x, y, w, h)} {...svg} />;
  }
  return <rect x={x} y={y} width={w} height={h} rx={12 + grow} {...svg} />;
}
