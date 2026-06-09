/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { clientsClaim } from 'workbox-core';
import { SHARE_CACHE, SHARE_TARGET_ACTION, SHARE_META_PATH, shareFilePath, SHARE_TARGET_FLAG } from './lib/share-target';

declare let self: ServiceWorkerGlobalScope;

// --- Web Share Target (POST/multipart) ---
// The OS share sheet POSTs the shared title/text/url + files here. We can't reach the
// app's encrypted store from the SW, so we stash the payload in Cache Storage and
// redirect into the app, which consumes it (use-share-target). Files go to the Shared
// Folder; text/links to the Inbox.
async function handleShareTarget(request: Request): Promise<Response> {
  try {
    const form = await request.formData();
    const str = (k: string): string => { const v = form.get(k); return typeof v === 'string' ? v : ''; };
    const files = form.getAll('files').filter((v): v is File => v instanceof File);

    const cache = await caches.open(SHARE_CACHE);
    const meta = {
      title: str('title'),
      text: str('text'),
      url: str('url'),
      ts: Date.now(),
      files: files.map((f, i) => ({ name: f.name || `shared-${i}`, type: f.type || 'application/octet-stream', size: f.size })),
    };
    await cache.put(new Request(SHARE_META_PATH), new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
    await Promise.all(files.map((f, i) =>
      cache.put(new Request(shareFilePath(i)), new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream' } })),
    ));
    return Response.redirect(`/?${SHARE_TARGET_FLAG}=1`, 303);
  } catch {
    return Response.redirect(`/?${SHARE_TARGET_FLAG}=error`, 303);
  }
}

// --- Lifecycle diagnostics ---
console.debug('[SW] script evaluated at', new Date().toISOString());

self.addEventListener('install', () => {
  console.debug('[SW] install event fired at', new Date().toISOString());
});
self.addEventListener('activate', () => {
  console.debug('[SW] activate event fired at', new Date().toISOString());
});

// Log origin+path ONLY — never the query string. The Web Share Target arrives as
// GET /capture?title=…&text=…&url=…, so the raw URL carries shared task content;
// keeping it out of the SW log avoids leaking it to devtools/console capture (ACR-004).
function redactUrlForLog(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}`.slice(0, 100);
  } catch {
    return '[unparseable url]';
  }
}

let fetchCount = 0;
self.addEventListener('fetch', (event) => {
  // Intercept the share-target POST before anything else and take it over.
  if (event.request.method === 'POST') {
    const url = new URL(event.request.url);
    if (url.pathname === SHARE_TARGET_ACTION) {
      event.respondWith(handleShareTarget(event.request));
      return;
    }
  }
  fetchCount++;
  if (fetchCount <= 5 || fetchCount % 50 === 0) {
    console.debug(`[SW] fetch #${fetchCount}: ${redactUrlForLog(event.request.url)}`);
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data as { url?: string } | undefined;
  const targetUrl = new URL(data?.url ?? '/', self.location.origin).href;

  event.waitUntil((async () => {
    const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const sameOriginClient = windowClients.find((client) => client.url.startsWith(self.location.origin));
    if (sameOriginClient && 'focus' in sameOriginClient) {
      await sameOriginClient.focus();
      return;
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    }
  })());
});

// Message-based skipWaiting for registerType: 'prompt'
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    console.debug('[SW] SKIP_WAITING message received');
    event.waitUntil(self.skipWaiting());
  }
});

// --- Workbox setup ---
clientsClaim();
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')));
