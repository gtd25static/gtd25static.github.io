# PWA Update Protocol: detect, inform, apply

**Status:** extracted from `gtd25`, a client-only PWA in production on Android (installed) and desktop Chrome.
**Audience:** engineers and coding agents building the "a new version is available → tap to update" flow in any PWA.
**Scope:** the update lifecycle only — service worker registration, detection, user prompt, activation, and version
visibility. Not caching strategy design, not offline data sync.

Getting a PWA to update reliably is deceptively hard. The naive implementation appears to work in development, works
in a desktop tab, and then fails in the installed app on a phone in ways that are nearly impossible to reproduce:
the banner loops forever, the button does nothing, the page reloads into the *same* old version, or the user simply
never learns that a fix shipped three weeks ago.

Every failure mode described here was hit in production and fixed. The fixes are small; finding them was not.

> **The single most important rule:** a PWA has **three independent caches** — the CDN/HTTP cache, the service
> worker's precache, and the running page itself. An update must traverse all three. Almost every update bug is one
> of them silently serving stale content while you debug the other two.

---

## Table of contents

1. [Why this is hard](#1-why-this-is-hard)
2. [Architecture](#2-architecture)
3. [Build-time requirements](#3-build-time-requirements)
4. [The visible version indicator (required)](#4-the-visible-version-indicator-required)
5. [Detection](#5-detection)
6. [The prompt](#6-the-prompt)
7. [Applying the update](#7-applying-the-update)
8. [Pitfalls — the complete catalogue](#8-pitfalls--the-complete-catalogue)
9. [Hosting and CDN constraints](#9-hosting-and-cdn-constraints)
10. [Testing](#10-testing)
11. [Emergency recovery](#11-emergency-recovery)
12. [Implementation checklist](#12-implementation-checklist)
13. [Porting notes](#13-porting-notes)

---

## 1. Why this is hard

### The service worker lifecycle, and the part everyone forgets

```
   ┌──────────┐    new bytes    ┌──────────┐   install ok   ┌──────────┐
   │  fetch   │ ──────────────► │ installing│ ─────────────►│ waiting  │
   │  sw.js   │  byte-different │           │               │          │
   └──────────┘                 └──────────┘               └────┬─────┘
                                                                 │
                            ┌────────────────────────────────────┘
                            │  ONLY when: all pages using the old SW are closed,
                            │  OR the waiting SW calls skipWaiting()
                            ▼
                      ┌───────────┐   controllerchange   ┌─────────────┐
                      │ activating│ ────────────────────►│  activated  │
                      └───────────┘                      └─────────────┘
```

**The waiting state is the whole problem.** A new service worker installs happily and then sits in `waiting`
indefinitely, because "all pages closed" almost never happens in an installed PWA — the user backgrounds it, they
don't close it. Without an explicit `skipWaiting()`, the user can have a new version downloaded and installed on their
device for weeks and never run it.

### Three caches, three failure points

| Layer | Holds | Invalidated by | Failure if stale |
|---|---|---|---|
| **CDN / HTTP cache** | `sw.js`, `index.html`, `version.json` | `Cache-Control` expiry, ETag revalidation | The browser fetches `sw.js` and gets the *old* bytes → no update is ever detected. |
| **Service worker precache** | all hashed build assets + `index.html` | a new SW activating | Navigation serves the old `index.html` → old JS bundle → old app, even after a hard reload. |
| **The running page** | the currently executing JS | a page reload | New SW is active but the user still sees the old code until reload. |

A "hard refresh" (Ctrl+Shift+R) bypasses only the first and third. **It does not bypass the service worker
precache.** This is why "I hard-refreshed and still see the old version" is the most common bug report, and why
telling users to hard-refresh is useless advice.

### Why `autoUpdate` is not the answer

Most PWA tooling offers an auto-update mode that reloads the page as soon as a new version activates. Do not use it
for anything but a trivial read-only app:

- It reloads **under the user**, mid-typing, mid-form, mid-scroll.
- It gives no opportunity to flush in-flight state.
- It offers no way to defer to a safe moment.
- It makes "what version am I running?" unanswerable, because it changes without notice.

Use prompt-based updates. The cost is the ~200 lines in this document; the benefit is that the user is never
surprised and never stuck.

---

## 2. Architecture

```
BUILD TIME                          RUNTIME (old client)                    RUNTIME (activation)
──────────                          ────────────────────                    ────────────────────
git rev-parse HEAD                  ┌──────────────────────┐
   │                                │ registration.update()│ ◄── visibility / focus
   ├─► __GIT_COMMIT__ ──► bundle    │  (debounced 10 min)  │ ◄── 30 min interval
   │      │                         └──────────┬───────────┘ ◄── after data sync
   │      └──► version indicator               │             ◄── manual button
   │           in the UI                       ▼
   │                                  browser fetches sw.js
   ├─► version.json  ◄────────────┐   byte-different? ──no──► done
   │   (NOT precached)            │        │ yes
   │   { commit, message,         │        ▼
   │     builtAt, log[] }         │   install → WAITING
   │                              │        │
   └─► sw.js + precache manifest  │        ▼
                                  │   needRefresh = true
                                  │        │
                                  └────────┤ fetch live version.json (cache-busted)
                                           ▼   → "you have abc123, update is def456, N commits"
                                     ┌─────────────┐
                                     │   PROMPT    │
                                     └──────┬──────┘
                                            │ user taps "Update now"
                                            ▼
                                  postMessage({type:'SKIP_WAITING'})
                                            │
                                            ▼
                                  SW activates → clientsClaim()
                                            │
                                            ▼
                                   controllerchange → reload ONCE
```

**Component inventory:**

| Piece | Responsibility |
|---|---|
| Build plugin: version stamp | Bakes the commit hash into the bundle as a compile-time constant. |
| Build plugin: `version.json` | Emits build metadata **excluded from the precache**. |
| Service worker | Precaches assets, serves navigations, handles the `SKIP_WAITING` message. |
| Registration hook | Owns the registration, schedules checks, exposes `needRefresh` + `applyUpdate`. |
| Update prompt | Shows what's changing, lets the user apply or defer. |
| Version indicator | Always-visible short commit hash in the UI. |

---

## 3. Build-time requirements

### 3.1 Bake the commit hash into the bundle

```js
// vite.config.ts (equivalent exists for webpack DefinePlugin, esbuild define, etc.)
import { execSync } from 'child_process'

function git(cmd) { try { return execSync(cmd).toString().trim() } catch { return '' } }

const gitCommit  = git('git rev-parse --short HEAD')
const gitMessage = git('git log -1 --pretty=%s')
const gitLog     = git('git log -25 --pretty=%h%x09%s')
  .split('\n').filter(Boolean)
  .map(line => { const [h, ...rest] = line.split('\t'); return { h, s: rest.join('\t') } })

export default defineConfig({
  define: {
    __GIT_COMMIT__: JSON.stringify(gitCommit),
    __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0'),
  },
})
```

Consume it behind a guard so tests and dev builds don't crash:

```ts
declare const __GIT_COMMIT__: string
export const GIT_COMMIT: string =
  typeof __GIT_COMMIT__ !== 'undefined' ? __GIT_COMMIT__ : 'dev'
```

This constant is **frozen at build time**. That is precisely what makes it useful: the running bundle can compare
its own identity against what the server currently offers.

### 3.2 Emit `version.json` — and keep it OUT of the precache

```js
function versionJsonPlugin() {
  return {
    name: 'version-json',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({
          commit: gitCommit,      // what the NEW build is
          message: gitMessage,    // its headline
          builtAt: new Date().toISOString(),
          log: gitLog,            // recent {h, s} for a real changelog
        }),
      })
    },
  }
}
```

```js
VitePWA({
  strategies: 'injectManifest',
  srcDir: 'src',
  filename: 'sw.ts',
  registerType: 'prompt',          // ← never 'autoUpdate'
  injectManifest: {
    globIgnores: ['**/version.json'],   // ← CRITICAL
  },
})
```

> **If `version.json` is precached, the running client fetches its own stale copy and every update looks like
> "no changes".** It must come from the network so an *old* client can read the *new* build's metadata. This is the
> one file in the whole app that must never be cached by the service worker.

### 3.3 CI must fetch enough git history

This one bit us and is invisible until you look at the deployed artifact.

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0        # ← REQUIRED. Default is 1 (shallow, single commit).
```

`actions/checkout` defaults to a **shallow clone of one commit**. `git log -25` then returns exactly one line, so
`version.json` ships with a single-entry log and the update prompt can only ever say "1 new commit" — no matter how
many shipped. The changelog silently degrades to the headline, and because the fallback path is sensible, nothing
appears broken.

**Verify after deploying:**

```bash
curl -s https://your.app/version.json | jq '.commit, (.log | length)'
# log length should be your configured depth (e.g. 25), not 1
```

### 3.4 Service worker source

```ts
/// <reference lib="webworker" />
import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { clientsClaim } from 'workbox-core'

declare let self: ServiceWorkerGlobalScope

// Lifecycle diagnostics — these cost nothing and are the only window you get
// into a device you cannot attach a debugger to.
console.debug('[SW] script evaluated at', new Date().toISOString())
self.addEventListener('install',  () => console.debug('[SW] install fired'))
self.addEventListener('activate', () => console.debug('[SW] activate fired'))

// Message-driven activation. NOT self.skipWaiting() at module scope — see §8.1.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting())     // waitUntil: keeps the SW alive for it
  }
})

clientsClaim()                              // take control of open pages on activation
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()                     // drop precaches from previous versions
registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')))
```

Four details that matter:

- **`clientsClaim()`** makes the newly activated worker take control of already-open pages. Without it, activation
  happens but the page keeps talking to the old worker until a navigation, and `controllerchange` never fires — so
  your reload trigger never runs.
- **`cleanupOutdatedCaches()`** deletes precaches from earlier versions. Without it, storage grows with every deploy
  until the origin hits its quota and *writes start failing* — which manifests as random data-loss bugs, not as an
  update bug.
- **`event.waitUntil(self.skipWaiting())`** keeps the worker alive while activation proceeds. A bare
  `self.skipWaiting()` can be killed mid-flight when the browser decides the worker is idle.
- **The navigation route serves precached `index.html` for every navigation.** This is what makes the app work
  offline, *and* it is exactly why a hard refresh cannot bypass a stale build.

---

## 4. The visible version indicator (required)

**Every PWA must display its running build identifier somewhere always reachable.** This is not a nice-to-have; it
is the only way anyone — user, support, or you — can answer the question the whole update flow exists to serve.

### Why it is non-negotiable

1. **Users get silently stuck.** The most dangerous update failure is the *silent* one: the SW never updates, no
   prompt ever appears, and the user runs a months-old build believing they are current. Nothing in the UI
   contradicts them. A visible hash lets them notice.
2. **Bug reports become actionable.** "It's broken" versus "It's broken on `4d67bcc`" is the difference between a
   day of guessing and a two-minute `git log`. You will otherwise debug against `main` while the user runs something
   from six weeks ago.
3. **It verifies the update actually happened.** After tapping "Update now", the hash changing is the user's proof.
   If it did not change, the update failed — and you have found a real bug instead of assuming success.
4. **It makes staleness self-diagnosable.** A user can compare the displayed hash against the project's commit list.

### What to display

```tsx
// Minimal: short hash in the sidebar/header, under the app name
<div className="flex flex-col">
  <span className="text-[22px] leading-tight">MyApp</span>
  <span className="text-[10px] font-mono text-zinc-400">{GIT_COMMIT}</span>
</div>
```

| Requirement | Rule |
|---|---|
| **Content** | Short commit hash (7 chars). It is unambiguous, greppable, and maps to exactly one build. |
| **Placement** | Header, sidebar footer, or an "About" row — reachable in ≤1 interaction from the main screen. |
| **Not behind a menu** | If it takes three taps, no bug report will ever include it. |
| **Monospace, muted** | Present but not shouting. It is diagnostics, not chrome. |
| **Present when the app is degraded** | If your app has a locked/error/offline state, show the version *there too*. Those are exactly the states people report from. |

### Do not use a semver number alone

`v1.4.2` in `package.json` is bumped by a human, and humans forget. Two different builds can carry the same version
string, which makes it useless as a build identifier. The commit hash cannot lie: it is generated from the tree
being built. Show semver if your users care about it, but **always alongside the hash**.

### Extend it into diagnostics

```ts
export function buildInfo() {
  return { version: APP_VERSION, commit: GIT_COMMIT }
}
```

Attach this to every error report, diagnostics export, and support bundle. An error log without a build identifier
is an error log you cannot act on.

### Optionally: show both hashes when an update is pending

```
Current commit 4d67bcc          ← running
4d67bcc → eb1f5c1               ← running → available
```

This turns the prompt from "something is available" into "here is exactly what you're moving to", and it makes a
same-commit signal (§8.3) immediately obvious rather than mysterious.

---

## 5. Detection

### The registration hook

```ts
const UPDATE_INTERVAL_MS   = 30 * 60 * 1000  // periodic check
const MIN_UPDATE_CHECK_MS  = 10 * 60 * 1000  // debounce for automatic triggers
const RELOAD_FALLBACK_MS   = 12_000          // only if controllerchange never fires

function useServiceWorker() {
  const registrationRef = useRef<ServiceWorkerRegistration>()
  const lastCheckRef = useRef(0)

  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW({
    onRegisteredSW(_url, registration) { registrationRef.current = registration },
  })

  // Debounced — for automatic triggers that can fire in bursts.
  const checkForUpdate = useCallback(() => {
    const now = Date.now()
    if (now - lastCheckRef.current < MIN_UPDATE_CHECK_MS) return
    lastCheckRef.current = now
    registrationRef.current?.update()
  }, [])

  // Immediate — for a user pressing a button. Never make a user wait out a debounce.
  const forceCheck = useCallback(() => {
    lastCheckRef.current = Date.now()
    registrationRef.current?.update()
  }, [])

  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') checkForUpdate() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', checkForUpdate)   // covers standalone PWA restore
    const interval = setInterval(checkForUpdate, UPDATE_INTERVAL_MS)
    return () => { /* remove all three */ }
  }, [checkForUpdate])

  return { needRefresh, applyUpdate, checkForUpdate, forceCheck }
}
```

### When to check

| Trigger | Debounced? | Rationale |
|---|---|---|
| `visibilitychange` → visible | yes | The dominant trigger. Users background and restore a PWA constantly. |
| `window.focus` | yes | Catches standalone-PWA restore where `visibilitychange` is unreliable. |
| Every 30 min | yes | Backstop for a session left open all day. |
| After a successful data sync | yes | The client is provably online right now — free, well-timed check. |
| User taps "Check for updates" | **no** | Never make a human wait out a debounce. |
| App reports a server/protocol incompatibility | **no** | An update is *required*; check immediately. |

**Debouncing is mandatory.** `registration.update()` on every `visibilitychange` with no throttle produces a network
request per tab switch. On mobile that is constant, and it will churn install/activate cycles.

### Mount the registration at the very top of the tree

```tsx
<ErrorBoundary>
  <ServiceWorkerProvider>        {/* ← always mounted, outside every gate */}
    <AppUpdatePrompt />
    {locked ? <LockScreen /> : <MainApp />}
  </ServiceWorkerProvider>
</ErrorBoundary>
```

**This is the highest-value structural decision in the whole design.** If update detection lives inside your
authenticated/unlocked/loaded shell, then a build that crashes *before* that shell mounts is unrecoverable — the user
cannot update out of a broken build because the broken build is what would have offered the update. Their only
remaining option is clearing site data, which destroys local data.

Put the SW provider and the prompt above every gate: auth, lock screen, onboarding, error boundary fallback. A user
stuck on a broken build must always be able to pull the fix.

### Fetch the live `version.json`

```ts
useEffect(() => {
  if (!needRefresh && !updateRequired) return
  let active = true
  fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`, { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
    .then(j => { const v = parseVersionInfo(j); if (active && v) setInfo(v) })
    .catch(() => { /* changelog is optional — never block the update on it */ })
    .finally(() => { if (active) setVersionChecked(true) })
  return () => { active = false }
}, [needRefresh, updateRequired])
```

Four requirements, each learned the hard way:

1. **Cache-bust with a query param AND `cache: 'no-store'`.** The query param defeats CDN edge caches you do not
   control (§9); `no-store` defeats the browser's. You need both.
2. **`BASE_URL`-relative, never absolute.** An absolute `/version.json` breaks the moment the app is served from a
   sub-path (project pages, staging directories, previews).
3. **Validate the payload.** It arrives from the network and may be a stale artifact, an HTML error page, or a
   half-written file. Reject anything without a `commit` string; drop malformed log entries individually.
4. **Never block the update on it.** If the fetch fails, the user still gets a working "Update now" button — just
   without a changelog.

```ts
export function parseVersionInfo(j: unknown): VersionInfo | null {
  if (!j || typeof j !== 'object') return null
  const o = j as Record<string, unknown>
  if (typeof o.commit !== 'string' || !o.commit) return null      // hard requirement
  const log = Array.isArray(o.log)
    ? o.log.filter((c): c is {h:string;s:string} =>
        !!c && typeof c === 'object'
        && typeof (c as any).h === 'string' && typeof (c as any).s === 'string')
    : undefined
  return { commit: o.commit, message: typeof o.message === 'string' ? o.message : '', log }
}
```

### Compute the changelog

```ts
/** Commits in the incoming build newer than the running one. */
export function changelogFor(info: VersionInfo, current: string) {
  if (info.log?.length) {
    const fresh = []
    for (const c of info.log) {
      if (c.h === current) return fresh        // reached our commit — stop
      fresh.push(c)
    }
    if (fresh.length) return fresh             // current outside the window — show what we have
  }
  return info.message ? [{ h: info.commit, s: info.message }] : []
}
```

Walking the log until the running commit is reached gives the user "here is what you are about to get", which is
far more meaningful than a version number. Both fallbacks matter: a user who skipped more commits than your log
window still sees something, and a build without a log still shows its headline.

---

## 6. The prompt

### State machine

```
   needRefresh = true  OR  update required by protocol
              │
              ▼
      fetch version.json ───► same commit as running? ──yes──► SUPPRESS (§8.3)
              │                                                     
              ▼ different / unknown
        ┌───────────────┐  "Later"   ┌──────────────────────┐
        │ MODAL DIALOG  │ ─────────► │ THIN TOP BANNER      │
        │ + changelog   │            │ (stays available)    │
        └───────┬───────┘            └──────────┬───────────┘
                │ "Update now"                  │ "Update now"
                └───────────────┬───────────────┘
                                ▼
                     ┌──────────────────────┐
                     │ can apply right now? │
                     └───┬──────────────┬───┘
                    yes  │              │  no (unsafe state)
                         ▼              ▼
                   applyUpdate()   defer until safe, then apply
```

**Dialog first, banner as fallback.** A modal is intrusive by design — updates matter, especially when they carry
fixes. But a modal the user cannot escape is hostile, so "Later" demotes it to a persistent thin banner that stays
available without blocking anything. The user is nudged once, then trusted.

### Show the diff, not just the fact

```tsx
<p className="font-mono text-[11px] text-zinc-400">
  {sameCommit ? `Current commit ${GIT_COMMIT}` : `${GIT_COMMIT} → ${info.commit}`}
</p>
{changes.length > 0 && (
  <ul>{changes.map(c => (
    <li key={c.h}><span className="font-mono text-zinc-400">{c.h}</span> {c.s}</li>
  ))}</ul>
)}
```

Users update far more readily when they can see what they are getting. "A new version is available" is ignorable;
"fixes the crash when opening attachments" is not.

### Deferring to a safe moment

If your app has states where reloading is destructive or awkward — an unlocked encrypted vault, an in-progress
upload, an unsaved editor — offer to defer instead of forcing a choice between "lose work" and "stay stale":

```tsx
const deferUpdate = vault.enabled && vault.unlocked

// "Update when locked" instead of "Update now"
if (deferUpdate) { setDeferUntilLocked(true); setDismissed(true); return }

useEffect(() => {
  if (deferUntilLocked && vault.locked && !updating) {
    setUpdating(true)
    applyUpdate()
  }
}, [deferUntilLocked, vault.locked, updating, applyUpdate])
```

Then **confirm afterwards**. An update that applied silently while the user was away is indistinguishable from an
app that reset itself. Leave a breadcrumb across the reload:

```ts
// Before reloading: record what we're leaving.
localStorage.setItem(NOTICE_KEY, JSON.stringify({ from: GIT_COMMIT, to: info?.commit, at: Date.now() }))

// After reload: show a confirmation only if the commit actually changed, and
// only if the note is recent (TTL) — a stale note must never resurface.
function readCompletedNotice(): boolean {
  const raw = localStorage.getItem(NOTICE_KEY); if (!raw) return false
  let n; try { n = JSON.parse(raw) } catch { localStorage.removeItem(NOTICE_KEY); return false }
  if (typeof n.from !== 'string' || typeof n.at !== 'number') { localStorage.removeItem(NOTICE_KEY); return false }
  if (Date.now() - n.at > TTL_MS)  { localStorage.removeItem(NOTICE_KEY); return false }
  if (n.from === GIT_COMMIT)       return false          // ← we did NOT actually move
  localStorage.removeItem(NOTICE_KEY); return true
}
```

The `n.from === GIT_COMMIT` check is the important line: if the running commit is still the one we recorded leaving,
the update did **not** happen, and claiming success would be a lie.

### Make the prompt actually visible

Native `<dialog open>` elements render in the browser's **top layer**, above every `z-index`. If your prompt is a
regular positioned `div`, any open modal — settings, a confirmation, a picker — will cover it completely, and the
user will never see that an update exists.

```ts
useEffect(() => {
  if (!promptVisible) return
  const closeOpenDialogs = () => {
    document.querySelectorAll('dialog[open]').forEach(d => {
      try { (d as HTMLDialogElement).close() } catch {}
    })
  }
  closeOpenDialogs()
  // An observer, not a one-shot sweep: dialogs can open AFTER the prompt appears
  // (a timer-driven notification, a deferred prompt).
  const observer = new MutationObserver(closeOpenDialogs)
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] })
  return () => observer.disconnect()
}, [promptVisible])
```

Calling `.close()` (rather than hiding the element) fires each dialog's `close` event, so React state stays
consistent and they do not immediately re-open. Overlays that must survive alongside the prompt — a lock screen, a
credential gate — should be plain `div`s layered by `z-index` rather than native dialogs.

---

## 7. Applying the update

```ts
// Module-level, NOT component state: survives re-renders and remounts.
let reloadArmed = false
function reloadOnce() {
  if (reloadArmed) return
  reloadArmed = true
  try { window.location.reload() } catch {}
}

const applyUpdate = useCallback(() => {
  if (reloadArmed) return
  updateServiceWorker(true)                 // posts SKIP_WAITING, reloads on controllerchange
  setTimeout(reloadOnce, RELOAD_FALLBACK_MS) // 12s — ONLY if controllerchange never fires
}, [updateServiceWorker])
```

The sequence:

1. `updateServiceWorker(true)` posts `{type:'SKIP_WAITING'}` to the waiting worker.
2. The worker calls `self.skipWaiting()` → it activates.
3. `clientsClaim()` makes it take control of the open page.
4. The browser fires `controllerchange` on the page.
5. The library's `controllerchange` listener reloads.

### The two rules that make this reliable

**Rule 1 — reload at most once per page life, via a module-level guard.**

Two independent things can reload the page: the library's `controllerchange` handler and your fallback timer. If both
fire, or if the guard lives in component state and the component remounts, you get a reload loop. The flag must be
module-scoped so it survives every remount.

**Rule 2 — the fallback timer must be LONG (10–15 s), never short.**

This is the fix for a real, reproducible Safari failure:

> An earlier implementation force-reloaded after **2 seconds** *and* let the library reload on `controllerchange`.
> The two raced. On Safari the 2-second reload interrupted `skipWaiting`/activation before the new worker could take
> control — leaving it stuck in `waiting` forever. The page came back on the **old** build, immediately detected the
> same waiting worker, and showed the banner again. The user tapped "Update now" repeatedly, forever, and nothing
> ever changed.

The fallback exists solely for environments where `controllerchange` genuinely never fires (some standalone PWA
contexts). It must be long enough that normal activation always wins the race. 12 seconds is comfortable; anything
under 5 is dangerous.

---

## 8. Pitfalls — the complete catalogue

### 8.1 `self.skipWaiting()` at module scope defeats prompt mode

```ts
// ❌ WRONG for registerType: 'prompt'
self.skipWaiting()   // top-level in the SW

// ✅ RIGHT — activate only when the user asks
self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') e.waitUntil(self.skipWaiting())
})
```

**Symptom:** the prompt never appears, or appears and is immediately irrelevant; install/activate cycles churn on
every update check.

**Cause:** a module-scope `skipWaiting()` activates the new worker the instant it installs, bypassing the entire
prompt workflow. The user gets a silent, unannounced swap — the `autoUpdate` behaviour you deliberately avoided,
smuggled in by one line in the wrong place.

This is the single most common mismatch, because most SW examples on the internet are written for auto-update.

### 8.2 `version.json` in the precache

**Symptom:** the update prompt always says "no changes available", or shows the version the user is already running.

**Cause:** the running client fetches its own precached copy of `version.json` — which describes *itself*.

**Fix:** `globIgnores: ['**/version.json']`, plus `cache: 'no-store'` and a cache-busting query param on the fetch.

### 8.3 The same-commit refresh loop

**Symptom:** the update banner appears, the user updates, and after reload it appears again. Forever.

**Cause:** the service worker can report a waiting worker for a build that is byte-different but commit-identical
(a rebuild of the same commit, a redeploy, an asset hash shift). `needRefresh` is true but there is genuinely
nothing new, so updating changes nothing and the signal returns.

**Fix:** treat a same-commit signal as stale and suppress the prompt:

```ts
const sameCommit = info?.commit === GIT_COMMIT
const staleSignal = needRefresh && !updateRequired && versionChecked
                    && sameCommit && changes.length === 0
const available = (needRefresh || updateRequired) && !staleSignal
```

Note `versionChecked`: **wait for the version fetch to resolve before deciding.** Rendering the prompt while the
fetch is in flight makes it flash on screen and then vanish, which looks broken.

### 8.4 Hard refresh does not bypass the service worker

**Symptom:** "I cleared my cache and hard-refreshed and I still see the old version."

**Cause:** the navigation route serves precached `index.html`. A hard refresh bypasses the HTTP cache; it does not
bypass the service worker.

**Fix:** there is no user-side fix — this is why the in-app update flow must work. Never ship "try a hard refresh"
as support advice; it does not work and it erodes trust. See §11 for genuine recovery.

### 8.5 Shallow CI clone truncates the changelog

Covered in §3.3. `fetch-depth: 0`. Verify with `curl … | jq '.log | length'` after deploying.

### 8.6 The reload race (Safari infinite loop)

Covered in §7. Long fallback + module-level single-reload guard.

### 8.7 The prompt hidden behind a native dialog

Covered in §6. Top-layer `<dialog>` beats any `z-index`.

### 8.8 Update detection gated behind app state

Covered in §5. If a build crashes before your app shell mounts and the SW provider mounts inside that shell, the user
cannot update out of the broken build. Mount it above every gate.

### 8.9 Stale closures in the check callback

```ts
// ❌ the timeout captures needRefresh from the render it was created in
setTimeout(() => { if (!needRefresh) toast('You are up to date') }, 4000)

// ✅ read the current value through a ref
const needRefreshRef = useRef(needRefresh)
useEffect(() => { needRefreshRef.current = needRefresh }, [needRefresh])
setTimeout(() => { if (!needRefreshRef.current) toast('You are up to date') }, 4000)
```

**Symptom:** "Check for updates" reports "you're up to date" *while* the update dialog is on screen.

### 8.10 Unbounded precache growth

Without `cleanupOutdatedCaches()`, every deploy leaves its full precache behind. After enough deploys the origin
approaches its storage quota, and the failure does not look like an update bug — it looks like **IndexedDB writes
failing at random**. Always call it.

### 8.11 The dev server has no service worker

Your entire update flow is untestable in `npm run dev`. Every SW behaviour — precaching, waiting, activation,
navigation fallback — only exists in a production build.

```bash
npm run build && npx vite preview
```

**Test the update flow against the built bundle, and ideally against the real deployment.** A dev-only test suite
cannot see a service worker bug, a CSP bug, or a precache bug. (We lost six weeks to a production-only CSP failure
that dev could not have caught.)

### 8.12 Testing needs the virtual module stubbed

`virtual:pwa-register/react` does not exist under a test runner. Stub it, and make the hook degrade gracefully:

```ts
const NOOP_SW: ServiceWorkerApi = {
  needRefresh: false, applyUpdate: () => {}, checkForUpdate: () => {}, forceCheck: () => {},
}
export function useServiceWorker() {
  return useContext(ServiceWorkerContext) ?? NOOP_SW   // no provider → no crash
}
```

Any component can then be unit-rendered without the provider.

### 8.13 Absolute paths break sub-path deployments

`fetch('/version.json')` works on `app.example.com` and breaks on `example.github.io/app/`. Always use the
bundler's configured base URL.

### 8.14 A user-initiated check needs feedback either way

If the user taps "Check for updates" and there is no update, **say so**. Silence reads as a broken button.

```ts
function handleClick() {
  setChecking(true)
  forceCheck()
  setTimeout(() => {
    setChecking(false)
    if (!needRefreshRef.current) toast('You are on the latest version')
  }, DETECT_WINDOW_MS)   // ~4s — enough for install to surface a waiting worker
}
```

If an update *is* found, the always-mounted prompt takes over and the toast is correctly suppressed.

---

## 9. Hosting and CDN constraints

The service worker is fetched over HTTP like any other file, so **your CDN's cache policy bounds how fast an update
can possibly be detected.**

### Browser behaviour

- `updateViaCache` defaults to `'imports'`: the browser bypasses **its own** HTTP cache for the top-level SW script.
- Independently, the spec requires bypassing the HTTP cache when the cached SW script is older than 24 hours.

Neither of these has any effect on a **CDN edge cache**, which sits between the browser and your origin.

### Measured example — GitHub Pages

```
$ curl -sI https://your.app/sw.js | grep -i cache-control
cache-control: max-age=600
```

GitHub Pages serves everything with `max-age=600` and provides **no way to set custom headers**. Consequences:

- A new `sw.js` may not be visible for up to 10 minutes after deploy. Your update-check interval cannot beat this.
- `version.json` has the same ceiling — hence the mandatory `?t=${Date.now()}` cache-buster, which produces a
  distinct URL the edge has not cached.

### Recommended headers where you control them

| File | `Cache-Control` | Why |
|---|---|---|
| `sw.js` | `no-cache` (revalidate every time) | The update entry point. Any staleness here delays every update. |
| `index.html` | `no-cache` | The bootstrap document. |
| `version.json` | `no-cache, no-store` | Must always be live. |
| Hashed assets (`*.[hash].js/css`) | `public, max-age=31536000, immutable` | Content-addressed — safe to cache forever. |

**If you cannot set headers** (GitHub Pages, some static hosts): cache-bust every must-be-fresh fetch with a query
parameter, and accept that update *detection* is delayed by the host's `max-age`. Document the delay so it is not
mistaken for a bug. It does not affect correctness — only latency.

---

## 10. Testing

### Unit-testable (do these)

- `changelogFor()`: stops at the current commit; falls back when current is outside the window; falls back to the
  headline when there is no log.
- `parseVersionInfo()`: rejects `null`/non-objects/missing commit; drops individual malformed log entries; defaults
  a missing message.
- The prompt component: renders the dialog with a changelog; "Update now" calls `applyUpdate`; "Later" demotes to
  the banner; renders nothing when there is no update; shows "Update required" for a protocol-mandated update.
- Dialog suppression: closes an already-open dialog; closes one that opens later; fires the `close` event so React
  state stays consistent; leaves dialogs alone once demoted to the banner.
- The completed-update notice: suppressed when the commit did not change; expires after its TTL; survives malformed
  JSON without throwing.

### Requires a real browser (do these too)

| Scenario | How |
|---|---|
| Update detected and applied | Build + serve, load, deploy a new build, trigger a check, confirm the prompt and that the hash changes after applying. |
| No reload loop | Apply an update and watch the SW state in DevTools → Application → Service Workers. The old worker must reach `redundant`, not stay `waiting`. |
| Installed-PWA path | Install to the home screen and repeat. Standalone contexts behave differently from tabs — this is where Safari's race appeared. |
| Offline resilience | Go offline, trigger a check: it must fail silently, never break the app or show a false prompt. |
| Deployed `version.json` | `curl -s https://your.app/version.json \| jq '.commit, (.log \| length)'` after every pipeline change. |

### Manual verification script after any change to this flow

1. Note the hash shown in the UI.
2. Deploy a new commit.
3. Background and restore the app (or tap "Check for updates").
4. Prompt appears, listing the new commits.
5. Tap "Update now".
6. App reloads **once**.
7. **The displayed hash now matches the new commit.** ← the assertion that matters
8. No prompt reappears.

Step 7 is why §4 is mandatory: without a visible version, steps 1–8 are unverifiable and you are guessing.

---

## 11. Emergency recovery

When a user is genuinely stuck on a broken build, in escalating order:

1. **In-app update** — works if the app renders at all. This is why the prompt mounts above every gate (§5).
2. **Close every tab/window of the app, then reopen.** A waiting worker activates naturally when all clients are
   gone. On an installed PWA this means fully dismissing it from the app switcher, not just backgrounding it.
3. **DevTools → Application → Service Workers → Unregister, then reload.** Desktop only.
4. **Clear site data.** Last resort — *this destroys local data*. If your app stores anything locally, warn
   explicitly and offer an export first.

**Design so that step 1 always works.** If the update prompt only renders inside a shell that a broken build cannot
mount, you have shipped a build that can only be escaped by data loss. The mitigation is structural (mount high), not
procedural.

Also consider: if your app talks to a backend with a version handshake, let a protocol-incompatibility response
**force an immediate SW check** and present the update as required rather than optional. That turns "the app
mysteriously stopped syncing" into "update to continue".

---

## 12. Implementation checklist

**Build**
- [ ] Commit hash baked into the bundle as a compile-time constant, with a `'dev'` fallback.
- [ ] `version.json` emitted with `{ commit, message, builtAt, log[] }`.
- [ ] `version.json` **excluded from the precache**.
- [ ] `registerType: 'prompt'` (never `autoUpdate`).
- [ ] CI checkout uses `fetch-depth: 0` — **verified against the deployed artifact**.

**Service worker**
- [ ] `SKIP_WAITING` message handler wrapped in `event.waitUntil()`.
- [ ] **No** module-scope `self.skipWaiting()`.
- [ ] `clientsClaim()`.
- [ ] `cleanupOutdatedCaches()`.
- [ ] Navigation route bound to precached `index.html`.
- [ ] `install`/`activate`/script-eval diagnostics logged.

**Detection**
- [ ] Registration mounted **above every app gate** (auth, lock, onboarding, error boundary).
- [ ] Debounced check (~10 min) on visibility, focus, and a ~30 min interval.
- [ ] Non-debounced `forceCheck()` for user-initiated checks and required updates.
- [ ] `version.json` fetched cache-busted, base-URL-relative, validated, non-blocking.

**Prompt**
- [ ] Modal dialog with a real changelog; "Later" → persistent banner.
- [ ] Running → available commit hashes displayed.
- [ ] Same-commit signals suppressed (after the version check resolves).
- [ ] Open native `<dialog>`s closed via `MutationObserver` while the prompt is visible.
- [ ] Deferral path for unsafe states, with a post-update confirmation guarded on the commit actually changing.

**Apply**
- [ ] Module-level `reloadArmed` guard — at most one reload per page life.
- [ ] Fallback reload timer ≥ 10 s (never a short one).
- [ ] `updateServiceWorker(true)` is the primary path.

**Version visibility**
- [ ] Short commit hash rendered in a persistent, ≤1-tap-away location.
- [ ] Also rendered in degraded states (lock screen, error boundary, offline view).
- [ ] Included in diagnostics/error reports/support bundles.

---

## 13. Porting notes

| Concern | This implementation | Elsewhere |
|---|---|---|
| Build constant | Vite `define` | webpack `DefinePlugin`, esbuild `define`, Rollup `@rollup/plugin-replace` |
| SW generation | `vite-plugin-pwa` (`injectManifest`) | Workbox CLI / `workbox-webpack-plugin` / hand-written SW |
| Registration API | `useRegisterSW` (React) | `navigator.serviceWorker.register()` directly — see below |
| Framework | React hooks + context | Any: the logic is framework-independent |

Without a library, the registration primitives are:

```js
const reg = await navigator.serviceWorker.register('/sw.js')

reg.addEventListener('updatefound', () => {
  const installing = reg.installing
  installing.addEventListener('statechange', () => {
    if (installing.state === 'installed' && navigator.serviceWorker.controller) {
      showUpdatePrompt()          // a NEW worker installed while one was already controlling
    }
  })
})

navigator.serviceWorker.addEventListener('controllerchange', () => reloadOnce())

function applyUpdate() {
  reg.waiting?.postMessage({ type: 'SKIP_WAITING' })
  setTimeout(reloadOnce, 12_000)
}
```

The `navigator.serviceWorker.controller` check in `updatefound` is essential: without it you show an "update
available" prompt on the very first visit, when the *first* worker installs and there is nothing to update from.

**What does not change across ports:** the waiting-state problem, the three-cache model, message-driven
`skipWaiting`, the single-reload guard, the long fallback timer, excluding `version.json` from the precache, the
same-commit suppression, mounting detection above every gate, and displaying the commit hash. Those are the
protocol. Everything else is plumbing.

---

*Extracted from the `gtd25` implementation: `vite.config.ts`, `src/sw.ts`, `src/hooks/use-service-worker.tsx`,
`src/components/banners/AppUpdatePrompt.tsx`, `src/components/layout/CheckForUpdatesButton.tsx`,
`src/lib/changelog.ts`. Where this document and the code disagree, the code is right and this document should be
corrected.*
