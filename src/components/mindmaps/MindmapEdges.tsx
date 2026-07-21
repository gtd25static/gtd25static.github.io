import { memo } from 'react';
import type { MindmapLayout } from '../../lib/mindmap-layout';
import { edgePath } from '../../lib/mindmap-layout';

interface Props {
  layout: MindmapLayout;
  /** Node ids that have children (visible or hidden). */
  parentIds: Set<string>;
  collapsed: Set<string>;
  onToggle: (nodeId: string) => void;
}

// Curved parent→child connectors plus the collapse controls: one circle on the
// right edge of every node that has children, showing "−" (expanded) or "+"
// (collapsed, children hidden). The visible circle is small; an invisible r=22
// hit circle satisfies the 44px touch-target rule.
export const MindmapEdges = memo(function MindmapEdges({ layout, parentIds, collapsed, onToggle }: Props) {
  return (
    <g>
      <g className="text-zinc-300 dark:text-zinc-600" fill="none" stroke="currentColor" strokeWidth={1.5}>
        {layout.edges.map((e) => (
          <path key={`${e.fromId}-${e.toId}`} d={edgePath(e)} />
        ))}
      </g>
      {[...parentIds].map((id) => {
        const rect = layout.rects.get(id);
        if (!rect) return null; // parent inside a collapsed subtree
        const cx = rect.x + rect.w + 12;
        const cy = rect.y + rect.h / 2;
        const isCollapsed = collapsed.has(id);
        return (
          <g
            key={id}
            className="cursor-pointer"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onToggle(id); }}
          >
            <circle cx={cx} cy={cy} r={22} fill="transparent" />
            <circle
              cx={cx}
              cy={cy}
              r={9}
              className={`${isCollapsed ? 'fill-accent-50 stroke-accent-500 dark:fill-accent-900' : 'fill-white stroke-zinc-400 dark:fill-zinc-800 dark:stroke-zinc-500'}`}
              strokeWidth={1.5}
            />
            <path
              d={isCollapsed
                ? `M ${cx - 4} ${cy} H ${cx + 4} M ${cx} ${cy - 4} V ${cy + 4}`
                : `M ${cx - 4} ${cy} H ${cx + 4}`}
              className={isCollapsed ? 'stroke-accent-600 dark:stroke-accent-400' : 'stroke-zinc-500 dark:stroke-zinc-400'}
              strokeWidth={1.5}
              strokeLinecap="round"
            />
          </g>
        );
      })}
    </g>
  );
});
