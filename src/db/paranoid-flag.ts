// Synchronous source of truth for "this device is in Paranoid Mode".
//
// Pulled into its own dependency-free module so non-vault code (e.g. the backup
// routines) can consult it without importing the stateful vault — which would
// risk an import cycle (db/index -> backup -> vault -> db/index). vault.ts is
// the writer of this flag; everyone else only reads.

export const PARANOID_FLAG = 'gtd25-paranoid';

export function isParanoidFlagSet(): boolean {
  try { return localStorage.getItem(PARANOID_FLAG) === '1'; } catch { return false; }
}
