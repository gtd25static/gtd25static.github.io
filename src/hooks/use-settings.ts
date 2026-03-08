import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { LocalSettings } from '../db/models';

export function useLocalSettings() {
  const local = useLiveQuery(() => db.localSettings.get('local'));
  return local ?? { id: 'local', syncEnabled: false, syncIntervalMs: 300_000 } as LocalSettings;
}

export async function updateLocalSettings(updates: Partial<LocalSettings>) {
  await db.localSettings.update('local', updates);
}
