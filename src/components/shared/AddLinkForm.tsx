import { useState } from 'react';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { isValidUrl } from '../../lib/link-utils';

interface Props {
  onAdd: (url: string, title?: string) => void;
  onCancel: () => void;
}

// Rendered inside the task/subtask <form>s, so it must not be a <form> itself:
// a nested form's submit escapes to the outer one, which the browser then
// submits natively (page reload, everything typed is lost). Add is a plain
// button and Enter is handled here so it never submits the outer form.
export function AddLinkForm({ onAdd, onCancel }: Props) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');

  function handleAdd() {
    const trimmedUrl = url.trim();
    if (!trimmedUrl || !isValidUrl(trimmedUrl)) return;
    onAdd(trimmedUrl, title.trim() || undefined);
    setUrl('');
    setTitle('');
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      // Close just this link form: the enclosing task form (and an Edit Task
      // dialog) also cancel on Escape, which would discard everything typed.
      e.preventDefault();
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    handleAdd();
  }

  return (
    <div className="flex flex-col gap-2">
      <Input
        placeholder="https://..."
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={handleKeyDown}
        autoFocus
      />
      <div className="flex items-center gap-2">
        <Input
          placeholder="Title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={handleKeyDown}
          className="flex-1"
        />
        <Button type="button" size="sm" onClick={handleAdd}>Add</Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
