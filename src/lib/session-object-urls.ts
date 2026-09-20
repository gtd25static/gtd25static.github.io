// Object URLs that hold decrypted content, tracked so a lock can revoke them.
//
// A `blob:` URL is resolvable by anything on this origin until it is revoked or
// the document goes away. The shared-folder download deliberately keeps one
// alive for a minute so the browser's download machinery can fetch it — which
// meant a decrypted file stayed reachable for that minute after the vault
// locked, outliving the DEK it came from. Callers register here instead of
// holding their own timer, and `forget-on-lock` revokes whatever is still open.

interface TrackedUrl { url: string; timer: ReturnType<typeof setTimeout> }

const open = new Set<TrackedUrl>();

/**
 * Create an object URL that is revoked after `ttlMs`, or on the next lock —
 * whichever comes first.
 */
export function createSessionObjectUrl(blob: Blob, ttlMs: number): string {
  const url = URL.createObjectURL(blob);
  const entry: TrackedUrl = {
    url,
    timer: setTimeout(() => {
      open.delete(entry);
      URL.revokeObjectURL(url);
    }, ttlMs),
  };
  open.add(entry);
  return url;
}

/** Revoke every tracked URL now. Safe to call when none are open. */
export function revokeSessionObjectUrls(): void {
  for (const entry of open) {
    clearTimeout(entry.timer);
    URL.revokeObjectURL(entry.url);
  }
  open.clear();
}

/** Test-only: how many URLs are still resolvable. */
export function __openSessionObjectUrlCount(): number {
  return open.size;
}
