import { useState, useRef, useEffect, useLayoutEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

interface Props {
  trigger: ReactNode;
  items: MenuItem[];
}

const GUTTER = 8; // keep the menu this far inside the viewport
const GAP = 4; // between trigger and menu

/**
 * Where the menu goes: under the trigger, right edges aligned — or above it when
 * there is no room below — and always inside the viewport.
 */
function placeMenu(trigger: DOMRect, size: { width: number; height: number }): { top: number; left: number } {
  const below = trigger.bottom + GAP;
  const above = trigger.top - GAP - size.height;
  const fitsBelow = below + size.height <= window.innerHeight - GUTTER;
  const top = fitsBelow || above < GUTTER
    ? Math.max(GUTTER, Math.min(below, window.innerHeight - GUTTER - size.height))
    : above;
  const left = Math.max(GUTTER, Math.min(trigger.right - size.width, window.innerWidth - GUTTER - size.width));
  return { top, left };
}

// The menu is rendered into <body> with fixed coordinates: an absolutely placed
// menu was clipped by any scrolling ancestor — the sidebar's list rows live in a
// scrolling <nav>, so for the last lists Rename/Archive/Delete opened out of
// sight below the viewport (GUI review).
export function DropdownMenu({ trigger, items }: Props) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = pos !== null;

  // Place it once rendered, with its real size (first frame uses an estimate).
  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const menu = menuRef.current.getBoundingClientRect();
    const next = placeMenu(triggerRef.current.getBoundingClientRect(), { width: menu.width, height: menu.height });
    if (next.top !== pos!.top || next.left !== pos!.left) setPos(next);
  }, [open, pos]);

  useEffect(() => {
    if (!open) return;
    const close = () => setPos(null);
    function handleClick(e: MouseEvent) {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      close();
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', onKey);
    // Fixed coordinates go stale when anything scrolls or resizes: just close.
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  function toggle() {
    if (open || !triggerRef.current) { setPos(null); return; }
    setPos(placeMenu(triggerRef.current.getBoundingClientRect(), { width: 160, height: items.length * 44 + 12 }));
  }

  return (
    <div className="relative">
      <button ref={triggerRef} data-dropdown-trigger onClick={toggle} className="rounded-full p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center">
        {trigger}
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          data-dropdown-menu
          style={{ position: 'fixed', top: pos.top, left: pos.left }}
          className="z-[95] min-w-[160px] rounded-xl border border-zinc-200 bg-white py-1.5 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
        >
          {items.map((item) => (
            <button
              key={item.label}
              onClick={() => { item.onClick(); setPos(null); }}
              className={`w-full px-4 py-3 md:py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 ${
                item.danger ? 'text-red-600 dark:text-red-400' : 'text-zinc-700 dark:text-zinc-300'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>,
        // Inside a modal <dialog> (top layer) the menu must stay in it to be seen.
        triggerRef.current?.closest('dialog') ?? document.body,
      )}
    </div>
  );
}
