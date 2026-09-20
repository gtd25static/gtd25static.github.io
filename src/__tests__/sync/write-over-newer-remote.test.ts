// The read paths have always refused a remote written by a newer app version.
// The three DESTRUCTIVE write paths did not — and "Force push" is exactly what a
// user reaches for when their un-updated device starts saying "update required".
// That click replaced the newer snapshot with this device's older-format data
// and deleted the changelog, destroying every edit the updated devices had made.
import { isCompatibleVersion, SYNC_VERSION } from '../../sync/version';

describe('the version gate that protects the other devices', () => {
  it('treats a remote one version ahead as incompatible', () => {
    expect(isCompatibleVersion(SYNC_VERSION + 1)).toBe(false);
    expect(isCompatibleVersion(SYNC_VERSION)).toBe(true);
    expect(isCompatibleVersion(undefined)).toBe(true); // pre-versioning remote
  });

  it('guards every destructive whole-snapshot writer, not just the readers', async () => {
    // A structural check: each of these must consult the guard before its
    // putFile. Cheaper and more durable than mocking the whole GitHub surface,
    // and it fails loudly if a future writer forgets.
    const src = await import('node:fs/promises')
      .then((fs) => fs.readFile('src/sync/sync-engine.ts', 'utf8'));

    for (const where of ['forcePush', 'importData', 'restoreFromBackup']) {
      expect(src, `${where} must refuse to write over a newer remote`)
        .toContain(`refuseWriteOverNewerRemote(existing?.data, '${where}')`);
    }
    // Compaction rewrites the whole snapshot too, and runs BEFORE the pull's
    // own check.
    expect(src).toContain("recordSyncMessage('compaction.versionIncompatible'");
  });
});
