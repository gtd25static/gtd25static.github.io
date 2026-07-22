# GTD25 — Security Review & Threat Model

**Last updated:** 2026-07-22 (**Paranoid extra: redact mode (opt-in)**: sidebar eye button + Ctrl/Cmd+Shift+H blur all content-bearing elements (`data-redact` sweep), revealing only the hovered/focused one — shoulder-surfing deterrence for working in public; active flag in localStorage `gtd25-redacted` (boolean, no content, panic-wipe-swept); **deterrence only** — DOM still holds plaintext, storage/sync unchanged. Earlier 2026-07-22: **Paranoid extra: instant-lock hotkey (opt-in)**: Ctrl/Cmd+Shift+L locks the vault from anywhere, including inputs (`paranoidLockHotkeyEnabled`, device-local, default off) — strictly shrinks the unlocked window. Earlier 2026-07-22: **Paranoid extra: lock when hidden (opt-in)**: lock the vault after the tab has been hidden for 0–300 s (0 = the instant it hides) — covers tab switches, which the Chromium-only IdleDetector path never sees; background timer throttling makes non-zero delays “at least N seconds” (documented). Strictly shrinks the unlocked window; device-local `paranoidBackgroundLock*`, default off. See Scenario 3. Earlier 2026-07-22: **Paranoid extra: privacy screen (opt-in)**: while unlocked, an optional full-app **blur veil** raises on tab-background or once **50% of the idle window** passes without interaction, and drops on movement/keypress/focus (dismissal counts as real interaction and re-arms the idle timer; pointer movement is observed **only while the veil is up**, so ACR-002 — only real interaction defers the re-lock — keeps its shape). Narrows shoulder-surfing and task-switcher-preview exposure during the run-up to auto-lock; explicitly **deterrence, not cryptography** (plaintext stays in the DOM; memory capture unaffected; the DEK still drops only at the real auto-lock). Device-local toggle `paranoidPrivacyOverlayEnabled`, default off. See Scenario 3. Earlier 2026-07-22: **Downloadable safety backups**: the boot-time device-local safety backups (localStorage, **never created under Paranoid**) gained a **Download** button beside the existing Restore — it repackages the backup into the standard **unencrypted** backup zip so another device can import it. No new data is created or retained: the same plaintext already sits in this device's localStorage, and the exposure class is identical to the existing plain "Export" (**plaintext task content leaving the device** in a file the user then controls). The zip carries lists/tasks/subtasks only — mindmaps are **absent, not empty**, which the importer reads as "keep this device's mindmaps". Earlier 2026-07-22: **Mindmap image export + canvas background + saved presets**: maps can now be exported as **PNG/SVG** or **copied to the clipboard as PNG** — built client-side from the layout into a standalone SVG (real `<text>`, every label **XML-escaped**, colours resolved to literals, no network and no third-party rasteriser); the honest residual is the one inherent to any export: **plaintext content leaves the encrypted store** into a file or the system clipboard, same class as the existing markdown-outline export. New **encrypted** field `mindmap.background` (the canvas colour, `#rrggbb`, validated on write; added to `SENSITIVE_FIELDS`, no SYNC_VERSION bump — additive + per-field merge, same reasoning as the node formatting fields below). New device-local **saved colour presets** in the existing `gtd25-mindmap-ui` localStorage key (a name + three hex colours — the only user-typed text in that key); applying one writes **literal colours onto the node**, so the preset list is an authoring shortcut and never a rendering dependency. Earlier 2026-07-22: **Mindmap node formatting**: nodes gain an optional **shape** (rounded rect / circle / decision diamond) and **colours** — five theme-aware presets plus an advanced per-part picker (background / text / border) — set from a format bar that appears while a node is selected. **Five new fields on `mindmapNode`** (`shape`, `palette`, `colorBg`, `colorFg`, `colorBorder`), all added to `SENSITIVE_FIELDS` so they are **encrypted** on the wire and at rest (a colour scheme is content). **No SYNC_VERSION bump** (still 6): the fields are additive and merge per-field, so an older device cannot clobber them — the accepted transitional residual is that an **old build may re-upload the formatting fields as plaintext** (shape name / preset id / hex colour, never the label) until it updates. **New render surface, closed by construction:** colours reach a `style` attribute, so `palette` is restricted to a **known preset id** and colours to `#rrggbb`, validated **both on write and on render** — corrupt/hostile values from sync or import fall back to the default look. Presets are stored as **ids, not literal colours** (theme-aware, and nothing user-controlled is interpolated into a CSS variable name). No change to cryptography, key handling, storage locations, or lock/wipe flows. See "What is encrypted vs. always plaintext" → Mindmaps. Earlier 2026-07-21: **Mindmaps**: new section — hierarchical node maps organized in nested folders, stored as three new synced entity types (`mindmapFolders`/`mindmaps`/`mindmapNodes`) that ride the existing changelog + field-level-LWW sync (**SYNC_VERSION 5→6**, additive; older devices hit the "Update required" gate). **Posture:** folder/map **names** and node **labels** are the only content fields and are **encrypted** (`SENSITIVE_FIELDS` + Paranoid at-rest middleware coverage for the three new tables); **structure is plaintext metadata** (`mapId`/`parentId`/`folderId`/`order`/timestamps — same class as `task.listId`) so trees merge without decrypting. **New accepted residual:** a backend reader learns each map's node count/depth/fan-out/edit cadence and the folder topology (an incremental sharpening of the existing structure-leak class — never names or labels). **New rendering surface:** labels support a markdown subset rendered by a custom parser that emits **React elements only** (no innerHTML; `href`s validated to http/https), so stored-label markup injection is excluded by construction. **New import surface:** markdown-outline import is a pure string parser with node/label caps; ZIP import gains the same validation under the existing ACR-011 bounds. Device-local collapse state lives in localStorage `gtd25-mindmap-ui` as opaque ids (wiped by panic-wipe's `gtd25-*` sweep and Wipe All Data). Trash/purge/backup/export flows cover the new tables like tasks. See "What is encrypted vs. always plaintext" → Mindmaps. Earlier 2026-06-24: **Local de-duplication / merge (per-list, client-side)**: new feature that detects near-duplicate tasks/follow-ups *within a single list* (a **local lexical** title comparison — normalize + token Jaccard + character-bigram Dice; titles are compared **in memory only**, nothing leaves the device) and, on user confirmation in a review modal, **merges** the chosen entries into one survivor — folding in the others' `description`, `link`/`links`, and `discussionLog`, re-parenting subtasks, and **soft-deleting** the sources. **No security-posture change:** merge runs **entirely client-side** (no new network surface); it only ever combines content that already lives in the **encrypted** task/subtask fields (`SENSITIVE_FIELDS` — title/description/link/linkTitle/links/discussionLog), so it introduces **no new plaintext or at-rest exposure**; the only additions are local `DEDUPE_*` tunables (constants) — **no new persisted or synced fields**, and the suggestion-dismissal state is in-memory/per-session. **Reversible:** sources are soft-deleted (recoverable from Trash, plus an Undo toast that restores the survivor's pre-merge row, un-deletes the sources, and re-parents subtasks). **Concurrent-edit convergence:** survivor fields carry per-field timestamps (LWW) and `discussionLog` keeps using the existing **id-keyed union** merge, so a concurrent edit on another device cannot silently lose merged history — the residual is the standard one already documented (a concurrently-edited source can resurface from Trash via field-level merge; a single deleted discussion entry can be resurrected by a device still carrying it). Detection is skipped for lists larger than `DEDUPE_MAX_ITEMS` (bounded O(n²) cost). See "What is encrypted vs. always plaintext" and Scenarios 1/7. Earlier 2026-06-16: **Relaxed unlock — evaluation window 24 h → 36 h**: the trailing window over which re-unlocks accumulate the +10%/unlock multiplier (and over which `unlockHistory` is retained) widened from 24 h to 36 h. Net effect: a busy stretch's elevated multiplier lingers ~50% longer and reaches the cap more easily. **Worst case unchanged** — the ×2 cap, the absolute caps (idle 240 min, grace 60 min), the OS system-idle base threshold, and all wipe/lock paths are untouched; this is bounded convenience only. `unlockHistory` is now pruned to 36 h (same low-sensitivity, device-local, never-synced plaintext class). See **Scenario 3**. Earlier 2026-06-15: **Relaxed unlock (adaptive auto-lock)**: opt-in toggle (default **off**) that multiplies the **in-app idle auto-lock** and the **screen-lock grace** by a factor scaling with recent unlock frequency — **+10% per unlock beyond the first in the last 36 h, hard-capped at ×2** (`relaxedUnlockEnabled`) — to cut the number of daily security-key/trusted-device unlocks for heavy users. **Bounded by design:** never exceeds 2× the user's configured values (and the existing absolute caps: idle 240 min, grace 60 min); the **OS system-idle threshold stays at the base value** (the true-absence safety net — it also can't be live-adjusted without resetting OS idle detection), and **failed-attempt wipe, panic/remote wipe, manual lock, and ACR-002 (only real interaction re-arms) are all unchanged**. The multiplier is applied at runtime to the in-memory idle window (the next interaction re-arms it; never re-armed on a tick, which would prevent locking) and read live at screen-lock time for the grace. New device-local **`unlockHistory`** (unlock timestamps, pruned to 36 h, **never synced**, recorded only while enabled) — same plaintext class as `lastNudgeAt`; reveals unlock cadence to a seized-device reader (low sensitivity). **Honest residual:** this cannot improve the worst case — while enabled, the worst-case unlocked window during active use rises to ≤2× the configured idle/grace; enabling it authorizes that. See **Scenario 3** and Recommendation 5. Earlier 2026-06-15: **Configurable screen-lock grace**: the optional post-screen-lock app-lock grace (System idle lock → "Delay GTD25 lock after a brief screen lock") is now a user-set duration — device-local `paranoidSystemLockGraceMinutes`, clamped **1–60 min**, default **unchanged at 10** — instead of a fixed 10 minutes. Pure timing/UI knob: **no change** to cryptography, key handling, what is encrypted, storage, or the wire format; the value is device-local (not synced), exactly like its sibling enable flag. **Security note:** a larger grace **widens the window** in which the DEK stays resident in browser memory after the OS screen locks — the in-app idle timer and the system-idle→immediate-lock path are unchanged, and an enrolled remote wipe still fires while unlocked. Existing users' behavior is identical until they change the value. See **Scenario 3** and Recommendation 5. Earlier 2026-06-12: **Shared Folder clipboard paste (confirm-before-upload)**: Ctrl+V in the Shared Folder view now classifies clipboard content — files/screenshots via `clipboardData.files`, full-string http(s) URLs as links, other text as snippets — and shows a preview dialog before uploading through the existing encrypted item APIs (quota, `SENSITIVE_FIELDS` metadata encryption, blob encryption all unchanged). Replaces the previous silent-upload paste. No new persistence or wire format: pasted bytes stay **in memory** until approval (no plaintext stash, unlike the share-target path), and the image-preview object URL is revoked on close. Residuals: clipboard content is rendered on screen pre-approval (user-initiated paste; shoulder-surfing class), and a paste auto-takeover means sensitive clipboard text could be displayed unexpectedly — bounded by requiring the folder view to be open, vault unlocked, and focus outside any text field. Earlier 2026-06-12: **ACR-014 v3 — strength gate recalibrated to a realistic adversary (deliberate loosening) + GitHub Sync gate bypass closed**: the enforced floor for new secrets drops from frontier-cluster-resistant to professional-farm-resistant — the assumed offline attacker changes from a ~100,000-GPU cluster (~10⁹ PBKDF2 / ~10⁸ Argon2id guess/s) to a dedicated ~1,000-GPU professional farm for a full year (~10⁷ / ~10⁶ guess/s), an adversary class this document's scenarios actually posit. Required entropy at the unchanged ">1 year average crack" bar: sync ~55.8→**~49.2 bits**, vault ~52.5→**~45.8 bits** — practical effect: **4 random diceware words now pass both gates** (previously failed both) while 1–3 words, patterned, blacklisted, and repeated-character secrets still fail; estimator design, no-composition policy, and blacklist unchanged. Honest residuals: secrets accepted at the new floor resist the assumed farm for ~7+ years (sync) but NOT a nation-state cluster (explicit non-goal, documented), and backend ciphertext can be harvested now and cracked later on future hardware — the doc now says to prefer margin above the gate. Also closed: the **GitHub Sync settings form set/changed the sync password with no strength gate at all** (ACR-014 was bypassable there); it now enforces the same gate and shows the live strength bar. Earlier 2026-06-12: **reliability review: wipe completion guarantee + corrupt-vault unlock honesty**: from a dedicated reliability/resilience review. (1) **Wipe convergence** — panic/failed-attempt wipe previously treated a BLOCKED IndexedDB deletion (second tab holding the DB) as done and reloaded, which could leave all encrypted data behind with localStorage/SW cleared; it now arms a `gtd25-wipe-pending` marker cleared only on confirmed deletion, retried on every boot before the app reopens the DB — strengthens the wipe scenarios' "wipe actually ran" assumption (pre-imaging caveat unchanged). (2) **Failed-attempt fairness fix** — a corrupt secrets blob or a failed migration resume after a PASSED verifier no longer increments `failedUnlockAttempts`: previously a corrupted vault could burn attempts and ultimately trip the **failed-attempt wipe with the correct passphrase**; the lock screen now tells corrupt-vault/resume failures apart from a wrong passphrase. Wipe-threshold security is unaffected: wrong credentials count exactly as before (ACR-009 serialization unchanged). Also: remote-unlock requester expiry now deletes a late approval response file (dead ciphertext hygiene, ACR-006 unchanged), and periodic maintenance loops (recurring check, focus tick, approver poll) tag persistent failures into diagnostics instead of failing silently. Earlier 2026-06-12: **password-field reveal toggles**: every secret input (vault passphrase incl. the lock screen, PAT, sync password, export/import passphrases) gained the standard eye toggle to show/hide the typed value — user-initiated, display-only React state, never persisted; no change to key handling, lock flows, or what is stored; the added shoulder-surfing exposure requires a deliberate tap and is accepted (the Paranoid randomized on-screen keyboard path is unchanged). Also 2026-06-12: **"Wipe All Data" typed-confirmation gate + honest recoverability copy**: the sync-wide "Wipe All Data" action (Settings → Backups) is now gated behind typing `yes` into the confirm dialog — pure anti-accident UI friction; no change to cryptography, storage, the wire format, or what the wipe deletes. Its in-app copy was also corrected: it previously claimed the wipe "cannot be undone" and "deletes all tasks locally and remotely", while **by design** the encrypted tier backups (`gtd25-backup-{hourly,daily,weekly}.json`) are untouched, a fresh pre-wipe `gtd25-snapshot-v<ver>.backup.json` is written precisely so the wipe *can* be undone, and prior snapshots persist in default-branch git history until the ~monthly squash (all already documented below — see "Default-branch history is also bounded" and the "Backup retention caveat"). The dialog now states that encrypted remote backups are kept (or, with sync off, that the wipe is genuinely unrecoverable). Conclusion impact: nothing weakened; this closes a UI-vs-reality gap where a user could believe a wipe destroyed remote copies that in fact remain restorable — and remain readable to a Scenario 7 repo reader holding the sync password. Earlier 2026-06-11: **Paranoid Mode traffic discretion (anti-fingerprinting)**: Paranoid devices now reduce how much their sync traffic *stands out* to a TLS-intercepting proxy / monitoring security team (distinct from confidentiality, which is unchanged) — (1) **commit messages are neutralized** to a generic `"update"` so the `"gtd25 sync: …"` brand no longer appears in PUT/DELETE/commit bodies (messages are write-only — no functional effect); (2) **every poll interval is jittered ±30%** so the cadence is no longer a fixed-period beacon; (3) the **idle poll is gated behind a conditional GET** so the steady state is bodyless `304`s instead of full-body pulls. Non-paranoid devices are byte-for-byte unchanged. **Residuals (explicitly unchanged):** URL **paths** + blob branch still carry the `gtd25` brand (a filename/branch rename is a deferred backend migration), the inherent "regular encrypted blobs to a personal repo" **DLP shape** can't be made innocent against a competent analyst, and the **PAT/repo/metadata** exposures of Scenario 4 are unchanged; the only robust mitigation on a genuinely hostile network is **not syncing there**. See **Scenario 4**. Earlier 2026-06-11: **remote-unlock Approve cooldown 3s→2s**: the deliberate delay before the Approve button on the trusted device's remote-unlock prompt becomes clickable was reduced from 3 to 2 seconds. UI-friction tweak only — the ceremony's security still rests on the verification-code match, the never-approve-unsolicited rule and the request-digest binding (ACR-001), none of which change; marginally less forced reading time before approval, accepted. Earlier 2026-06-10: **discussionLog merge hardened — data-loss risk closed**: the follow-up discussion history is now merged as a **union by entry id** (per-entry newer-wins on collisions) instead of whole-field LWW, so concurrent appends/edits on two devices no longer silently drop one device's entries — this closes the data-loss residual previously documented in "What is encrypted vs. always plaintext". New, strictly smaller residuals: a concurrent **deletion** of a single entry can be resurrected by a device still carrying it, and a merged array may not propagate until the topic is next edited. No change to cryptography or the wire format (the array stays encrypted as a unit; merge runs post-decryption). Earlier 2026-06-10: **'working' status removed**: the legacy 'working' task/subtask status value and its machinery (working banner, "Next up" suggestion, Work buttons/shortcuts) were removed — superseded by Focus Mode. Legacy rows are normalized to 'todo' by a one-time local migration that syncs like any edit, plus normalization at every sync/import ingestion point (**SYNC_VERSION 4→5**; older devices hit the existing "Update required" gate until updated). No change to cryptography, key handling, or the wire format; if anything, a backend reader loses the live "which one task is being worked right now" status signal (the coarser `workedAt` timestamp remains). Earlier 2026-06-10: **Focus Mode**: new default view showing a strict 2-3 task daily commitment set. Adds **one plaintext metadata field**, `task.focusedAt` (timestamp, same class as `workedAt` — NOT in `SENSITIVE_FIELDS`), and a device-local `lastFocusRefillDay` on `localSettings` (never synced). No change to cryptography, key handling, lock flows, or the wire format. Residual: a backend reader additionally learns **which ~3 task ids are currently in focus** and the daily refill cadence — an incremental sharpening of the existing status/timestamp metadata leak, accepted. Earlier 2026-06-10: **ACR-014 strength gate v2 + live strength bar**: choosing a vault passphrase or sync password now shows a **live segmented strength bar**, and the submit gate passes only when the estimated **average offline crack time exceeds one year** at this document's own attacker rates (~55.8 bits for the sync password at PBKDF2 ~10⁹ guess/s; ~52.5 bits for the vault passphrase at Argon2id ~10⁸ guess/s). Entropy = min(charset estimate with repeat discount, word-structure estimate at 12.9 bits/word); the previous **composition rules are removed** — a long lowercase-only passphrase passes, while one or two dictionary-style words fail with an actionable hint; the common-password blacklist still hard-fails. Net effect: *stricter* on patterned secrets ("Password1!" now fails) and *fairer* to long passphrases. Residual: word detection is structural (no dictionary), so a rare or leet-mangled single word can be overrated — see "brute-force economics". Earlier 2026-06-09: **Codex AppSec remediation verified + ACR-001 fully closed** — an independent re-review confirmed all 16 audit findings fixed or accepted-and-documented (per-finding verification notes now in `codex_appsec_review.md`); the last open ACR-001 recommendation is implemented — the approver **signs the request digest into the unlock response** and the requester **rejects any response not bound to its own pending request's digest**, making the approval ceremony end-to-end bound to the verified request; the follow-up review's two new P3 findings on the share-target stash lifecycle are **fixed**: the plaintext stash is now **swept on every unlocked start** (consumed if fresh, **purged after a 24h TTL**) and cleared on the error path, so a lost `?shareTarget` redirect can no longer orphan it indefinitely (**ACR-017**); and the SW **caps stashed shares** (≤ 20 files, ≤ 30 MB per file/aggregate, skipped files surfaced) so a mis-share can't exhaust the origin's storage quota (**ACR-018**) — see "Web Share Target" below. Earlier 2026-06-09: **Web Share Target moved to POST/multipart** so Android can share **files** in — files land in the E2E-encrypted **Shared Folder**, text/links in the **Inbox**; shared content now travels in the POST **body, not the URL** (removes the GET-in-query leak), with a transient plaintext Cache-Storage stash as the documented residual. Earlier 2026-06-09: **second batch of Codex AppSec hardening (ACR-005–016)**: entity ciphertext is now AES-GCM **bound to its record (type:id) via AAD** so it can't be relocated across records — residual anti-replay/rollback documented (ACR-005); remote-unlock **requester-side TTL** wipes the in-RAM key + stale request on expiry (ACR-006); **approver invites are signed and verified against the MAC-authenticated registry** so a PAT-only writer can't register an approver bond (ACR-007); failed unlock no longer leaves the DEK resident (ACR-008) and the **attempt counter is serialized** against the latest persisted vault (ACR-009); **Pomodoro/sound-preset names documented as plaintext metadata** (ACR-010); **import resource limits** on ZIP/sound archives (ACR-011); the **security-key affordance self-heals from vault metadata** if the localStorage cache is cleared (ACR-012); the unsigned **pending wipe status is labelled advisory** while confirmed stays signed (ACR-013); a **weak-secret gate** blocks clearly-weak passphrases/sync passwords (ACR-014); **diagnostics scrub tokens/share-target/secret blobs** (ACR-015); and a **Trusted Computing Base section + production CSP** were added (ACR-016). Earlier 2026-06-09: **hardening from the Codex AppSec review**: the Paranoid idle re-lock is now re-armed **only by real user interaction** — background DEK access (recurring checks, liveQuery, sync) no longer keeps the vault unlocked (ACR-002); WebAuthn enrollment **no longer logs PRF output bytes or the salt** to the console (ACR-003); and the GET Web Share Target's query string is **redacted from service-worker logs and scrubbed from the URL before any async work** so shared content does not linger (ACR-004). Earlier 2026-06-09: **remote-unlock approval is now bound to the exact verified+displayed request** — the approver re-verifies the requester signature and requires a canonical request digest match before sealing RUK, closing the ACR-001 request-swap window where a backend/PAT writer could redirect RUK to attacker-controlled key material after the verification code was shown. Earlier 2026-06-09: the sync repo's **default branch is now also periodically history-squashed** (~monthly, content-preserving orphan commit + force-update) to bound git-history growth from per-sync JSON commits; CAS-guarded, transparent to the app's content-SHA concurrency and other devices, recovery via the preserved remote backup files. Earlier 2026-06-09: Shared Folder blobs live on a dedicated orphan branch `gtd25-blobs` that is periodically **history-squashed** (single orphan commit + force-update) to purge deleted files so the sync repo stops growing; and GitHub GCs the freed bytes on its own schedule; wipe empties the branch. Earlier 2026-06-09: added the **Shared Folder**: an E2E-encrypted link/file/snippet store synced across the user's devices; item metadata — type/name/size/url/blobId/mimeType — is encrypted with only opaque id/order/timestamps plaintext; file/snippet bytes are sync-key encrypted on the wire and DEK-encrypted at rest under Paranoid; residual leak is per-blob count + ciphertext size to a backend reader. Prior: remote-wipe device lifecycle derived from shared repo files; registry-entry deletion as decommission signal; serialized `remoteApproverFor` writes + backend-error resilience; diagnostics log hardened against payload leaks)
**Maintenance:** This document MUST be kept current. See "Keeping this document
updated" at the end and the corresponding rule in `CLAUDE.md`.

> Scope: the GTD25 client-side PWA, its GitHub sync backend, and the optional
> per-device "Paranoid Mode" at-rest encryption + lock. Analysis is grounded in
> the actual implementation, not aspirations. Honest residual risks are called out.

---

## 1. System overview

- **Client:** a static, offline-first PWA (React + Dexie/IndexedDB). All app logic
  runs in the browser; the **app code is public** (hosted on GitHub Pages at
  `gtd25static.github.io`) — security does **not** rely on code secrecy.
- **Sync backend:** the user's **own GitHub repository**, written/read via the
  GitHub Contents API using a stored Personal Access Token (PAT). Files: a
  `snapshot` + `changelog` (+ optional periodic remote backups).
- **Two independent crypto layers:**
  1. **Sync E2E encryption (always on when sync is configured):** sensitive fields
     are AES‑256‑GCM encrypted with a key = `PBKDF2-SHA256(syncPassword,
     remoteSalt, 600_000)` before leaving the device. Same wire format whether
     Paranoid Mode is on or off (cross-compatible).
  2. **At-rest vault (Paranoid Mode, optional, per-device):** sensitive fields in
     IndexedDB are AES‑256‑GCM encrypted with a random **DEK**. The DEK is wrapped
     by a passphrase KEK = `Argon2id(passphrase, salt, 64 MiB, t=3)` and/or by the
     PRF KEK of **each enrolled FIDO2 security key** (the DEK is wrapped once per
     credential; **any one** enrolled authenticator unlocks). Enrolled authenticators
     may include external keys (YubiKey, USB/NFC) and a **phone over WebAuthn hybrid
     transport**. The PAT + syncPassword are moved into the encrypted vault (and
     cleared from plaintext storage).

### What is encrypted vs. always plaintext (critical)

Encryption is **field-level**. Encrypted fields (`SENSITIVE_FIELDS`):
- `taskList.name`; `task.title/description/link/linkTitle/links/discussionLog`;
  `subtask.title/link/linkTitle/links`; the `changeLog.data` snapshots;
  `sharedItem.type/name/size/url/blobId/mimeType` (Shared Folder — see below);
  and `mindmapFolder.name` / `mindmap.name` / `mindmap.background` /
  `mindmapNode.label` + `mindmapNode.shape/palette/colorBg/colorFg/colorBorder`
  (Mindmaps — see below).
- `task.discussionLog` is the follow-up discussion history (`{id, at, note}[]`).
  The free-text `note` is content, so the **whole array** is encrypted as a unit
  (the per-entry `at` timestamps are encrypted too — they are not exposed as
  metadata). The sync merge for this field is a **union by entry `id`** (not
  whole-field LWW, regardless of which side's field timestamp is newer), with
  per-entry newer-side-wins on id collisions — so two devices that each append
  or edit a discussion between syncs **converge without losing entries** (the
  former data-loss clobber is closed; see `UNION_ARRAY_FIELDS` in
  src/sync/field-timestamps.ts). Residuals (accepted, strictly smaller):
  (a) **deleting** an entry on one device while another still carries it
  resurrects the entry on merge (no per-entry tombstones; append is the
  dominant operation); (b) a merge applied from remote data does not re-log a
  change, so a resurrected/merged array may not propagate back until that
  topic's history is next edited.

**Always plaintext (metadata), at rest AND on the wire AND on the backend:**
- task/list/subtask **ids**, `listId`, `taskId`, `status`, `order`, `dueDate`,
  `createdAt`, `updatedAt`, `deletedAt`, recurrence/warning flags, `deviceId`,
  changelog `timestamp`. These are DB indexes and sync metadata.
- Follow-up ping/snooze timing — `pingedAt`, `pingCooldown`, `pingCooldownUntil`,
  `snoozeCadence`, `snoozeCadenceDays`, `archived` — is plaintext metadata. This
  is deliberate: it lets the "ready to discuss" count and the nudge engine work
  without unlocking the vault (the topic *titles* still require an unlocked vault
  to read). It also leaks how often you revisit topics.
- **Focus Mode membership** — `task.focusedAt` — is plaintext metadata (a
  timestamp only, same class as `workedAt`/`completedAt`). Deliberate: it syncs
  via field timestamps with no content attached. Residual: a backend reader
  learns **which ~3 task ids** are currently in the focus set and the daily
  refill cadence. (`lastFocusRefillDay` is device-local and never synced.)
- **Mindmap structure** — `mindmapNode.mapId/parentId/order`, `mindmap.folderId`,
  `mindmapFolder.parentId`, plus ids/timestamps — is plaintext metadata (same
  class as `task.listId`), so devices can merge tree edits without decrypting.
  Residual: a backend reader learns the **shape** of each mindmap (node counts,
  depth, fan-out, edit cadence) and the folder-tree topology — never a name or
  a node label.
- **Pomodoro settings and sound-preset names** (`pomodoroSettings`, `soundPresets`):
  **plaintext by design**, both in the sync snapshot and at rest under Paranoid Mode
  (the at-rest middleware covers tasks/subtasks/lists/sharedItems/mindmaps/changelog). They
  are timer config + user-chosen preset labels, classified as **metadata, not content**.
  Residual: a backend reader can see preset names and productivity/notification settings.
  If a user puts sensitive text in a preset name, it is **not** protected — keep names
  generic. (Imported sound *audio* blobs are device-local and never synced.)

➡️ **Metadata leakage is inherent to every scenario below.** An adversary always
learns the structure, size, timing, due dates, completion state, device count,
and activity patterns of your data — only the free-text content is protected.

**Ciphertext is bound to its record.** Each entity's encrypted field-bundle (`_enc`)
is sealed with AES-GCM **additional authenticated data = `entityType:id`**, so a
backend/PAT writer can't silently relocate one record's encrypted content onto another
record (e.g. move task A's title/description onto task B) — a swap fails authentication
and surfaces as **unreadable** rather than impersonating the target. All sensitive
fields of a record share one bundle, so cross-*field* swaps within a record are already
impossible. **Residual (anti-replay):** the AAD binds *identity*, not *freshness* — a
backend writer can still **roll a record back** to an older ciphertext it previously
saw, or replay a whole prior snapshot; metadata (due date, status, list membership)
remains plaintext-tamperable. Detecting rollback/replay would need per-record version
counters or a signed snapshot MAC (not yet implemented). Legacy pre-binding blobs stay
readable (an unbound fallback) and gain the binding when next re-encrypted.

#### Shared Folder (E2E file/link/snippet store synced across the user's devices)

The Shared Folder is a single app-level container holding three item types — links,
files, and text snippets — synced across the user's own devices (no multi-user
sharing; same single sync key as everything else).

- **Item metadata** (`sharedItem`): everything sensitive — the item **type**,
  **name/filename**, **size**, **url**, **mimeType**, and the opaque **blobId** — is
  encrypted as a unit into `_enc`. Only the opaque `id`, `order`, and timestamps are
  plaintext (parity with tasks). **No filename, type, URL, or size leaks** in the
  metadata file. `blobId` is encrypted so a backend observer cannot link a metadata
  entry to its blob object.
- **File/snippet bytes** live in separate opaque backend objects at
  `gtd25-shared/{random-id}` (no extension → no type leak) on a **dedicated orphan
  branch `gtd25-blobs`**, kept off the default branch so blob churn never bloats the
  task/snapshot history. On the wire they are AES-GCM encrypted with the sync key
  (`encryptBytes`).
- **History reclamation:** deleting a file removes it from the branch tip and flags
  a compaction; the next sync **history-squashes `gtd25-blobs`** — rebuilds it as a
  single orphan commit referencing only live blobs (reusing their git blob SHAs) and
  force-updates the ref, so deleted/old blobs become unreachable. We make history
  *unreferenced*; GitHub reclaims the bytes on its own GC schedule (we can't force
  it), so the repo stops growing and shrinks eventually, not instantly.
- **Default-branch history is also bounded:** to stop the per-sync JSON commits
  (snapshot/changelog rewrites) from growing forever, the sync repo's **default
  branch is periodically (~monthly) history-squashed** to a single orphan commit
  that keeps the *current* tree. It is content-preserving — git blob SHAs are
  unchanged, so the app's content-SHA-based concurrency and every other device are
  unaffected — and CAS-guarded against a concurrent push. Recovery relies on the
  remote `gtd25-backup-{hourly,daily,weekly}.json` files (preserved by the squash),
  not git history. Same eventual-GC caveat as above.
- **At rest** (the device-local `sharedBlobs` cache): bytes are **DEK/Argon2id-encrypted
  when Paranoid Mode is on**, plaintext when off (same posture as tasks). The cache is
  dropped and re-downloaded whenever Paranoid is toggled, so the at-rest regime never
  mismatches. While the vault is **locked**, neither the sync key nor the DEK is in
  memory, so item metadata reads as `_enc`/`⚠︎ unreadable` and blobs cannot be fetched
  or decrypted — the folder UI shows a locked state.
- **Size limits** (30 MB folder cap, per-item = remaining) are a client-side UX guard,
  not a security control.
- **Ingestion paths:** upload button, drag & drop, the Web Share Target (see its
  stash residual below), and **clipboard paste** (Ctrl+V in the folder view —
  files/screenshots, URLs, or text). Pasted content is classified and shown in a
  confirm-before-upload preview; it travels **in memory only** (no plaintext
  stash, unlike the share target) into the same encrypted pipeline and quota.
  The image-preview object URL is transient and revoked on close.
- **Residual leak (accepted):** an adversary who can read the backend (Scenario 7)
  sees the **number** of blob objects and each one's **approximate ciphertext size**,
  plus the count/timestamps of `sharedItem` metadata rows. This is the per-file-blob
  trade-off (chosen for efficient incremental sync); it never reveals filenames,
  types, URLs, or content. "Wipe All Data" (gated behind a typed `yes` confirmation)
  clears local items/blobs, pushes an empty
  snapshot, **and history-squashes `gtd25-blobs` down to its placeholder** so blob
  bytes are purged from the branch (then GC'd by GitHub on its schedule); the
  encrypted task-snapshot backups are deliberately **kept** (plus a fresh pre-wipe
  backup) so the wipe is recoverable.

#### Mindmaps (hierarchical node maps organized in folders)

Mindmaps are trees of labelled nodes stored as three synced entity types
(`mindmapFolders` / `mindmaps` / `mindmapNodes`), merging per-node via the same
changelog + field-level-LWW machinery as tasks (**SYNC_VERSION 6**, additive).

- **Encrypted:** folder/map **names**, node **labels**, and node **formatting**
  (`shape`, `palette`, `colorBg`, `colorFg`, `colorBorder`), in `_enc` on the
  wire and at rest under Paranoid (the at-rest middleware covers the three new
  tables). Labels may contain a markdown subset. Formatting is encrypted because
  a colour scheme *is* content ("red = blocked"), and hiding it costs nothing —
  it is not needed to merge structure.
- **Formatting is validated, never interpolated raw:** `shape` must be one of
  three literals, `palette` must be a **known preset id** (it is interpolated
  into a `var(--mm-<id>-…)` name) and the three per-part colours must match
  `^#[0-9a-f]{6}$`. Validation runs both **on write** (`updateMindmapNodeStyle`
  drops anything else) and **on render** (`resolveNodeStyle` falls back to the
  default look), so a hostile or corrupt value arriving from **sync, backup
  import, or a tampered local DB** cannot reach a `style` attribute. Presets are
  stored as an **id, never as literal colours**, so they are also theme-aware.
- **Transitional plaintext exposure (self-healing):** a device still running a
  build from before this feature decrypts a node's `_enc` blob, keeps the
  unknown formatting keys on its row, and — because its own `SENSITIVE_FIELDS`
  list doesn't contain them — would re-upload them **as plaintext columns**
  until it is updated. Exposure is limited to a shape name / preset id / hex
  colour (never the label), and a re-encrypt happens on the first write from an
  updated device. Not gated by a SYNC_VERSION bump: the additive fields merge
  per-field, so an old client's payload (which carries no timestamps for them)
  cannot clobber formatting, and bumping would have broken sync for
  not-yet-updated devices over a cosmetic feature.
- **Plaintext:** all structure (see the metadata bullet above). Accepted
  residual: graph shape/topology/timing is visible to a backend reader.
- **Rendering surface (stored-content XSS):** node labels are rendered by a
  **custom markdown-subset parser that emits React elements only** — no
  `dangerouslySetInnerHTML`, no raw HTML pass-through anywhere, so markup
  injection via a synced label is impossible by construction. The single
  sanitized surface is link `href`s, validated to http/https (a `javascript:`
  URL renders as plain text) and opened with `rel="noopener noreferrer"`.
- **Untrusted import surface:** "Import outline" parses a user-supplied `.md`
  file/paste with a pure string parser (no eval, no DOM), capped at 2000 nodes
  and 1000 chars/label; ZIP backup import applies the same caps plus the
  existing `MAX_RECORDS_PER_ARRAY`/size bounds (ACR-011 class).
- **Device-local UI state:** collapse/expand state lives in localStorage
  (`gtd25-mindmap-ui`) as **opaque node ids only** — no content, plus the user's
  saved colour presets (a name + three hex colours; the only user-typed text in
  that key, low sensitivity, e.g. "Corporate"). Applying a preset writes the
  **literal colours onto the node** (which are encrypted like the rest of the
  formatting), so the preset list is an authoring shortcut, never a rendering
  dependency — a styled node looks identical on a device that has never seen the
  preset. It is removed by "Wipe All Data" and swept by the panic wipe's
  `gtd25-*` prefix clear.
- **Image export (PNG/SVG):** "Download PNG/SVG" and "Copy PNG to clipboard"
  build a standalone SVG **from the layout data**, entirely client-side (no
  network, no third-party rasteriser): labels become real SVG `<text>` with
  every label **XML-escaped**, so a stored label cannot inject markup into the
  exported document, and colours are resolved to literals so the file carries no
  reference back to the app. The PNG is rasterised in a local `<canvas>` from
  that same SVG. **Residual (inherent to exporting):** the output is
  **plaintext content leaving the encrypted store** — a downloaded file, or the
  system clipboard, which other apps can read. Same class as the existing
  markdown-outline export, now with the map's colours and shapes too.
- Trash/restore, 30-day tombstone purge, ZIP export/import and remote backups
  cover mindmaps exactly like tasks. Old clients (≤ v5) hit the existing
  "Update required" gate rather than mis-parsing mindmap changelog entries.

### Crypto inventory
| Purpose | Algo | Key derivation | Verifier (oracle) |
|---|---|---|---|
| Sync content | AES‑256‑GCM | PBKDF2‑SHA256, 600k, `syncPassword` | `encryptionVerifier` in snapshot |
| Vault at-rest | AES‑256‑GCM (random DEK) | DEK wrapped by Argon2id(passphrase) and/or FIDO2‑PRF | `verifier` in vault row |

### Key sizes, KDFs & brute-force economics

**Exact parameters (from the code):**

| Item | Value |
|---|---|
| Symmetric cipher | AES‑256‑GCM (256‑bit keys, 96‑bit IV, 128‑bit auth tag) |
| Random DEK (vault) | 256‑bit, CSPRNG (`crypto.subtle.generateKey`) |
| FIDO2‑PRF KEK (security key) | 256‑bit, hardware‑derived (hmac‑secret) |
| Salts | 128‑bit (16 bytes), CSPRNG, unique per vault/remote |
| Sync KDF | **PBKDF2‑HMAC‑SHA256, 600,000 iterations** → 256‑bit |
| Vault KDF | **Argon2id, 64 MiB, t=3, p=1** → 256‑bit |

**The keys themselves are not the attack surface.** The DEK, the PRF KEK, and the
sync key are full‑entropy 256‑bit material — directly brute‑forcing them is 2²⁵⁶,
i.e. impossible. **The only practical attack is guessing the human secret that
wraps them** (the `syncPassword` for sync content; the vault `passphrase` for
local data), validated offline via the `verifier` oracles. The **security‑key
path has no guessable secret at all** (the 256‑bit PRF output never leaves the
key) → not brute‑forceable.

So effective strength = **password entropy × per‑guess KDF cost**. Online guessing
at the lock screen is irrelevant (the failed‑attempt wipe throttles it); the real
threat is **offline** (a seized disk for the vault, a readable backend/proxy log
for sync), where the verifier lets the attacker check guesses at full hardware
speed.

**Per‑guess cost & assumed attacker** (order‑of‑magnitude, still
attacker‑favourable — a dedicated **~1,000‑GPU professional cracking farm
running a full year against this one user**, a multi‑million‑dollar
commitment already implausible for a personal task vault):

| KDF | ~per‑GPU rate | ~aggregate (1,000 GPUs) |
|---|---|---|
| PBKDF2‑600k | 10⁴–10⁵ guess/s | **~10⁷ guess/s** |
| Argon2id 64 MiB | 10³ guess/s (memory‑hard caps parallelism) | **~10⁶ guess/s** |

**Explicit non‑goal:** resistance to a ~100,000‑GPU frontier/nation‑state
cluster (~10⁹/10⁸ guess/s — the previous calibration) is NOT a design target;
no scenario in this document posits one. Each 100× of attacker scale costs
~6.6 bits ≈ half a diceware word — users who want frontier‑cluster margin add
one more word. Caveat that cuts the other way: backend ciphertext can be
**harvested now and cracked later** on future hardware, so the 1‑year bar at
today's rates is a floor, not a ceiling — prefer margin above the gate.

**Entropy of common secret styles:** lowercase ≈ 4.7 bits/char · alphanumeric ≈
5.95 · full‑ASCII ≈ 6.55 · **diceware word ≈ 12.9 bits/word** · digit ≈ 3.32.

**Average time to crack (search half the space) at the rates above:**

| Secret | ~Entropy | Sync `syncPassword` (PBKDF2, ~10⁷/s) | Vault `passphrase` (Argon2id, ~10⁶/s) |
|---|---|---|---|
| 6‑digit PIN | ~20 bits | **instant** | **instant** |
| 8‑char random alnum | ~48 bits | ~5 months | ~4.5 years |
| 4 diceware words | ~52 bits | ~7 years | ~70 years |
| 10‑char random alnum | ~60 bits | ~1,800 years | ~18,000 years |
| 5 diceware words | ~65 bits | ~58,000 years | ~580,000 years |
| 6 diceware words | ~77 bits | ~240 million years | ~2.4 billion years |

**Implications (the honest headline):**
- **Entropy dominates; the KDF is a ~1‑order‑of‑magnitude modifier.** Argon2id
  buys roughly **10×** over PBKDF2‑600k at scale (its bigger win — capping
  massive GPU/ASIC *parallelism* via memory‑hardness — is real but conservatively
  not counted here). **A weak password falls under either KDF; a strong one
  resists both.** Don't lean on the KDF to rescue a short password.
- **A 6‑digit (or any low‑entropy) PIN is worthless offline** — broken in
  well under a second regardless of KDF. This is exactly why the vault uses a
  full passphrase, not a PIN, for the at‑rest secret.
- **The `syncPassword` is the weaker‑KDF secret AND it guards the backend/proxy
  copies** (which an adversary may retain forever — harvest now, crack later).
  Target **≥ 4 diceware words (~52 bits, ~7 years average against the assumed
  farm)**; 5 words buys decades of hardware‑improvement margin. An 8‑char
  "complex" password (~48 bits) falls in **months**, not years.
- **The vault `passphrase`** should likewise be **≥ 4 diceware words**; the
  attacker additionally needs the disk image first, and the security key is the
  recommended tier when seizure is a live concern.
- **The genuinely unbreakable tier is the security key** (hardware‑bound 256‑bit
  PRF, no guessable secret). Prefer it where offline attack is a real concern.
- These figures assume *random* secrets. Human‑memorable, patterned, or
  dictionary‑derived passwords have far less entropy than their length suggests
  and can fall orders of magnitude faster (smart mask/rule attacks).
- **Enforced at secret choice (ACR-014 v3):** the app gates new vault passphrases
  and sync passwords on this exact model — `src/lib/password-strength.ts` (with a
  live `PasswordStrengthBar` at every choose-a-secret point, including the GitHub
  Sync settings form, which previously bypassed the gate entirely) estimates
  entropy as min(charset-based with repeat discount, word-structure at 12.9
  bits/word) and requires **> 1 year average crack time** at the rates above
  (~45.8 bits vault / ~49.2 bits sync — i.e. 4 random diceware words pass both).
  There are no composition rules; the common-password list still hard-fails.
  Residual: the word model is structural (no dictionary), so a rare or
  leet-mangled word can be overrated, and random unbroken letter strings are
  conservatively under-rated.

---

## 2. Assets to protect
1. **Task content** (titles, descriptions, links) — the primary secret.
2. **Credentials:** the GitHub **PAT** and the **syncPassword**.
3. **Metadata** (best-effort only — structurally unprotected).
4. **Presence/usage** of the app on a device (minimised, not hidden).

---

## 3. Threat scenarios

Legend: 🔴 full compromise · 🟠 partial / conditional · 🟢 protected (to a stated bound).

### Scenario 1 — Paranoid Mode ON vs OFF (baseline)
This is a modifier on every other scenario, summarised here:

- **OFF:** IndexedDB holds **plaintext** task content; `localStorage`/IndexedDB
  hold the **PAT and syncPassword in plaintext**; local backups are plaintext.
  Only the *sync* layer protects data *in transit/at the backend*. Anything with
  local access wins.
- **ON:** local content + credentials are encrypted at rest behind the vault
  (passphrase Argon2id and/or security key). No local or remote backups are
  created. An idle/lock screen gates access; failed-attempt and panic wipes exist.
  Protection is bounded by **passphrase strength** (or the security key) and is
  **only effective while locked** (see Scenario 3).

### Scenario 2 — Device seized, **disk imaged** (offline)
What the attacker gets from the image: IndexedDB, `localStorage`, the SW asset
cache.

- **Paranoid OFF — 🔴 full compromise.** Plaintext task content, the PAT, and the
  syncPassword are all recoverable directly. The PAT then grants backend access
  and the syncPassword decrypts everything synced.
- **Paranoid ON — 🟠 content protected to passphrase strength; metadata leaks.**
  The image yields: encrypted rows (`_enc`), the **wrapped DEK**, `passSalt`, and
  a `verifier` (an offline oracle to test passphrase guesses). To recover content
  the attacker must **brute-force the passphrase** (Argon2id 64 MiB — costly but
  bounded by passphrase entropy; a weak passphrase falls — see the in-repo
  estimate) **or** possess the **security key** (its secret is *not on the disk*,
  so a security-key-wrapped DEK is not offline-recoverable).
  - **Residual risks:** (a) **metadata** is plaintext; (b) **forensic residue** —
    IndexedDB/LevelDB may retain old plaintext pages from *before* Paranoid Mode
    was enabled until storage compaction; the migration rewrites rows but cannot
    guarantee the underlying engine overwrote old pages; (c) app **presence** is
    evident from the SW cache + origin history.
  - **Mitigations in place:** Argon2id KDF, security-key tier (recommended for
    real seizure risk), persistent-storage request, panic/failed-attempt wipe
    (note: wipes only help *before* imaging — a copied disk is immune). The wipe
    sets a `gtd25-wipe-pending` marker that survives until the IndexedDB
    deletion is **confirmed**: a deletion blocked by a second tab is retried on
    every app boot (`retryPendingWipe`), so an interrupted wipe converges to
    complete instead of silently leaving data behind.

#### Backup/export files (manual ZIP exports)
- **`exportToZip()` offers an encrypted container.** The export dialog lets the
  user pick: unencrypted (legacy), or AES‑256‑GCM encrypted with a key derived
  (PBKDF2‑SHA256, 600k) from **either a typed passphrase or the existing sync
  password**. The ZIP holds a plaintext `manifest.json` (`format`, `exportVersion`,
  `exportedAt`, `kdf`, `salt`, `verifier`, `keySource` — all non-sensitive) and an
  encrypted `data.enc` blob. Import detects the format, validates the password via
  the verifier (clear "wrong password" error), then decrypts.
- **Stronger than the sync wire format on purpose:** the *entire* payload —
  including metadata — is inside `data.enc`, so an encrypted export leaks **no**
  metadata, unlike the sync snapshot (which leaves metadata plaintext). It does
  **not** contain the PAT/syncPassword (export only carries tasks/lists/subtasks/
  settings/pomodoro).
- **Residual:** unencrypted export is still available by user choice (in Paranoid
  Mode the dialog *defaults* to encrypted but does not forbid plaintext). Strength
  is bounded by passphrase entropy; PBKDF2‑600k is weaker than the vault's
  Argon2id. Export reads decrypted data, so in Paranoid Mode it requires an
  **unlocked vault**. The separate Paranoid recovery export
  (`SecuritySettings.handleRecoveryExport`) is still plaintext by design.

### Scenario 3 — Device seized, **memory dumped** (RAM capture while powered on)
- **Paranoid OFF — 🔴.** Plaintext content + PAT + syncPassword are in the JS heap.
- **Paranoid ON + UNLOCKED — 🔴.** While unlocked, the **DEK**, decrypted data,
  PAT, syncPassword and the derived sync key are in memory. At-rest encryption
  does **not** defend a live memory capture. This is the fundamental limit of
  any in-browser scheme. If the optional **screen-lock grace** is enabled
  (configurable, default 10 min, up to 60), an OS screen-lock event does not
  immediately drop the DEK; the app remains in this unlocked category until the
  grace expires, unless the screen unlocks/activity resumes first (which cancels
  the pending app lock) or another lock path fires. A longer grace lengthens this
  exposure window. If **Relaxed unlock** is enabled, both the in-app idle timeout and
  the screen-lock grace are scaled by up to **2×** (growing with how many times you've
  unlocked in the last 36 h), so this unlocked window can reach twice your configured
  values — bounded, opt-in, and never affecting the OS system-idle lock (which stays
  at the base threshold).
- **Paranoid ON + LOCKED — 🟠.** On lock the app drops the DEK (`currentDek=null`),
  clears cached secrets, and clears the sync key; the encrypted data lives in
  IndexedDB, not necessarily in the heap. A dump taken while locked recovers
  *much less*, but **not nothing**: JS strings (a recently typed passphrase), or a
  not-yet‑garbage-collected key object, may linger; a full process dump can
  include the browser's crypto subsystem. **Locking reduces, does not eliminate.**
  - **Mitigations:** aggressive auto-lock (idle timeout + optional system-idle /
    screen-lock detection), keylogger-safe security-key unlock (no passphrase
    string in memory), short unlocked windows. The idle timer is re-armed **only by
    real user interaction** (pointer/key via `touchVaultActivity`) — **DEK access by
    background code (recurring-task checks, liveQuery refreshes, sync) no longer
    defers the re-lock**, so an idle-but-open tab still locks on schedule (ACR-002).
    **Recommendation:** keep idle timeout short and lock before walking away; treat
    memory capture while unlocked as unwinnable.
  - **Redact mode (opt-in Paranoid extra, 2026-07-22):** a toggle (sidebar eye
    button / Ctrl+Cmd+Shift+H) that CSS-blurs every content-bearing card and
    name across the app, revealing only the element under the cursor or
    keyboard focus — for working with the app open in public. The active flag
    is mirrored to localStorage (`gtd25-redacted`, one boolean, no content;
    swept by the `gtd25-*` panic-wipe prefix) so it survives a lock/unlock in
    public. **Deterrence only, stated in the UI**: the plaintext is in the DOM,
    a mild blur can be defeated by OCR or a paused screen recording, and it
    does not change what is stored or synced.
  - **Instant-lock hotkey (opt-in Paranoid extra, 2026-07-22):** Ctrl/Cmd+Shift+L
    drops the DEK immediately from anywhere in the app, including inputs — the
    reflex-speed version of the sidebar lock button. Strictly shrinks the
    unlocked window; no new exposure.
  - **Lock when hidden (opt-in Paranoid extra, 2026-07-22):** locks the vault
    once the tab has been hidden for a configurable 0–300 s (0 = immediately).
    Catches **tab switches**, which the IdleDetector path does not see, and
    works in every browser (the IdleDetector is Chromium-only). Honest limit:
    background-tab timers are throttled, so a non-zero delay means "at least
    N seconds" (the 0 case rides the visibility event itself and is exact).
    Strictly shrinks the unlocked window — no new exposure.
  - **Privacy screen (opt-in Paranoid extra, 2026-07-22):** while unlocked, a
    full-app blur veil raises when the tab is backgrounded or once **half the
    idle window** passes without interaction, and drops on any real interaction
    (which also re-arms the idle timer — a wake gesture is interaction; pointer
    *movement* is listened to only while the veil is up, so ACR-002's shape is
    unchanged: background code still can't defer the lock). This narrows the
    **shoulder-surfing / glance-at-an-unattended-screen** window during the
    run-up to the auto-lock and blanks task-switcher previews on mobile.
    **Deterrence, not cryptography**: the DOM behind the CSS veil still holds
    plaintext, and a memory/DOM capture is unaffected — the DEK drops only when
    the real auto-lock fires. Accepted tradeoff: a nudged mouse lifts the veil
    and defers the lock (that pair is inherent to "dismiss on movement").

### Scenario 4 — **TLS interception** (no device access; proxy inspects HTTPS)
A browser cannot prevent TLS MITM (no cert pinning). The proxy sees the decrypted
GitHub API traffic.

- **Both ON and OFF (identical wire format) — 🟠.** Exposed: the **PAT** (sent as
  `Authorization: Bearer …` on every request — unavoidable client-side), the
  **repo name**, all **plaintext metadata**, and the **ciphertext** content.
  *Not* exposed (without the syncPassword): task content (AES‑GCM, sync key).
  - **Consequences:** the captured PAT escalates to **Scenario 6/7** (backend
    read/write). A logging proxy retains *all* ciphertext + metadata forever, so
    later key rotation cannot un-expose past data.
  - **Mitigations / recommendations:** use a **fine-grained, single-repo,
    least-privilege, short-expiry PAT**; rotate it if a TLS-inspecting environment
    is suspected; minimise what is synced; accept that metadata + the PAT are
    visible to such a proxy. Paranoid Mode does **not** change this *confidentiality*
    surface (PAT/metadata/ciphertext stay visible) — but it now adds limited
    **traffic discretion**, see the next bullet.

- **Traffic fingerprinting / beaconing — does the app *draw attention*? (distinct
  from the confidentiality bullet).** Even a proxy that never decrypts content sees
  *shape*, and a custom app beaconing to a personal GitHub repo on a fixed cadence
  pattern-matches what security teams hunt for (exfiltration / C2). The tells:
  (a) the app brand `gtd25` in commit messages **and** file paths; (b) a perfectly
  periodic poll (~2 GETs / 30 s, plus ~1 GET / 12 s if remote unlock is enrolled),
  ~240–540 req/hr to one host forever; (c) regular opaque high-entropy uploads to a
  private repo — to DLP, encryption makes this *more* suspicious, not less.
  - **What Paranoid Mode does (2026-06-11) — 🟠→🟡 on the *fingerprint*, not the
    content:** (1) **neutralizes commit messages** to a generic `"update"` (the
    `"gtd25 sync: …"` brand no longer appears in PUT/DELETE/commit bodies); (2)
    **jitters every poll interval ±30%** so the cadence is no longer a fixed-period
    beacon; (3) gates the idle poll behind a **conditional GET** so the steady state
    is two bodyless `304`s rather than full-body pulls. Non-paranoid devices are
    unchanged. This defeats cheap brand/periodicity heuristics and stops a benign
    tool from being *misclassified* as malware.
  - **Residuals (honest):** the **URL paths** still contain `gtd25-snapshot.json` /
    `gtd25-changelog.json` and branch `gtd25-blobs` (a filename/branch rename is a
    deferred backend migration), so the brand is still visible *in the path* under
    MITM; the **inherent shape** (regular encrypted blobs to a personal cloud repo)
    cannot be made innocent against a competent analyst who decrypts/inspects; and
    the **PAT/repo/metadata** exposures above are unchanged. The only robust
    mitigation on a genuinely hostile/monitored network is **not syncing there**
    (sync later over a channel it does not inspect). If that network's policy forbids
    personal cloud sync, the correct course is to not sync there — not to camouflage.

### Scenario 5 — **Keylogger** on the device
Captures keystrokes (and, in capable EDR, clipboard).

- **Paranoid OFF — 🟠→🔴.** The **syncPassword** (typed at setup) and any typed
  **PAT** are captured. Combined with Scenario 4/7 ciphertext, content is
  decryptable.
- **Paranoid ON — 🟠, degrades to 🔴 if combined with disk access.** The unlock
  **passphrase**, if typed, is captured → with a disk image (Scenario 2) the
  attacker unlocks the vault → full local content + credentials. The syncPassword
  is also typed at setup.
  - **Mitigations in place:** (a) **security-key unlock** — nothing is typed; the
    PRF secret never enters the keyboard/clipboard, and the key's PIN *alone* is
    useless without the physical key. **Multiple keys may be enrolled** (e.g. a
    primary YubiKey plus a backup key, and/or a **phone over hybrid transport**), so
    the keylogger-safe path stays available even when one authenticator is absent.
    (b) **opt-in randomized on-screen keyboard** — defeats keystroke + mouse-
    coordinate logging **only if the screen is not captured and memory is not
    scraped** (narrow, conditional — a full EDR with screenshot/memory access
    defeats it).
  - ⚠️ **Phone authenticators are a softer factor than a dedicated FIDO2 key.** An
    Android passkey is typically **Google-synced**, so its PRF/`hmac-secret` may be
    backed up to the user's Google account (Google's E2E passkey backup, gated by a
    device lock-screen knowledge factor). Unlike the hardware-bound YubiKey (no cloud
    copy, secret never extractable), this makes **"Google account + device PIN"** a
    potential recovery/attack path *for that authenticator*. It does **not** weaken
    the laptop directly — nothing is typed there, no secret sits on the laptop disk,
    and nothing transits the GTD backend — but the phone is a more-exposed, possibly
    cloud-recoverable key. Device-bound credentials are strictly stronger but cannot
    be forced from the web. Keep a hardware key as the primary high-assurance factor.
  - **Enrolling more authenticators widens the unlock surface** (any one unlocks).
    Per-key removal/rotation is therefore important; remove a lost/retired key
    promptly in Security settings (re-keying the vault is not required — dropping the
    credential's wrapped-DEK entry revokes it).
  - **Recommendations:** on an untrusted machine use the **security key** as the
    daily unlock; treat any passphrase/syncPassword typed there as **burned** and
    rotate it on a trusted device; ideally perform setup (where the syncPassword
    is chosen) on a trusted device.

### Scenario 6 — Attacker knows the repo name but has **no valid PAT**
- **Both ON and OFF — 🟢 (conditional on repo being PRIVATE).** GitHub enforces
  authentication: a **private** repo returns 404 to unauthenticated/unauthorized
  callers (it won't even confirm existence). Knowing the name yields nothing.
  - ⚠️ **Critical dependency:** if the sync repo is **public** (user
    misconfiguration), knowing the name = full read access → collapses to
    **Scenario 7**. The app does not (and cannot) enforce repo visibility.
  - **Recommendation:** the sync repo **must be private**. (The app-hosting repo
    `gtd25static.github.io` is public but contains only app code — no user data.)

### Scenario 7 — Attacker **can read the GitHub backend** (valid PAT, or public repo)
They obtain `snapshot`, `changelog`, any remote backups, **and the full git
history**.

- **Both ON and OFF — 🟠.** Fully exposed: **all metadata** + the complete
  **history** of it (timestamps, due dates, statuses, structure, deleted-item
  metadata until pruned, device count). Content is **ciphertext**, protected only
  by the **syncPassword** via **PBKDF2‑600k**.
  - **Weakness:** the snapshot's `encryptionVerifier` is an **offline oracle** to
    validate guessed syncPasswords; PBKDF2‑600k is far weaker than the vault's
    Argon2id, so a **weak syncPassword is GPU-brute-forceable**. Old git commits
    retain ciphertext under *old* keys, so rotation is forward-secret only.
  - **Paranoid Mode does not help here** — it never changes the backend bytes.
  - **Recommendations:** use a **strong, high-entropy syncPassword**; a PAT with
    **write** access also enables data destruction/tampering (use least
    privilege); consider periodically squashing repo history to shrink the
    standing ciphertext window (does not help an attacker who already cloned/
    proxied it).

### Scenario 8 — Remote unlock & wipe (optional, opt-in per device)
A Paranoid device may enrol one or more **trusted approver devices** (which MUST be
Paranoid-OFF) that can, via files relayed through the existing GitHub repo,
**remotely unlock** the locked device (you approve on the trusted device) or
**remotely wipe** it if lost. Mechanics: at enrolment a random **RUK** wraps the
DEK (`dekWrappedByRuk` on disk) and is delivered ECIES-encrypted to each approver's
identity key; the approver stores RUK and prunes accepted/stale invite mailbox
entries so forgotten devices are not silently re-created. To unlock, the locked
device posts a signed request carrying an **ephemeral session key K (RAM-only)**
ECIES-encrypted to the approver; the approver returns RUK encrypted under K; the
locked device unwraps the DEK. Device identity keys are distributed via a registry
**authenticated by a syncPassword-derived HMAC**.

- **Confidentiality vs. disk image + fully-logged backend — 🟢 (forward-secret).**
  K lives only in the locked device's RAM; RUK lives only on the approver; the disk
  holds only `dekWrappedByRuk`. The backend only ever carries values encrypted to
  the approver's key or to the ephemeral K. So a seized disk **plus** a complete
  proxy/git log still cannot reconstruct the DEK.
- ⚠️ **Cost — the PAT is kept plaintext at rest while remote features are enrolled**
  (the locked device needs it to reach the mailbox). This **weakens Scenario 2**: a
  disk-only attacker (theft/loss/border, *without* the proxy) now also gets backend
  **metadata + tamper/delete** — but **not content** (still syncPassword-gated) and
  **not the vault** (DEK independent). For the corporate-proxy adversary this is no
  new exposure (the proxy already had the PAT). Use a least-privilege single-repo PAT.
- **Adding approvers later** keeps the SAME RUK (stored as `rukWrappedByDek`, i.e.
  RUK encrypted under the DEK) so existing approvers are not re-keyed. No new at-rest
  exposure: recovering RUK from `rukWrappedByDek` requires the DEK (an unlocked vault),
  exactly like reading content.
- **New standing factor — the approver holds RUK.** **Approver compromise + a disk
  image of the locked device = DEK.** The approver is therefore a deliberately
  chosen, trusted device; a **Paranoid device is forbidden from being an approver**
  (enrolment offers only Paranoid-OFF devices; a device refuses approver duties and
  drops held RUKs the moment its own Paranoid Mode is enabled).
- **Forged-request resistance.** A disk-image attacker has the locked device's
  *signing* key (plaintext, so it can sign while locked) and can post a fake unlock
  request — but completion requires **you approving on the trusted device**. Requests
  are single-use, short-TTL and **user-initiated**, and both screens show a
  **verification code** (derived from K) that must match; an **unexpected prompt is
  an attack signal → deny**. **Approval is cryptographically bound to the exact
  request that was verified and displayed:** when you approve, the approver re-verifies
  the requester signature **and** requires the request to hash to the same canonical
  digest (over `fromDeviceId|nonce|ts|kForApprover`) it showed you — so a
  backend/PAT/same-account writer that **swaps the request after the code is shown**
  (substituting attacker-controlled ECIES key material) is **rejected by the approver**,
  not merely caught by you noticing a code mismatch. The binding is **end-to-end**: the
  approver also **signs the request digest into the response**, and the requester
  accepts only a response carrying the digest of its own pending request — a
  validly-signed response for any other request (a coerced or buggy approver answering
  the wrong ceremony) is ignored. Residual: still user-gated (don't
  approve prompts you didn't initiate; check the code) — but the code-vs-swap window is
  now closed by the digest binding rather than relying on vigilance alone.
- **Identity-key trust.** The registry MAC (syncPassword-derived) stops a PAT-only
  attacker from injecting or substituting approver identity keys; enrolment is
  **owner-gated** (only an unlocked owner can grant an approver — delivering RUK needs
  the live DEK) and **fingerprint-confirmed**; **revocation re-keys RUK** so a removed
  approver's copy opens nothing. Residual: trust is only as strong as the
  syncPassword (the same anchor as content) — the fingerprint match is the backstop.
- **Remote wipe — recoverable DoS only.** A wipe command is a one-way, approver-
  *signed* message; a captured **PAT alone cannot forge it**. Worst case (an attacker
  holding a *trusted device's* signing key) destroys local encrypted data the
  attacker could not read anyway — recoverable by re-syncing. **Delivery requires the
  protected device's app to be open and online** (it polls whether the vault is
  locked or unlocked; a powered-off/closed device receives the command on next open).
  Before wiping, the protected device best-effort writes a **protected-device-signed**
  wipe confirmation (`gtd25-wipe-status-{deviceId}.json`) so the trusted device can
  show "wipe confirmed". Confirmation is not guaranteed: if the device loses network
  after receiving a valid command but before writing the status, it still wipes and
  the trusted device remains at "sent / pending confirmation".
- **Shared, file-derived wipe lifecycle.** Each trusted (approver) device derives a
  managed device's lifecycle (idle → wipe sent/pending → confirmed → decommissioned)
  from the **shared** repo files — the command, the signed wipe-status, and the
  MAC-authenticated device registry — rather than only its own local notes, so all
  trusted devices converge on the same view. **Decommission = registry-entry
  deletion:** *purge* (only after a verified confirmation) deletes the device's
  registry entry plus the command/status/unlock files; *forget* (no confirmation
  yet) deletes the registry entry but intentionally leaves the wipe command **armed**
  so the device still self-wipes if it reappears. Either action removes the device
  from every trusted device's list on their next refresh. Residual: a *forgotten*
  device's still-armed command (and any later wipe-status it publishes) become bounded
  orphan files for that one deviceId — the accepted cost of "forget but stay armed".
  Any one trusted device can decommission for all of them; this is within the existing
  mutual-trust boundary (every approver can already unlock/wipe the protected device).
  Forget is **not** evidence that the wipe ran.
  - **Signed vs. advisory status (ACR-013).** Only the **confirmed** state is
    authenticated: it derives from a **device-signed** wipe-status, and the actual wipe
    only runs after the protected device verifies the **approver's signature** on the
    command. The intermediate **"sent · unconfirmed"** line is derived from the
    *unsigned* shared command file (an approver holds the protected device's verify key,
    not the other approvers') and is therefore **advisory only** — a backend/PAT writer
    could fabricate or clear a *pending* indicator, but cannot forge a confirmation or
    cause an unsigned wipe to execute. The UI labels the pending line "advisory".
- **Consistency under concurrency / backend faults.** All `remoteApproverFor` writes
  are serialized through an async mutex that re-reads the latest map inside the
  critical section, so the background status-refresh timer can no longer clobber a
  concurrent purge/forget and resurrect a removed device. Network I/O happens outside
  the lock. Operations are fault-tolerant: a transient GitHub error (e.g. a 5xx) on a
  registry/status read is treated conservatively (never a mass-decommission, never a
  wipe), per-device refresh failures are skipped and retried, purge/forget always
  remove the local entry even if remote cleanup partially fails, and a failed
  `sendRemoteWipe` records no false "command sent" state.

---

## 4. Cross-cutting residual risks (true in multiple scenarios)

### Trusted Computing Base (TCB) — what you implicitly trust (ACR-016)
All of this app's protections assume the code running in your browser is the code we
shipped. The following are **inside the TCB**: compromising any one is equivalent to a
full client compromise, and **no in-app control (Paranoid Mode, lock screen, wipes)
defends against it**:
- **The hosting origin (GitHub Pages).** Whoever can serve content at the app's origin
  can serve **malicious same-origin JavaScript**, which can read the DEK and all
  decrypted data while unlocked. Same-origin XSS has identical impact — hence the
  strict no-`dangerouslySetInnerHTML` posture and URL sanitization.
- **The build & deploy pipeline and dependency tree.** A poisoned dependency, a
  compromised CI step, or a tampered release artifact is full client compromise.
- **The service worker.** It is same-origin, persistent, and intercepts navigations; a
  malicious SW update is full compromise. (Updates are user-prompted and same-origin.)
- **The browser, OS, and any installed extensions.** Extensions with host access and
  local malware can read the heap while unlocked; these are **out of scope** unless
  separately mitigated (use a trusted device; that is the point of Paranoid Mode's
  "untrusted device" guidance being about *typing the passphrase*, not about defeating
  a compromised browser).

**Defense-in-depth (not a substitute for the above):** the production `index.html`
ships a **Content-Security-Policy** meta (`default-src 'self'`; `script-src 'self'`;
`connect-src 'self' https://api.github.com`; `object-src 'none'`; `base-uri 'self'`;
styles allow `'unsafe-inline'` for runtime-injected Tailwind). This raises the bar for
injected-script and exfiltration attacks but cannot stop an attacker who can replace the
served bundle itself. It is build-only (the dev server needs inline/eval for HMR).

**Backup retention caveat:** enabling Paranoid Mode stops *new* backups but does **not**
retroactively delete remote backups created earlier (while OFF). Those older plaintext
snapshots may persist in the sync repo's history until pruned/rotated. Rotate the
syncPassword and prune old backups if the earlier plaintext exposure matters.

- **Web Share Target (Android "share to GTD25").** The share target is **POST /
  share-target (multipart/form-data)**, so shared content travels in the request
  **body, not the URL** — this removes the earlier GET-in-query-string exposure
  (no shared title/text/url in browser history, the address bar, or SW URL logs).
  The service worker can't reach the encrypted store, so it **stashes the payload in
  Cache Storage** and redirects the app to consume it: **files → the E2E-encrypted
  Shared Folder**, **text/links → an Inbox task**. **Residual:** the Cache stash holds
  the shared bytes/text in **plaintext** until the client consumes and deletes it
  (best-effort `caches.delete`). On a **Paranoid + locked** device the stash therefore
  persists in Cache Storage **in plaintext until the vault is unlocked** and the app
  (mounted only when unlocked) processes it — a same-origin, device-local exposure for
  the share window. The stash lifetime is **bounded** (ACR-017): the app sweeps the
  stash on **every unlocked start** — not only on the `?shareTarget` redirect — so an
  orphaned stash (redirect lost, app next opened from the launcher) is consumed if
  fresh and **purged unconsumed after 24h**; the error path clears any partial stash
  on both the SW and client ends. The SW also **caps what it stashes** (ACR-018):
  ≤ 20 files, ≤ 30 MB per file and in aggregate (mirroring the Shared Folder quota,
  which remains the authoritative consume-time check), with skipped files surfaced to
  the user. Residual: the plaintext-until-unlock window on a locked Paranoid device
  remains. Mitigation: shares are user-initiated; unlock promptly, or don't share
  into a locked Paranoid device. (The bookmarklet capture still uses a GET
  `?capture` URL, which is scrubbed at the earliest point — ACR-004.)
- **Metadata is never protected.** Structure, timing, due dates, status, sizes,
  and device/activity patterns leak everywhere.
- **Git history + a logging TLS proxy are append-only from the defender's view.**
  Anything ever synced may be retained by an adversary; you cannot retroactively
  un-expose it. Key rotation is **forward-secret only**.
- **The diagnostics error log is local-only plaintext.** It lives in an in-memory
  ring buffer (never synced) the user can read/copy from Settings. To keep it from
  becoming a content sink, `recordError` only ever stores the text of `Error`/string
  inputs (plus a capped stack); any other thrown/rejected value is reduced to its
  type (`[Object]`), so an unexpected throw carrying an entity payload cannot leak
  its fields into the log. Messages/stacks are length-capped, and are additionally
  **scrubbed** before storage (ACR-015): GitHub tokens, `Authorization`/`Bearer`
  values, Web-Share-Target query content (`title`/`text`/`url`), and long high-entropy
  base64 blobs (keys/ciphertext) are replaced with `[redacted…]`.
- **Client-side timed/failure wipes only run when our code runs** — useless
  against an offline disk image or memory dump. The same applies to **remote wipe**
  (Scenario 8): it is delivered only while the protected app is open and online
  (locked or unlocked).
- **What runs while locked is minimal but no longer nil:** the app-wide service
  worker update detector/prompt stays mounted on the lock screen so a broken
  locked build can be refreshed without wiping. It can check public update
  metadata, ask a waiting service worker to activate, and reload; it does **not**
  access the DEK, decrypted content, syncPassword, or PAT. Same-commit service
  worker refresh signals are suppressed to avoid update-banner loops. If an update
  is detected while a Paranoid vault is **unlocked**, applying it is deferred until
  the vault is already locked; the app does **not** persist or carry the DEK across
  reloads to preserve the unlocked state. To make the lock/reload explicit, the app
  stores a short-lived, non-sensitive local marker before a Paranoid update
  (`from`/`to` build commits + timestamp only) and shows an "updated; vault locked"
  banner after the running build changes. If remote unlock/wipe is enrolled
  (Scenario 8), an always-mounted wipe watcher polls the backend mailbox
  (conditional requests) and can run `panicWipe` on an approver-signed command while
  the app is locked **or unlocked**; the lock screen separately polls for approved
  unlock responses. That remote path uses the plaintext PAT and does not read
  decrypted task content. If the optional screen-lock grace is enabled (configurable,
  default 10 min, up to 60), screen-lock events schedule an app lock instead of
  dropping the DEK immediately; system-idle events still lock normally. This is a
  convenience/security tradeoff — a longer grace keeps the DEK resident longer.
- **The two passwords have very different strength floors:** the vault passphrase
  uses Argon2id; the **syncPassword still uses PBKDF2‑600k** (kept for cross-device
  wire compatibility). The backend's confidentiality is bounded by the weaker one.
- **Forensic residue** of pre-Paranoid plaintext may persist on disk until
  storage compaction.

---

## 5. Recommendations (prioritised)
1. **Use a private sync repo** (Scenario 6/7 hinge on this).
2. **Use a fine-grained, single-repo, least-privilege, short-expiry PAT**; rotate
   it where TLS inspection is suspected (Scenario 4).
3. **Use a strong syncPassword** (the backend's only content protection;
   PBKDF2‑600k + offline oracle ⇒ weak passwords fall — Scenario 7).
4. **On untrusted machines, enable Paranoid Mode and unlock with a security key**
   (keylogger- and at-rest-strong; Scenarios 2/3/5). **Enroll a backup authenticator**
   (a second hardware key, or a phone over hybrid transport) so a missing primary key
   never forces you back to typing the passphrase. Prefer a hardware key as the
   primary factor; treat a Google-synced phone passkey as a softer, cloud-recoverable
   convenience factor (Scenario 5). Remove lost/retired keys promptly.
5. **Keep the idle/auto-lock window short** and lock before stepping away
   (Scenario 3). If you enable the screen-lock grace (configurable, default 10 min,
   up to 60), understand that GTD25 may remain unlocked in browser memory for the
   whole grace — prefer the smallest value you can tolerate.
6. **Do setup / passphrase changes on a trusted device** (Scenario 5).
7. Treat a complex passphrase as essential; a low-entropy one is the limiting
   factor for the disk-seizure case (Scenario 2).
8. **Encrypt manual ZIP exports** (Export → passphrase or sync password). An
   unencrypted export on disk is plaintext content + metadata (Scenario 2).
9. **If you enable remote unlock/wipe** (Scenario 8): pick only devices you fully
   control as approvers, confirm the fingerprint at enrolment, never approve an
   unlock prompt you did not initiate (and check the verification code), and accept
   that the PAT is plaintext at rest while it is enabled (use a least-privilege PAT).
   Wipe confirmations are best-effort; a pending command may still have wiped the
   device if it lost network before writing the signed status.

## 6. Summary matrix (content confidentiality)
| # | Threat | Paranoid OFF | Paranoid ON |
|---|---|---|---|
| 2 | Disk imaging | 🔴 plaintext + creds | 🟠 to passphrase/key strength; metadata leaks; forensic residue (⚠️ PAT plaintext if remote unlock/wipe enrolled — Scenario 8) |
| 3 | Memory dump | 🔴 | 🔴 if unlocked; 🟠 if locked (not guaranteed) |
| 4 | TLS interception | 🟠 content safe (sync key); PAT+metadata exposed | 🟠 same (identical wire) |
| 5 | Keylogger | 🟠 syncPassword/PAT captured | 🟠 passphrase captured; 🟢 if security-key-only & untyped |
| 6 | Repo name, no PAT | 🟢 if repo private | 🟢 if repo private |
| 7 | Backend readable | 🟠 content to syncPassword strength; metadata fully exposed | 🟠 same (no effect) |
| 8 | Remote unlock/wipe (opt-in) | n/a | 🟢 unlock is forward-secret vs disk+backend; ⚠️ PAT plaintext at rest; approver holds RUK (approver+disk = DEK); wipe = recoverable DoS with best-effort signed confirmation |

---

## 7. Keeping this document updated
Whenever a change affects the security posture — cryptography, key derivation,
what is encrypted vs. plaintext, storage locations, the sync/wire format, auth/PAT
handling, the lock/unlock or wipe flows, backups, or what runs while locked — this
file MUST be updated in the same change, and the user MUST be told what changed and
which prior threat-model conclusions it affects.
