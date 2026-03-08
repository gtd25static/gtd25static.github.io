import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem {
  label: string;
  onClick?: () => void;
  children?: MenuItem[];
  danger?: boolean;
}

interface Props {
  position: { x: number; y: number };
  items: MenuItem[];
  onClose: () => void;
}

export function ContextMenu({ position, items, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [submenuIndex, setSubmenuIndex] = useState<number | null>(null);
  const [adjusted, setAdjusted] = useState(position);

  useEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const x = position.x + rect.width > window.innerWidth ? window.innerWidth - rect.width - 8 : position.x;
    const y = position.y + rect.height > window.innerHeight ? window.innerHeight - rect.height - 8 : position.y;
    setAdjusted({ x, y });
  }, [position]);

  useEffect(() => {
    function handleDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', handleDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[180px] rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-800"
      style={{ left: adjusted.x, top: adjusted.y }}
    >
      {items.map((item, i) => (
        <div
          key={i}
          className="relative"
          onMouseEnter={() => item.children && setSubmenuIndex(i)}
          onMouseLeave={() => item.children && setSubmenuIndex(null)}
        >
          <button
            className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm ${
              item.danger
                ? 'text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20'
                : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-700'
            }`}
            onClick={() => {
              if (item.onClick) {
                item.onClick();
                onClose();
              }
            }}
          >
            {item.label}
            {item.children && (
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" className="opacity-50">
                <path d="M6 3l5 5-5 5z" />
              </svg>
            )}
          </button>
          {item.children && submenuIndex === i && (
            <Submenu items={item.children} onClose={onClose} parentRef={menuRef} />
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}

function Submenu({
  items,
  onClose,
  parentRef,
}: {
  items: MenuItem[];
  onClose: () => void;
  parentRef: React.RefObject<HTMLDivElement | null>;
}) {
  const subRef = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<'right' | 'left'>('right');

  useEffect(() => {
    if (!subRef.current || !parentRef.current) return;
    const parentRect = parentRef.current.getBoundingClientRect();
    const subRect = subRef.current.getBoundingClientRect();
    if (parentRect.right + subRect.width > window.innerWidth) {
      setSide('left');
    }
  }, [parentRef]);

  return (
    <div
      ref={subRef}
      className={`absolute top-0 z-50 min-w-[160px] rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-800 ${
        side === 'right' ? 'left-full -ml-1' : 'right-full -mr-1'
      }`}
    >
      {items.map((item, i) => (
        <button
          key={i}
          className={`flex w-full px-3 py-1.5 text-left text-sm ${
            item.danger
              ? 'text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20'
              : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-700'
          }`}
          onClick={() => {
            item.onClick?.();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
