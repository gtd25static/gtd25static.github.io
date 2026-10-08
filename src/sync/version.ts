export const SYNC_VERSION = 11;

export function isCompatibleVersion(remote: number | undefined): boolean {
  return (remote ?? 0) <= SYNC_VERSION;
}

export function needsMigration(remote: number | undefined): boolean {
  return (remote ?? 0) < SYNC_VERSION;
}
