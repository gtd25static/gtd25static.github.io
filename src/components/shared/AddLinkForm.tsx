import { useState } from 'react';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { isValidUrl } from '../../lib/link-utils';

interface Props {
  onAdd: (url: string, title?: string) => void;
  onCancel: () => void;
}

export function AddLinkForm({ onAdd, onCancel }: Props) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmedUrl = url.trim();
    if (!trimmedUrl || !isValidUrl(trimmedUrl)) return;
    onAdd(trimmedUrl, title.trim() || undefined);
    setUrl('');
    setTitle('');
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <Input
        placeholder="https://..."
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        autoFocus
      />
      <div className="flex items-center gap-2">
        <Input
          placeholder="Title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="flex-1"
        />
        <Button type="submit" size="sm">Add</Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
