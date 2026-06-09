// Periodic squash of the sync repo's DEFAULT branch to bound git history growth.
//
// Every sync rewrites gtd25-changelog.json (and periodically gtd25-snapshot.json),
// so the default branch accumulates a commit per push forever. This periodically
// flattens it to a single orphan commit that keeps the EXACT current tree.
//
// Why it's safe: git blob SHAs are content-addressed, so the squash leaves every
// file's SHA unchanged. The app's optimistic concurrency keys off content SHA
// (getFile -> json.sha, putFile If-Match), not commit history, so this device and
// all other devices keep syncing transparently. Recovery relies on the remote
// gtd25-backup-{hourly,daily,weekly}.json files (kept in the tree), not git
// history. Only this branch's history is dropped; GitHub GCs it on its own
// schedule (we make it unreferenced; there is no API to force GC).

import { db } from '../db';
import { getDefaultBranch, getRef, getCommit, createCommit, updateRef } from './github-api';

const MAIN_SQUASH_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // ~monthly

/**
 * Flatten the default branch to a single orphan commit holding the current tree.
 * Returns true if it force-updated the ref, false if it skipped (already squashed,
 * empty, or a concurrent push raced us).
 */
export async function squashDefaultBranch(pat: string, repo: string): Promise<boolean> {
  const branch = await getDefaultBranch(pat, repo);
  const head = await getRef(pat, repo, branch);
  if (!head) return false;

  const { treeSha, parents } = await getCommit(pat, repo, head);
  if (parents.length === 0) return false; // already a single root commit — nothing to gain

  const newCommit = await createCommit(pat, repo, {
    message: 'gtd25: compact history', tree: treeSha, parents: [],
  });

  // Concurrency guard: only force-update if no one pushed to the branch meanwhile.
  const head2 = await getRef(pat, repo, branch);
  if (head2 !== head) {
    console.warn('Default branch changed during history compaction — skipping force-update');
    return false;
  }
  await updateRef(pat, repo, branch, newCommit, true);
  return true;
}

/**
 * Gated entry point, called fire-and-forget at the end of a successful sync.
 * Squashes at most once per interval. The very first call only arms the clock so
 * a fresh repo isn't force-pushed immediately.
 */
export async function maybeSquashDefaultBranch(pat: string, repo: string): Promise<void> {
  const meta = await db.syncMeta.get('sync-meta');
  const now = Date.now();
  const last = meta?.lastMainSquashAt;
  if (last == null) {
    await db.syncMeta.update('sync-meta', { lastMainSquashAt: now });
    return;
  }
  if (now - last < MAIN_SQUASH_INTERVAL_MS) return;

  await squashDefaultBranch(pat, repo);
  await db.syncMeta.update('sync-meta', { lastMainSquashAt: now });
}
