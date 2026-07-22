# Architecture

## Overview

`gtd25` is a client-only Progressive Web App for personal task and follow-up management. It is deployed as a static site to GitHub Pages and uses **the user's own GitHub repository as its sync backend**. There is no Anthropic-, vendor-, or self-hosted server — every byte of business logic, storage, and sync runs in the browser.

High-level shape:

```
┌─────────────────────────────────────────────┐
│                  Browser                    │
│                                             │
│   React UI ──► Hooks ──► Dexie (IndexedDB)  │
│                  ▲           │              │
│                  │           ▼              │
│              Zustand     Sync Engine        │
│             (UI state)       │              │
│                              ▼              │
│                       AES-GCM encrypt       │
└──────────────────────────────┼──────────────┘
                               │ HTTPS + PAT
                               ▼
                ┌─────────────────────────────┐
                │  user's GitHub repo         │
                │   gtd25-snapshot.json       │
                │   gtd25-changelog.json      │
                │   gtd25-backup-*.json       │
                └─────────────────────────────┘
```

## Tech Stack

- **UI**: React 19 + TypeScript (strict)
- **Bundler**: Vite 7 (`tsc -b && vite build`)
- **Styling**: Tailwind CSS 4 (`@tailwindcss/vite`)
- **UI state**: Zustand 5 (transient, in-memory only)
- **Local persistence**: Dexie 4 over IndexedDB
- **Drag & drop**: @dnd-kit (core + sortable)
- **PWA**: vite-plugin-pwa + Workbox
- **Tests**: Vitest 4, Testing Library, fake-indexeddb
- **Hosting**: GitHub Pages, deployed via `.github/workflows/deploy.yml`

## Directory Layout

```
src/
├── components/        Feature-organized React components
│   ├── tasks/         TaskListView, TaskCard, InlineTaskForm, BulkActionBar
│   ├── follow-ups/    FollowUpCard and friends
│   ├── subtasks/      Inline subtask UI
│   ├── pomodoro/      Timer + sound presets
│   ├── settings/      Settings panes incl. backups & sync
│   ├── mindmaps/      Folder browser + SVG mindmap editor canvas
│   ├── layout/        AppShell, Sidebar, DndProvider
│   └── ui/            Reusable primitives (Button, Modal, ConfirmDialog…)
├── hooks/             Business logic exposed as React hooks
│   (use-tasks, use-subtasks, use-follow-ups, use-recurring,
│    use-search, use-trash, use-keyboard, use-mindmaps, …)
├── stores/            Zustand stores (app-state, pomodoro-store, mindmap-ui)
├── db/                Dexie schema, migrations, backup/export-import
├── sync/              GitHub backend — see dedicated section below
├── lib/               Pure utilities (id, date-utils, task-sort, link-utils)
└── __tests__/         Vitest tests (60+ files, mirroring src/ tree)
```

## Data Model

All persistent entities live in IndexedDB via Dexie. Definitions: `src/db/models.ts`.

