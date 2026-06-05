// Pure helpers for the in-app update changelog (what a pending update contains).
// Kept out of the component so they're unit-testable and defensive against a
// malformed version.json from the network.

export interface VersionInfo {
  commit: string;
  message: string;
  builtAt?: string;
  log?: Array<{ h: string; s: string }>;
}

/**
 * The commits in the incoming build that are newer than the running one — walk
 * the recent log until the current commit is reached. Falls back to all known
 * entries (current not in the window) or just the headline commit (no log).
 */
export function changelogFor(info: VersionInfo, current: string): Array<{ h: string; s: string }> {
  if (info.log && info.log.length) {
    const fresh: Array<{ h: string; s: string }> = [];
    for (const c of info.log) {
      if (c.h === current) return fresh;
      fresh.push(c);
    }
    if (fresh.length) return fresh; // current not found in window — show what we have
  }
  return info.message ? [{ h: info.commit, s: info.message }] : [];
}

/** Validate/normalize an untrusted version.json payload; null if unusable. */
export function parseVersionInfo(j: unknown): VersionInfo | null {
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  if (typeof o.commit !== 'string' || !o.commit) return null;
  const log = Array.isArray(o.log)
    ? (o.log as unknown[]).filter(
        (c): c is { h: string; s: string } =>
          !!c && typeof c === 'object'
          && typeof (c as Record<string, unknown>).h === 'string'
          && typeof (c as Record<string, unknown>).s === 'string',
      )
    : undefined;
  return {
    commit: o.commit,
    message: typeof o.message === 'string' ? o.message : '',
    builtAt: typeof o.builtAt === 'string' ? o.builtAt : undefined,
    log,
  };
}
