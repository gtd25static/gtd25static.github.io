import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { Settings, LocalSettings } from '../db/models';
import { DEFAULT_KEYBOARD_SHORTCUTS } from '../lib/constants';

const defaultSettings: Settings = {
  theme: 'system',
  keyboardShortcuts: { ...DEFAULT_KEYBOARD_SHORTCUTS },
};

export function useSettings() {
  return defaultSettings;
}

export function useLocalSettings() {
  const local = useLiveQuery(() => db.localSettings.get('local'));
  return local ?? { id: 'local', syncEnabled: false, syncIntervalMs: 300_000 } as LocalSettings;
}

export async function updateLocalSettings(updates: Partial<LocalSettings>) {
  await db.localSettings.update('local', updates);
}