- **TaskList** — container; `type: 'tasks' | 'follow-ups'`, ordering, soft-delete fields, `fieldTimestamps`.
- **Task** — title, description, links, `status: 'todo'|'done'|'blocked'|'working'`, due date, star, completion timestamps, follow-up ping fields, recurrence config, archived flag, `fieldTimestamps`.
- **Subtask** — same shape as Task but linked to a parent `taskId`. Nesting beyond one level is disallowed.
- **ChangeEntry** — append-only sync log: `{ id, deviceId, timestamp, entityType, entityId, operation: 'upsert'|'delete', data, v }`.
- **SyncMeta** — per-device sync bookkeeping (last pull/push, pending counts, remote SHAs).
- **LocalSettings** — credentials (`githubPat`, `githubRepo`), `deviceId`, `encryptionPassword`, `syncEnabled`. PAT/password live in IndexedDB locally; **never** sent anywhere except GitHub for the PAT, and **never** sent at all for the password (it's used purely for client-side key derivation).
- **PomodoroSettings**, **SoundPreset** — timer configuration and audio.
- **MindmapFolder / Mindmap / MindmapNode** — the Mindmaps section: nested
  folders, maps, and one row per node (`mapId`, optional `parentId` — absent on
  the map's single root — sibling `order`, `label` ≤ 1000 chars with a markdown
  subset). All three sync per-entity like tasks, so concurrent edits converge
  per node. Names/labels are encrypted; structure is plaintext for merging.
  Layout is computed, never stored (strict left-to-right auto-layout in
  `src/lib/mindmap-layout.ts`; tree building + anomaly absorption in
  `src/lib/mindmap-tree.ts`; markdown-outline interchange in
  `src/lib/mindmap-outline.ts`; hover/action-button geometry in
  `src/lib/mindmap-hover.ts` — hover is resolved from pointer coordinates, not
  DOM enter/leave, because the buttons float over tightly packed neighbours).

## State Management

Two layers, with a deliberate split:

- **Zustand (`src/stores/app-state.ts`)** — pure UI state: selected list, expanded task ids, modal toggles, bulk-selection set, focus targets. Synchronous, not persisted. (`src/stores/mindmap-ui.ts` is the one exception: per-map collapse state, mirrored to the `gtd25-mindmap-ui` localStorage key — device-local by design, never synced.)
- **Dexie (IndexedDB)** — every persistent entity, plus the change log and settings. Components read via `dexie-react-hooks` (`useLiveQuery`) so the UI auto-updates on writes.

Business logic lives in hooks (`src/hooks/use-*.ts`), not in components or stores. A component calls `useTasks().createTask(...)`, the hook writes to Dexie, the live query re-fires, the UI re-renders, and the sync engine eventually pushes the change.

---

## GitHub-as-Backend (the interesting part)

All sync code lives in `src/sync/`. The design goal is: **multi-device sync, offline-first, end-to-end encrypted, with no server to operate**. The user's own GitHub repository is the storage tier; the GitHub Contents API is the wire protocol.

### Files on the remote

Stored at the root of the user-configured repo:

| File | Purpose | Lifecycle |
|---|---|---|
| `gtd25-snapshot.json` | Full encrypted state — task lists, tasks, subtasks, settings, pomodoro config, sound presets. Holds the encryption salt and verifier. | Rewritten on compaction. |
| `gtd25-changelog.json` | Append-only array of `ChangeEntry` records (encrypted per-entry). | Appended on every push; reset to `[]` on compaction. |
| `gtd25-backup-hourly.json` / `-daily.json` / `-weekly.json` | Snapshot-format backups for point-in-time recovery. | Written after sync if the tier is stale; one file per tier. |
| `gtd25-snapshot-v{N}.backup.json` | Pre-migration snapshots, kept for rollback. | Written before a sync-version migration; pruned to ≤2. |

Constants: `SNAPSHOT_FILE` and `CHANGELOG_FILE` in `src/sync/sync-engine.ts:29-30`. Backup paths in `src/sync/remote-backups.ts:13-15`.

### Authentication

GitHub Personal Access Token, **fine-grained or classic**, with `contents: read/write` on the chosen repo. The token is stored in `LocalSettings.githubPat` (IndexedDB). It is sent only as a `Bearer` header to `api.github.com`. There is no OAuth flow because that would require a server.

### Wire format & encryption

End-to-end encryption is mandatory once the user enables sync. The server (GitHub) sees only ciphertext for any sensitive field.

- **Key derivation**: PBKDF2-HMAC-SHA256, **600,000 iterations**, 256-bit AES key. Salt is 16 random bytes generated on first sync and stored in the snapshot. (`src/sync/crypto.ts:4` — `PBKDF2_ITERATIONS = 600_000`.)
- **Cipher**: AES-GCM with a fresh 12-byte IV per encryption. Wire encoding is `base64(IV || ciphertext)`.
- **Per-field, not per-entity**: only sensitive fields (`title`, `description`, `link`, `linkTitle`, `links`) are encrypted into a single `_enc` blob on the entity. Identifiers, timestamps, status, ordering, and `fieldTimestamps` stay plaintext so the sync engine can reason about ordering and conflicts without decrypting.
- **Verifier**: the snapshot stores `encryptionVerifier`, an encryption of the constant `'gtd25-encryption-check'` (`src/sync/crypto.ts:5`). Wrong-password attempts are caught here before any data is decrypted or written.
- **Key cache**: derived key kept in memory only; cleared on logout, on tab hide (5 min), and on idle (30 min). Never written to localStorage.

### Sync flow (`syncNow()` in `src/sync/sync-engine.ts`)

1. **Lock** — single in-flight sync per device (AbortController, 45 s timeout).
2. **Fetch** — parallel GET of snapshot and changelog, each with their SHA.
3. **Resolve key** — derive from password + salt; verify against `encryptionVerifier`.
4. **Version gate** — refuse to sync if remote `syncVersion` exceeds the local `SYNC_VERSION` (currently `6`, see `src/sync/version.ts`). Older remote → migrate; newer → block with a user-visible toast asking them to update the app.
5. **Apply remote** — decrypt and replay the changelog into Dexie in timestamp order, then reconcile against the snapshot via field-level merge (see below).
6. **Push local** — read pending entries from the local change log, encrypt, append to remote changelog. Optimistic concurrency uses the file SHA on `PUT`; on 409 the engine refetches and retries (up to a few times with jittered backoff, `src/sync/sync-engine.ts:960`).
7. **Compact** — when the remote changelog exceeds **`MAX_CHANGELOG_ENTRIES = 500`** (`sync-engine.ts:33`), or on first-time encryption, fold it into the snapshot and reset the changelog to `[]`.
8. **Backups** — fire-and-forget; each tier writes only if its threshold has elapsed (`src/sync/remote-backups.ts`), with random jitter to keep multi-device fleets from stampeding the same file.

### Scheduler

Defined at the top of `sync-engine.ts`:

- `POLL_INTERVAL_MS = 30_000` — base background poll cadence.
- `BATCH_INTERVAL_MS = 30_000`, `FIRST_BATCH_SIZE = 5`, `BATCH_SIZE = 10` — after a local edit, the first batch flushes 5 changes quickly, subsequent batches flush 10 every 30 s.
- **Triggers**: page focus / `visibilitychange`, network online, manual button, and the poll timer.
- **Backoff on errors**: `30s → 60s → 120s → 240s → 300s` cap, exponential by `consecutiveErrors` (`sync-engine.ts:251-253`). Rate-limit responses (HTTP 403 with `X-RateLimit-Remaining: 0`) park the timer until the documented reset time.

### Conflict resolution

Conflicts are resolved **silently and deterministically** — there is no user-facing merge UI.

The mechanism is **field-level last-write-wins** (`src/sync/field-timestamps.ts`):

- Every entity carries `fieldTimestamps: Record<fieldName, epochMs>`, updated whenever the corresponding field is written locally.
- On merge, the engine walks the union of fields. For each field, it picks whichever side has the larger timestamp; ties go to **local** (the comparison is strict `remoteTs > localTs`, see `field-timestamps.ts:87`).
- Excluded from the per-field comparison: `id`, `createdAt`, `updatedAt`, and `fieldTimestamps` itself.
- **Fallback**: if either side lacks `fieldTimestamps` (e.g. legacy data, or a partial write), the engine falls back to entity-level LWW by `updatedAt`.

Practical consequence: if Device A renames a task at 14:00 and Device B edits its description at 14:05, both devices converge to A's title plus B's description — not whichever device synced last.

The append-only changelog plus timestamp-ordered replay gives **eventual consistency** without coordination: any two devices that have observed the same set of entries reach the same state.

### Soft deletes & auto-archive

- Deletes are soft: the engine sets `deletedAt` and lets the tombstone propagate. After **30 days** (`src/sync/conflict-resolution.ts:3`, `cleanupSoftDeletes`) tombstones are pruned from snapshots during compaction.
- Completed tasks older than 90 days are auto-archived during compaction so motivation stats and default views stay focused on recent work.

### Multi-device coordination

There is no leader, no lock service, and no presence channel. Coordination happens entirely through:

1. **GitHub's per-file SHA** as an optimistic-concurrency token (`If-Match` semantics on `PUT /contents`). A losing writer refetches and retries.
2. **Random jitter** before backup writes so two devices that wake up at the same moment don't both try to author the hourly file.
3. **The append-only changelog**, which makes concurrent pushes commutative as long as they don't both rewrite the same file.

### Limitations

- **Latency**: sync is polling-based; remote edits land on other devices in roughly 0–30 s under normal conditions, longer under backoff. Not suitable for collaborative real-time editing.
- **GitHub API rate limits**: 5,000 req/hour per PAT. A single device's normal usage is well under this, but pathological loops (rapid edits across many devices on the same repo) can hit it; the scheduler then parks until reset.
- **No atomic multi-file commit**: snapshot and changelog are independent files. The engine is written to tolerate partial states (e.g. snapshot updated but changelog write failed) on the next sync, but a torn state can briefly appear to a device that pulls between the two writes.
- **Password loss = data loss**: with E2EE there is no recovery path. Forgotten password ⇒ remote ciphertext is unrecoverable; the user must wipe and re-enable sync from a device that still has the local plaintext.
- **GitHub availability**: the app stays fully functional offline (Dexie + service worker), but cross-device sync halts whenever GitHub Contents API is degraded.
- **Repo size**: the snapshot scales linearly with the dataset and is rewritten on every compaction. Tens of thousands of tasks remain practical; hundreds of thousands would start to feel the snapshot rewrite cost.
- **Search is local-only**: encrypted fields can't be indexed server-side, so search runs against decrypted data in IndexedDB.
- **No conflict UI**: the "ties go local, otherwise newest field wins" rule is silent. Users who want explicit conflict resolution don't get it.
- **Single repo per device**: switching the configured repo means re-running the initial pull and key derivation; there is no notion of multiple connected backends.

---

## Drag & Drop

`src/components/layout/DndProvider.tsx` wraps the app in @dnd-kit's `DndContext`. Three flows are supported:

- Reorder tasks within a list (updates `order`).
- Move a task across lists via the sidebar (updates `listId`, with type compatibility checks for `tasks` vs `follow-ups`).
- Convert a task into a subtask by dropping it onto an expanded parent task (one level only — nesting is rejected).

A custom collision-detection function is used because the default `closestCenter` misses tall expanded subtask drop zones. Sensors are `PointerSensor` (5 px activation distance) plus `KeyboardSensor` for accessibility.

## Testing

Vitest with jsdom and `fake-indexeddb`. Setup: `vitest.config.ts`, `src/__tests__/setup-component.ts`. The sync layer is the most heavily covered area (resilience, scheduler, crypto, migrations) — see `src/sync/__tests__/`. Run `npm run test` (single pass) or `npm run test:watch`.

## Build & Deployment

- `npm run build` runs `tsc -b && vite build`, producing a static `dist/`.
- `.github/workflows/deploy.yml` runs on push to `main` and publishes `dist/` to GitHub Pages.
- The git commit hash is embedded into the bundle for in-app version display.
- `vite-plugin-pwa` configures the service worker and manifest. Workbox precaches built assets and serves `index.html` as the SPA fallback. The app is installable, and a Web Share Target maps to the `/capture` route.

## Security Posture

- E2EE on every sensitive field before it leaves the device (AES-GCM, 256-bit key from PBKDF2-600k).
- PAT scoped to `contents` only; stored locally, never echoed to the UI.
- URLs in user content are sanitized at render time to prevent stored XSS via task links.
- No analytics, telemetry, or third-party requests at runtime — only `api.github.com` and the static origin.
