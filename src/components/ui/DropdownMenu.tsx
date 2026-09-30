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
  /** The trigger's accessible name: triggers are icon-only (⋮, export). */
  label?: string;
}

const GUTTER = 8; // keep the menu this far inside the viewport
const GAP = 4; // between trigger and menu
const MIN_ROOM_BELOW = 200; // less than this under the trigger (~4 rows) and a roomier above: open above

interface Placement { top: number; left: number; maxHeight: number }

/**
 * Where the menu goes: under the trigger, right edges aligned, always inside the
 * viewport. Taller than the room below, it scrolls (maxHeight) instead of being
 * pushed up over its trigger — the Inbox's Process menu lists every list. It
 * opens above only when the room below is cramped and there is more above.
 */
export function placeMenu(trigger: DOMRect, size: { width: number; height: number }): Placement {
  const roomBelow = window.innerHeight - GUTTER - (trigger.bottom + GAP);
  const roomAbove = trigger.top - GAP - GUTTER;
  const left = Math.max(GUTTER, Math.min(trigger.right - size.width, window.innerWidth - GUTTER - size.width));
  if (size.height <= roomBelow || roomBelow >= MIN_ROOM_BELOW || roomBelow >= roomAbove) {
    return { top: trigger.bottom + GAP, left, maxHeight: roomBelow };
  }
  return { top: trigger.top - GAP - Math.min(size.height, roomAbove), left, maxHeight: roomAbove };
}

// The menu is rendered into <body> with fixed coordinates: an absolutely placed
// menu was clipped by any scrolling ancestor — the sidebar's list rows live in a
// scrolling <nav>, so for the last lists Rename/Archive/Delete opened out of
// sight below the viewport (GUI review).
export function DropdownMenu({ trigger, items, label = 'More options' }: Props) {
  const [pos, setPos] = useState<Placement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = pos !== null;

  // Place it once rendered, with its real size (first frame uses an estimate).
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!open || !triggerRef.current || !menu) return;
    // Its full height even while maxHeight caps it: content plus borders.
    const height = menu.scrollHeight + menu.offsetHeight - menu.clientHeight;
    const next = placeMenu(triggerRef.current.getBoundingClientRect(), { width: menu.getBoundingClientRect().width, height });
    if (next.top !== pos!.top || next.left !== pos!.left || next.maxHeight !== pos!.maxHeight) setPos(next);
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
    // Scrolling a long menu itself is not the page moving under it.
    const onScroll = (e: Event) => { if (!menuRef.current?.contains(e.target as Node)) close(); };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', onKey);
    // Fixed coordinates go stale when anything scrolls or resizes: just close.
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  function toggle() {
    if (open || !triggerRef.current) { setPos(null); return; }
    setPos(placeMenu(triggerRef.current.getBoundingClientRect(), { width: 160, height: items.length * 44 + 12 }));
  }

  return (
    <div className="relative">
      <button ref={triggerRef} data-dropdown-trigger onClick={toggle} aria-label={label} aria-haspopup="menu" aria-expanded={open} className="rounded-full p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center">
        {trigger}
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          data-dropdown-menu
          style={{ position: 'fixed', top: pos.top, left: pos.left, maxHeight: pos.maxHeight }}
          className="z-[95] min-w-[160px] max-w-80 overflow-y-auto overscroll-contain rounded-xl border border-zinc-200 bg-white py-1.5 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
        >
          {/* Block items, not the default inline-block: inline ones made the menu's
              natural width all of them side by side, as wide as the screen. */}
          {items.map((item) => (
            <button
              key={item.label}
              onClick={() => { item.onClick(); setPos(null); }}
              className={`block w-full break-words px-4 py-3 md:py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 ${
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
