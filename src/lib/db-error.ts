import { toast } from '../components/ui/Toast';

export function handleDbError(error: unknown, operation: string): void {
  console.error(`DB ${operation} failed:`, error);

  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    toast('Storage full — delete old tasks or export data.', 'error');
    return;
  }

  toast(`Failed to ${operation}. Please try again.`, 'error');
}
