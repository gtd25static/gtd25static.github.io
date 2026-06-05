import { defineConfig, type Plugin } from 'vite'
import { execSync } from 'child_process'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

function git(cmd: string): string {
  try { return execSync(cmd).toString().trim() } catch { return '' }
}

const gitCommit = git('git rev-parse --short HEAD')
const gitMessage = git('git log -1 --pretty=%s')
// Recent commits as a mini changelog: {h: short hash, s: subject}.
const gitLog = git('git log -25 --pretty=%h%x09%s')
  .split('\n')
  .filter(Boolean)
  .map((line) => { const [h, ...rest] = line.split('\t'); return { h, s: rest.join('\t') } })

// Emit a NON-precached version.json describing this build, so a running (older)
// client can fetch the live one and show what the pending update contains.
function versionJsonPlugin(): Plugin {
  return {
    name: 'gtd25-version-json',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({
          commit: gitCommit,
          message: gitMessage,
          builtAt: new Date().toISOString(),
          log: gitLog,
        }),
      })
    },
  }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0'),
    __GIT_COMMIT__: JSON.stringify(gitCommit),
  },
  plugins: [
    react(),
    tailwindcss(),
    versionJsonPlugin(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      includeAssets: [],
      injectManifest: {
        // Keep version.json out of the precache so the update check fetches the
        // LIVE file from the network (the new build's metadata), not a cached copy.
        globIgnores: ['**/version.json'],
      },
      manifest: {
        name: 'GTD25 - Task Manager',
        short_name: 'GTD25',
        description: 'Personal offline-first task manager',
        theme_color: '#6366f1',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        share_target: {
          action: '/capture',
          method: 'GET',
          params: {
            title: 'title',
            text: 'text',
            url: 'url',
          },
        },
      },
    }),
  ],
})
