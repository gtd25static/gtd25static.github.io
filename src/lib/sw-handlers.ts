// Service-worker handlers, extracted from src/sw.ts so they can be unit-tested:
// sw.ts is built by vite-plugin-pwa around self.__WB_MANIFEST and workbox imports,
// so it can't be imported from tests. The slices of `self` the handlers need are
// passed in structurally (this module compiles under the app's DOM tsconfig).

import { SHARE_CACHE, SHARE_TARGET_ACTION, SHARE_META_PATH, shareFilePath, SHARE_TARGET_FLAG, selectFilesToStash } from './share-target';

// --- Web Share Target (POST/multipart) ---
// The OS share sheet POSTs the shared title/text/url + files here. We can't reach the
// app's encrypted store from the SW, so we stash the payload in Cache Storage and
// redirect into the app, which consumes it (use-share-target). Files go to the Shared
// Folder; text/links to the Inbox.
export async function handleShareTarget(request: Request): Promise<Response> {
  try {
    const form = await request.formData();
    const str = (k: string): string => { const v = form.get(k); return typeof v === 'string' ? v : ''; };
    const shared = form.getAll('files').filter((v): v is File => v instanceof File);
    // Cap what we stash (ACR-018): the Shared Folder quota would reject oversized
    // files at consume time anyway; refusing them here keeps a mis-share from
    // filling the origin's storage quota first.
    const { keep: files, skipped } = selectFilesToStash(shared);

    const cache = await caches.open(SHARE_CACHE);
    const meta = {
      title: str('title'),
      text: str('text'),
      url: str('url'),
      ts: Date.now(),
      files: files.map((f, i) => ({ name: f.name || `shared-${i}`, type: f.type || 'application/octet-stream', size: f.size })),
      skippedFiles: skipped,
    };
    await cache.put(new Request(SHARE_META_PATH), new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
    await Promise.all(files.map((f, i) =>
      cache.put(new Request(shareFilePath(i)), new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream' } })),
    ));
    return Response.redirect(`/?${SHARE_TARGET_FLAG}=1`, 303);
  } catch {
    // A failed stash can be PARTIAL (meta written, a file put failed) — drop it so
    // no plaintext fragment lingers in Cache Storage (ACR-017).
    try { await caches.delete(SHARE_CACHE); } catch { /* best effort */ }
    return Response.redirect(`/?${SHARE_TARGET_FLAG}=error`, 303);
  }
}

/** The share-target POST the fetch listener must intercept and take over. */
export function isShareTargetPost(request: Request): boolean {
  return request.method === 'POST' && new URL(request.url).pathname === SHARE_TARGET_ACTION;
}

// Log origin+path ONLY — never the query string. The Web Share Target arrives as
// GET /capture?title=…&text=…&url=…, so the raw URL carries shared task content;
// keeping it out of the SW log avoids leaking it to devtools/console capture (ACR-004).
export function redactUrlForLog(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}`.slice(0, 100);
  } catch {
    return '[unparseable url]';
  }
}

/** The slice of ServiceWorkerGlobalScope that notificationclick needs. */
export interface NotificationClickHost {
  location: { origin: string };
  clients: {
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<readonly { url: string; focus?: () => Promise<unknown> }[]>;
    openWindow?: (url: string) => Promise<unknown>;
  };
}

export async function handleNotificationClick(swSelf: NotificationClickHost, data?: { url?: string }): Promise<void> {
  const targetUrl = new URL(data?.url ?? '/', swSelf.location.origin).href;
  const windowClients = await swSelf.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const sameOriginClient = windowClients.find((client) => client.url.startsWith(swSelf.location.origin));
  if (sameOriginClient && 'focus' in sameOriginClient) {
    await sameOriginClient.focus!();
    return;
  }
  if (swSelf.clients.openWindow) {
    await swSelf.clients.openWindow(targetUrl);
  }
}

/** Message-based skipWaiting (registerType: 'prompt'). Returns pending work for waitUntil, or null. */
export function handleSwMessage(data: unknown, swSelf: { skipWaiting(): Promise<void> }): Promise<void> | null {
  if (data && (data as { type?: unknown }).type === 'SKIP_WAITING') {
    console.debug('[SW] SKIP_WAITING message received');
    return swSelf.skipWaiting();
  }
  return null;
}
