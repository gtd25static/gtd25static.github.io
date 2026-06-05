// Test stub for the Vite virtual module `virtual:pwa-register/react`, which only
// exists when vite-plugin-pwa runs (not under vitest). Mirrors the shape
// use-service-worker.tsx consumes.
export function useRegisterSW(_options?: unknown): {
  needRefresh: [boolean, (v: boolean) => void];
  offlineReady: [boolean, (v: boolean) => void];
  updateServiceWorker: (reloadPage?: boolean) => Promise<void>;
} {
  return {
    needRefresh: [false, () => {}],
    offlineReady: [false, () => {}],
    updateServiceWorker: async () => {},
  };
}
