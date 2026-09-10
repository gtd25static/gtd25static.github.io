import { defineConfig, devices } from '@playwright/test';

// Browser end-to-end suite. It runs against the PRODUCTION build served by
// `vite preview`: only that build carries the Content-Security-Policy meta and the
// service worker, and Argon2id (hash-wasm WebAssembly) has to work under that CSP.
const PORT = 4317;

export default defineConfig({
  testDir: './e2e',
  // Every enable / passphrase save / unlock runs Argon2id with 64 MiB: slow and
  // CPU-heavy, so generous timeouts and one worker (tests also share the port).
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
