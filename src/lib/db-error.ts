import { toast } from '../components/ui/Toast';
import { recordError } from './diagnostics';

/**
 * Storage full, however it arrives: a DOMException, Dexie's own
 * QuotaExceededError (not a DOMException), or — Chrome, usually — an AbortError
 * of the transaction carrying the quota error as its `inner`.
 */
export function isQuotaError(error: unknown): boolean {
  const named = (e: unknown) => !!e && typeof e === 'object' && (e as { name?: unknown }).name === 'QuotaExceededError';
  return named(error) || named((error as { inner?: unknown } | null)?.inner);
}

export function handleDbError(error: unknown, operation: string): void {
  console.error(`DB ${operation} failed:`, error);
  recordError(`db.${operation}`, error);

  if (isQuotaError(error)) {
    toast('Storage full — delete old tasks or export data.', 'error');
    return;
  }

  toast(`Failed to ${operation}. Please try again.`, 'error');
}
