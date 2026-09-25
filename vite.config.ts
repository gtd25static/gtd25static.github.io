import { defineConfig, type Plugin } from 'vite'
import { execSync } from 'child_process'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

function git(cmd: string): string {
  try { return execSync(cmd).toString().trim() } catch { return '' }
}

const gitCommit = git('git rev-parse --short HEAD')
// Commit subjects ship inside version.json, so a subject naming the secondary
// passphrase's cover would put a telltale word in the bundle (the e2e "shipped
// bundle names none of this" test): such subjects are left out.
const TELLTALE = /duress|decoy/i
const lastSubject = git('git log -1 --pretty=%s')
const gitMessage = TELLTALE.test(lastSubject) ? '' : lastSubject
// Recent commits as a mini changelog: {h: short hash, s: subject}.
const gitLog = git('git log -25 --pretty=%h%x09%s')
  .split('\n')
  .filter(Boolean)
  .map((line) => { const [h, ...rest] = line.split('\t'); return { h, s: rest.join('\t') } })
  .filter(({ s }) => !TELLTALE.test(s))

// Inject a Content-Security-Policy meta into the PRODUCTION index.html only (ACR-016).
// Applied at build time so it does not break Vite's dev server (HMR uses inline scripts
// + eval). GitHub Pages can't set HTTP headers, so a meta CSP is the deployable route;
// header-only directives (frame-ancestors) are intentionally omitted as they're ignored
// in meta. The app's only network egress is the GitHub REST API; styles are injected
// at runtime by Tailwind, hence 'unsafe-inline' for style-src.
// 'wasm-unsafe-eval' allows ONLY WebAssembly compilation (not JS eval) — required by
// hash-wasm's Argon2id vault KDF; without it every argon2 path (passphrase unlock of
// an upgraded vault, secondary-passphrase setup, duress unlock) throws in production.
function cspPlugin(): Plugin {
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    // No remote images anywhere in the app: the only <img> sources are blob: URLs
    // (shared-folder previews) and the bundled favicon. A blanket `https:` here
    // would leave an injected script a beacon to any host it likes.
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https://api.github.com",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
  return {
    name: 'gtd25-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '</title>',
        `</title>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
      )
    },
  }
}

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
    cspPlugin(),
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
        // Explicit app identity + scope. `id` spells out what was already the
        // default (the start_url), so declaring it can't re-identify an app that
        // is already installed; `scope` is the whole origin — this is a
        // user-site at the domain root, so every one of its URLs belongs to the
        // app. Both matter now that the manifest claims link handling below.
        id: '/',
        scope: '/',
        // Links to this origin belong in the app window, not a browser tab.
        // Chrome does not implement `handle_links` (it captures in-scope links
        // by default since 139 on desktop, opt-out per app); this is declared
        // for browsers that do, and it costs nothing where it is ignored.
        // Deliberately NO `launch_handler`: the Android share target is a POST
        // the service worker intercepts, and a `focus-existing`/`navigate-existing`
        // client mode could change whether that POST is delivered at all. Not
        // worth risking a working share flow for a nicer capture window.
        handle_links: 'preferred',
        // …but link capturing alone cannot serve the capture bookmarklet.
        // Chrome only captures navigations that create a new frame WITHOUT an
        // auxiliary browsing context, and `window.open` is exactly an auxiliary
        // context — so the bookmarklet always landed in a browser tab (verified
        // on Chrome desktop / Win11, 2026-07-27). A protocol handler is the
        // deterministic route: `web+gtd:` links launch the installed app,
        // whatever opened them. `%s` arrives percent-encoded and is parsed by
        // parseProtocolCapture (src/hooks/use-url-capture.ts), which sanitises
        // it exactly like the ?capture query it replaces.
        protocol_handlers: [
          { protocol: 'web+gtd', url: '/?protocol=%s' },
        ],
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        // POST/multipart so the OS share sheet can hand us FILES (a GET target can
        // only carry text/url). The service worker intercepts this POST, stashes the
        // payload, and redirects into the app, which asks where to file the share:
        // an Inbox task or the Shared Folder (a file's bytes always live in the
        // Shared Folder). See src/sw.ts + src/hooks/use-share-target.ts.
        share_target: {
          action: '/share-target',
          method: 'POST',
          enctype: 'multipart/form-data',
          params: {
            title: 'title',
            text: 'text',
            url: 'url',
            files: [
              { name: 'files', accept: ['*/*', 'image/*', 'video/*', 'audio/*', 'text/*', 'application/*'] },
            ],
          },
        },
      },
    }),
  ],
})
