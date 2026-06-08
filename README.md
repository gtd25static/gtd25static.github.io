# GTD25

GTD25 is an offline-first personal task and follow-up Progressive Web App. It runs entirely in the browser, stores data locally in IndexedDB, and can sync across devices through a GitHub repository that you control.

The app is designed for personal GTD-style workflows: capture tasks quickly, organize them into lists, track follow-ups, review what needs attention, and stay focused with a built-in Pomodoro timer.

## Main features

- **Task management:** task lists, inbox capture, subtasks, due dates, links, stars, blocked/working/done states, sorting, completed-task history, bulk actions, and drag-and-drop reordering or moving between lists.
- **Follow-ups:** dedicated follow-up lists with ping/snooze workflows, discussion history, archived/resolved items, and ordering optimized for what needs attention next.
- **Review and nudges:** review surfaces, local notifications, configurable nudge windows, and lightweight diagnostics for troubleshooting.
- **Pomodoro focus timer:** quick `+25`, `:25`, and `:55` timers with ticking, end bell, ambient background-noise presets, organic mix support, and lock-screen-safe controls.
- **Offline-first PWA:** installable static web app with service-worker caching and local IndexedDB persistence.
- **GitHub sync:** optional multi-device sync using the GitHub Contents API and files in your own repository.
- **Backups and import/export:** local export/import plus automatic remote backup tiers when sync is configured.
- **Paranoid Mode:** optional per-device local at-rest encryption, lock screen, idle locking, security-key unlock, remote unlock/wipe support, panic wipe, and diagnostics.
- **Quality-of-life settings:** themes, keyboard shortcuts, update prompts, diagnostics export, and system capability checks.

## How it works

GTD25 is a client-only static app. There is no application server to run.

High-level flow:

```text
React UI and hooks
  -> Zustand UI state
  -> Dexie / IndexedDB local persistence
  -> Sync engine
  -> AES-GCM encrypted snapshot/changelog files
  -> Your GitHub repository via the GitHub Contents API
```

Technical stack:

- React 19 + TypeScript
- Vite 7 + Tailwind CSS 4
- Dexie over IndexedDB for persistent local data
- Zustand for transient UI state
- GitHub Contents API for optional sync
- Web Crypto API for sync encryption and Paranoid Mode cryptography
- Workbox / vite-plugin-pwa for PWA behavior
- Vitest, Testing Library, and fake-indexeddb for tests

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full technical design, including data model, sync flow, conflict resolution, deployment, and implementation details.

## Security model at a glance

GTD25 has two separate protection layers:

1. **Sync encryption:** when GitHub sync is configured, sensitive fields are encrypted in the browser before they are written to GitHub. GitHub stores the encrypted snapshot/changelog, not plaintext task content.
2. **Paranoid Mode:** optional per-device at-rest encryption for local IndexedDB data and sync credentials. The vault can be unlocked with a passphrase and/or enrolled FIDO2 security keys.

Important limits:

- Metadata such as IDs, ordering, timestamps, status, due dates, and activity patterns remains plaintext so the local database and sync engine can function.
- Security depends on strong user secrets. Weak sync passwords or vault passphrases are vulnerable to offline guessing.
- While the vault is unlocked, decrypted data and keys necessarily exist in browser memory.
- The app code is public and static; security does not rely on hiding implementation details.

See [THREAT_MODEL.md](./THREAT_MODEL.md) for the complete threat model, crypto inventory, attacker scenarios, residual risks, and maintenance rules.

## Development

Install dependencies:

```bash
npm ci
```

Run the local dev server:

```bash
npm run dev
```

Run checks:

```bash
npm run lint
npm test -- --run
npm run build
```

Build output is written to `dist/`. The project is deployed as a static site through GitHub Pages.

## More documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) - implementation architecture and sync design
- [THREAT_MODEL.md](./THREAT_MODEL.md) - security review and threat model
