import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from './Button';
import { Input } from './Input';

interface ConfirmRequest {
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  typeToConfirm?: string;
  resolve: (confirmed: boolean) => void;
}

let showConfirmFn: ((req: Omit<ConfirmRequest, 'resolve'>) => Promise<boolean>) | null = null;

export function confirmDialog(
  message: string,
  options?: { confirmLabel?: string; danger?: boolean; typeToConfirm?: string },
): Promise<boolean> {
  if (!showConfirmFn) return Promise.resolve(false);
  return showConfirmFn({ message, ...options });
}

export function ConfirmDialogContainer() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const [typed, setTyped] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);

  const show = useCallback((req: Omit<ConfirmRequest, 'resolve'>) => {
    return new Promise<boolean>((resolve) => {
      setTyped('');
      setRequest({ ...req, resolve });
    });
  }, []);

  useEffect(() => {
    showConfirmFn = show;
    return () => { showConfirmFn = null; };
  }, [show]);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (request && !el.open) el.showModal();
    else if (!request && el.open) el.close();
  }, [request]);

  // The typed gate is an anti-accident control, not authentication — accept
  // case/whitespace variants (mobile keyboards autocapitalize despite hints).
  const typedMatches = !request?.typeToConfirm
    || typed.trim().toLowerCase() === request.typeToConfirm.toLowerCase();

  function handleConfirm() {
    if (!request || !typedMatches) return;
    request.resolve(true);
    setRequest(null);
  }

  function handleCancel() {
    request?.resolve(false);
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
        <p className="text-sm text-zinc-700 dark:text-zinc-300">{request.message}</p>
        {request.typeToConfirm && (
          <div className="mt-3">
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={`Type "${request.typeToConfirm}" to confirm`}
              autoFocus
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </div>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" size="sm" type="button" onClick={handleCancel}>
            Cancel
          </Button>
          <Button
            variant={request.danger !== false ? 'danger' : 'primary'}
            size="sm"
            type="submit"
            onClick={handleConfirm}
            disabled={!typedMatches}
            autoFocus={!request.typeToConfirm}
          >
            {request.confirmLabel || 'Confirm'}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
