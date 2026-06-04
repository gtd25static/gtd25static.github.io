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

let fetchCount = 0;
self.addEventListener('fetch', (event) => {
  fetchCount++;
  if (fetchCount <= 5 || fetchCount % 50 === 0) {
    console.debug(`[SW] fetch #${fetchCount}: ${event.request.url.slice(0, 100)}`);
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
    self.skipWaiting();
  }
});

// --- Workbox setup ---
clientsClaim();
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')));
