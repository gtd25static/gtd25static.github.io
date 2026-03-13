import { useEffect, useRef } from 'react';
import type { TaskList } from '../../db/models';

interface Props {
  lists: TaskList[];
  onSelect: (listId: string) => void;
  onClose: () => void;
}

export function BulkListPicker({ lists, onSelect, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  return (
    <div ref={ref} className="absolute bottom-full left-0 mb-1 w-48 rounded-lg border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-800 z-50">
      {lists.map((list) => (
        <button
          key={list.id}
          onClick={() => onSelect(list.id)}
          className="w-full px-3 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-700"
        >
          {list.name}
        </button>
      ))}
      {lists.length === 0 && (
        <span className="block px-3 py-1.5 text-sm text-zinc-400">No other lists</span>
      )}
    </div>
  );
}
