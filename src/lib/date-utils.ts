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
  return `${day}/${month}/${year}`;
}

export function fromInputDate(dateStr: string): number | undefined {
  const match = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return undefined;
  const [, day, month, year] = match;
  return new Date(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T00:00:00`).getTime();
}
