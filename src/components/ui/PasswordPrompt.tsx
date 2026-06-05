import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from './Button';
import { Input } from './Input';

interface PromptRequest {
  title: string;
  message?: string;
  confirmLabel?: string;
  resolve: (password: string | null) => void;
}

let showPromptFn: ((req: Omit<PromptRequest, 'resolve'>) => Promise<string | null>) | null = null;

/** Imperatively ask the user for a password. Resolves to null if cancelled. */
export function promptPassword(
  title: string,
  options?: { message?: string; confirmLabel?: string },
): Promise<string | null> {
  if (!showPromptFn) return Promise.resolve(null);
  return showPromptFn({ title, ...options });
}

export function PasswordPromptContainer() {
  const [request, setRequest] = useState<PromptRequest | null>(null);
  const [value, setValue] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);

  const show = useCallback((req: Omit<PromptRequest, 'resolve'>) => {
    return new Promise<string | null>((resolve) => {
      setValue('');
      setRequest({ ...req, resolve });
    });
  }, []);

  useEffect(() => {
    showPromptFn = show;
    return () => { showPromptFn = null; };
  }, [show]);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (request && !el.open) el.showModal();
    else if (!request && el.open) el.close();
  }, [request]);

  function handleCancel() {
    request?.resolve(null);
    setRequest(null);
  }

  function handleConfirm() {
    if (!value) return;
    request?.resolve(value);
    setRequest(null);
  }

  if (!request) return null;

  return (
    <dialog
      ref={dialogRef}
      onClose={handleCancel}
      onCancel={(e) => { e.preventDefault(); handleCancel(); }}
      onClick={(e) => { if (e.target === dialogRef.current) handleCancel(); }}
      className="m-auto w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-0 shadow-2xl backdrop:bg-black/30
        dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
    >
      <form
        className="px-6 py-5"
        onSubmit={(e) => { e.preventDefault(); handleConfirm(); }}
      >
        <h2 className="mb-1 text-base font-medium text-zinc-800 dark:text-zinc-200">{request.title}</h2>
        {request.message && (
          <p className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">{request.message}</p>
        )}
        <Input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Password"
          autoFocus
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" size="sm" type="button" onClick={handleCancel}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" type="submit" disabled={!value}>
            {request.confirmLabel || 'OK'}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
