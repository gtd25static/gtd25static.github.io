import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MindmapNode } from '../../db/models';
import type { LayoutRect } from '../../lib/mindmap-layout';
import { MdLabel } from './MdLabel';

export const NODE_MAX_WIDTH = 240;

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
  onMeasure: (id: string, size: { w: number; h: number }) => void;
  onPointerDown: (e: React.PointerEvent, id: string) => void;
  onCommitEdit: (id: string, label: string) => void;
  onCancelEdit: () => void;
}

// One mindmap node: an HTML rounded rect inside a foreignObject. The box sizes
// itself (width: max-content capped at NODE_MAX_WIDTH), measures itself after
// every content/clamp change via offsetWidth/Height (layout px — unaffected by
// the canvas zoom transform) and reports up; the canvas lays out from those
// sizes. Long labels clamp to 3 lines unless the node is selected/editing —
// the resulting size change re-layouts, which is intended.
export const MindmapNodeView = memo(function MindmapNodeView({
  node, rect, selected, hovered, editing, isRoot, isDragSource, isDropTarget,
  animateIn, leaving, onMeasure, onPointerDown, onCommitEdit, onCancelEdit,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(node.label);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Pinned at mount: adding the class later (when the canvas flips to
  // "animate") would replay the entrance on every node already on screen.
  const animateInRef = useRef(animateIn);

  const clamped = !selected && !editing;

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
    const el = boxRef.current;
    if (!el || leaving) return; // a ghost must not feed the layout it just left
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (w > 0 && h > 0) onMeasure(node.id, { w, h });
  });

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

  // The action buttons float over the neighbours (siblings are 12px apart), so
  // the node that owns them is marked — otherwise it's ambiguous which node a
  // button belongs to.
  const border = isDropTarget
    ? 'border-accent-500 ring-2 ring-accent-300 dark:ring-accent-700'
    : selected
      ? 'border-accent-500 shadow-md'
      : hovered
        ? 'border-accent-400 shadow-sm dark:border-accent-500'
        : 'border-zinc-300 dark:border-zinc-600';

  return (
    <foreignObject
      x={rect?.x ?? 0}
      y={rect?.y ?? 0}
      width={rect ? rect.w : NODE_MAX_WIDTH + 40}
      height={rect ? rect.h : 600}
      className="overflow-visible"
      style={
        rect
          ? (leaving ? { pointerEvents: 'none' } : undefined)
          : { opacity: 0, pointerEvents: 'none' }
      }
    >
      <div
        ref={boxRef}
        // @ts-expect-error xmlns is required on HTML content inside foreignObject
        xmlns="http://www.w3.org/1999/xhtml"
        data-mindmap-node={leaving ? undefined : node.id}
        onPointerDown={(e) => onPointerDown(e, node.id)}
        className={`mm-node-box select-none rounded-xl border-2 px-3 py-1.5 text-sm leading-snug ${
          leaving ? 'mm-node-out' : animateInRef.current && rect ? 'mm-node-in' : ''
        } ${editing ? 'mm-node-editing' : ''} ${border} ${
          isRoot
            ? 'bg-accent-50 text-zinc-900 dark:bg-accent-900/30 dark:text-zinc-50'
            : 'bg-white text-zinc-800 dark:bg-zinc-800 dark:text-zinc-100'
        } ${isDragSource ? 'opacity-40' : ''} ${editing ? 'cursor-text' : 'cursor-grab'}`}
        style={{ width: 'max-content', maxWidth: NODE_MAX_WIDTH }}
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
            className="block w-52 resize-none bg-transparent text-sm leading-snug outline-none"
          />
        ) : (
          <div className={clamped ? 'line-clamp-3' : undefined}>
            <MdLabel label={node.label} />
          </div>
        )}
      </div>
    </foreignObject>
  );
});
