/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { clientsClaim } from 'workbox-core';

declare let self: ServiceWorkerGlobalScope;

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
