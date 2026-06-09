import { useState } from 'react';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { createSnippetItem } from '../../hooks/use-shared-items';

// Inline "create text file" form: a name + a textarea to paste content.
export function CreateSnippetForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    if (!text.trim() || saving) return;
    setSaving(true);
    const item = await createSnippetItem(name, text);
    setSaving(false);
    if (item) onDone();
  }

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); handleSave(); }}
      className="space-y-2 rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-700 dark:bg-zinc-800"
    >
      <Input
        placeholder="Name (e.g. notes.txt)"
        value={name}
        onChange={(e) => setName(e.target.value.slice(0, 200))}
        autoFocus
      />
      <textarea
        placeholder="Paste or type text content…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        className="w-full rounded-lg border border-zinc-200 bg-white p-2 text-sm text-zinc-800 placeholder:text-zinc-400 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={!text.trim() || saving}>
          {saving ? 'Saving…' : 'Save text file'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}
