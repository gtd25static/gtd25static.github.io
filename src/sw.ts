/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { clientsClaim } from 'workbox-core';
import { handleShareTarget, isShareTargetPost, redactUrlForLog, handleNotificationClick, handleSwMessage } from './lib/sw-handlers';

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
  // Intercept the share-target POST before anything else and take it over.
  if (isShareTargetPost(event.request)) {
    event.respondWith(handleShareTarget(event.request));
    return;
  }
  fetchCount++;
  if (fetchCount <= 5 || fetchCount % 50 === 0) {
    console.debug(`[SW] fetch #${fetchCount}: ${redactUrlForLog(event.request.url)}`);
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data as { url?: string } | undefined;
  event.waitUntil(handleNotificationClick(self, data));
});

self.addEventListener('message', (event) => {
  const pending = handleSwMessage(event.data, self);
  if (pending) event.waitUntil(pending);
});

// --- Workbox setup ---
clientsClaim();
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')));
