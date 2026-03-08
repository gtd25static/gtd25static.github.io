export const SYNC_VERSION = 2;

export function isCompatibleVersion(remote: number | undefined): boolean {
  return (remote ?? 0) <= SYNC_VERSION;
}

export function needsMigration(remote: number | undefined): boolean {
  return (remote ?? 0) < SYNC_VERSION;
}
