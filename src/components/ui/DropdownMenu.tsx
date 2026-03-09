import { useState, useRef, useEffect, type ReactNode } from 'react';

interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

interface Props {
  trigger: ReactNode;
  items: MenuItem[];
}

export function DropdownMenu({ trigger, items }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} className="rounded-full p-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-800 min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 flex items-center justify-center">
        {trigger}
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-1 min-w-[160px] rounded-xl border border-zinc-200 bg-white py-1.5 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          {items.map((item) => (
            <button
              key={item.label}
              onClick={() => { item.onClick(); setOpen(false); }}
              className={`w-full px-4 py-3 md:py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 ${
                item.danger ? 'text-red-600 dark:text-red-400' : 'text-zinc-700 dark:text-zinc-300'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
