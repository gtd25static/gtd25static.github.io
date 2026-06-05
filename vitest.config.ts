import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      // The PWA register module is a Vite virtual module only present when
      // vite-plugin-pwa runs; stub it for vitest.
      'virtual:pwa-register/react': fileURLToPath(new URL('./src/__tests__/stubs/pwa-register.ts', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/__tests__/**/*.test.{ts,tsx}'],
  },
});
