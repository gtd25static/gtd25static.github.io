import { DUE_SOON_DAYS } from './constants';

export function daysUntil(timestamp: number): number {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const target = new Date(timestamp);
  target.setHours(0, 0, 0, 0);
  return Math.ceil((target.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

export function isDueSoon(timestamp: number | undefined): boolean {
  if (!timestamp) return false;
  return daysUntil(timestamp) <= DUE_SOON_DAYS;
}

export function dueDateColor(timestamp: number): string {
  const days = daysUntil(timestamp);
  if (days < 0) return 'text-red-500';
  if (days <= 3) return 'text-orange-500';
  if (days <= DUE_SOON_DAYS) return 'text-yellow-500';
  return 'text-zinc-400';
}

export function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  if (year !== new Date().getFullYear()) {
    return `${day}/${month}/${year}`;
  }
  return `${day}/${month}`;
}

export function toInputDate(timestamp: number): string {
  const d = new Date(timestamp);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${year}-${month}-${day}`;
}

export function fromInputDate(dateStr: string): number | undefined {
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return undefined;
  const [, year, month, day] = match;
  return new Date(`${year}-${month}-${day}T00:00:00`).getTime();
}

export function formatTimeRemaining(nextOccurrence: number): string {
  const diff = nextOccurrence - Date.now();
  if (diff <= 0) return 'now';
  const hours = Math.floor(diff / (1000 * 60 * 60));
  if (hours < 1) return '<1h';
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}
