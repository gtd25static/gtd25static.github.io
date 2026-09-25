# GTD25 — Security Review & Threat Model

**Last updated:** 2026-09-25 (**Turning Paranoid Mode off with the app open in another tab no longer leaves rows nothing can decrypt.** (1) **The disable destroyed the key while other tabs still held it.** It told the app's other tabs nothing: an unlocked second tab kept its DEK and went on encrypting what it wrote — the Focus refill alone does so within a minute, with nobody touching that tab — under a key whose vault row the disable had just deleted. Those rows could never be decrypted again (**data loss**), and on the next load a list holding one crashed the whole app. The disabling tab could do the same to itself: a background write landing in a table the decrypt pass had already done was encrypted under the key about to be destroyed. Now the disable tells the other tabs to **lock before the first row is decrypted** and to **reload once Paranoid Mode is off**; the at-rest key is only *active* while the Paranoid flag is up (`getActiveAtRestKey`), so once it is down no path — the middleware, the callers that encrypt rows themselves before storing them, the shared-blob cache, the safety backups — encrypts anything, even in a tab that missed the signal; the disable lowers the flag **before** deleting the vault and runs a second decrypt pass in between, which picks up whatever was encrypted while the first pass ran; and a tab still holding a key while the flag is down refuses to store at-rest ciphertext at all (which catches a row encrypted in memory just before the flag went down). A crash between lowering the flag and deleting the vault leaves vault-without-flag, which the boot reconcile already turns into a lock screen whose unlock resumes the disable. The decrypt pass now rewrites only rows that were still encrypted. **Residual:** a write whose rows were encrypted in memory before the flag went down and reach IndexedDB after the second pass read that table is refused — lost, not left undecryptable; a tab that locked for the disable and is unlocked again before it finishes resumes the same disable concurrently (both passes are idempotent); delivery of the tab signals is still not guaranteed (a frozen tab), which is what the flag check and the second pass are for. **Impact on prior conclusions:** Scenario 1's "turning it on or off" guarantees now also hold with several tabs open, not only for a tab dying mid-way; nothing changes about what is encrypted, the wire format, or the lock/wipe flows. Rows already lost this way before the fix cannot be recovered from this device — a synced copy on another device, if any, is the way back. (2) **Rows an older disable left encrypted no longer crash the app.** They keep their plaintext metadata but have no title or name, and code comparing titles threw — at every start when two of them shared a due date (the attention list, so the app could not be opened at all), on opening their list (merge suggestions), in search, in sort-by-name and in the mindmap browser. Those places now tolerate a missing title/name; the rows stay as they are on disk (their key no longer exists) and can still be deleted. No security property changes. (3) **Enabling Paranoid Mode reloads the app's other tabs.** An open second tab (holding no key) went on reading the rows as the enable rewrote them, got ciphertext back and crashed. The enable now tells the other tabs to reload once the flag is up and before any row is rewritten, so they come back at the lock screen; its writes were already refused meanwhile (locked writes fail closed). Unlocking such a tab while the enable is still running resumes the same enable concurrently (idempotent). (4) **A trailing space no longer walks a correct passphrase toward the attempt wipe.** Enable and every change of passphrase have stored it trimmed since the first version (the first vault commit already trimmed; the secondary passphrase has been trimmed since it existed), but the lock screen, the passphrase confirmation prompt, the Check and the re-key compared it exactly as typed — so a trailing space, which phone keyboards add, read "Incorrect passphrase" and **counted as a failed attempt toward the wipe**. Every verification path now tries the passphrase exactly as typed and, if that fails and trimming changes it, trimmed — one attempt either way (one count, one unlock-log entry), slot 1 before slot 2 for each, so the secondary passphrase behaves the same and a vault with or without one does the same work. A re-key or KDF upgrade re-wraps under the passphrase that matched, never the stray whitespace. **Impact:** no weakening of the brute-force economics — the accepted set grows only by whitespace around the real passphrase, and an attempt with surrounding whitespace costs up to two derivations instead of one (slower for a guesser, not faster); the tripwire still counts every wrong attempt exactly once. The timing of an attempt now depends on whether the typed text has surrounding whitespace — a property of the input, not of the vault. (5) **After a panic wipe whose deletion had to be finished at the next boot, the app could not save anything.** The wiping page's own open transactions (or a second tab) block the IndexedDB deletion, so the wipe-pending marker survives the reload and the boot-time retry runs; it closed the database the way that also disables auto-open, and the app then rendered on that closed instance — every read and write failed until a second manual reload. The retry now closes it leaving auto-open on, so the database comes back empty on first use (behind the deletion, if another tab still blocks it). The in-page wipe still closes it for good, so nothing in the page being wiped can recreate the database before its reload. Availability only: the wipe itself was never less complete. **Residual:** with a second tab open the tabs can reload each other once more before settling (each boot-time retry signals the others), as before. (6) **Sync: wipe, import and backup restore now reach every device, or nothing.** They used to *delete* the remote changelog; a later guard refuses to sync from "a snapshot but no changelog" whenever a device holds data, so after any of them every device reported "Remote data corrupted" and **the other devices kept everything the wipe or restore was meant to replace** (and could push it back). Separately, once the sync-key cache had expired (30 min idle / 5 min hidden), Wipe and Import changed only this device while reporting success. Now the changelog is reset to `[]`, never deleted (repos left without one are repaired when their snapshot carries `wipedAt`); `wipedAt` stays in the snapshot for good so a device offline through the reset still adopts it; each device adopts a given reset **once**, recorded as `syncMeta.lastWipeSeenAt` (a device-local timestamp, no content), so a device whose clock runs behind no longer re-adopts it on every sync; the adopting device keeps only its own pending edits made after the reset and takes a local safety backup first; and the three operations resolve the sync key first — re-derived from the stored password (in Paranoid Mode from the vault secrets, i.e. only while unlocked) and checked against the remote verifier — **changing nothing anywhere** when no usable key is at hand. **Impact:** strengthens the expectation that "Wipe All Data" / a restore propagate to every synced device (they did not, in the cases above); nothing changes about what is encrypted, the wire format, or who holds keys. **Residual:** a device that never syncs again keeps what it had — as before, only syncing propagates a wipe. (7) **Sync data-loss paths closed, no crypto change:** a changelog 409 whose retry then failed (5xx, network) re-sent the stale content with the fresh sha and deleted other devices' entries; a snapshot or changelog over 1 MB was read as empty (GitHub's Contents API does not inline it) — it is now fetched from `/repos/{repo}/git/blobs/{sha}` with the same token on the same host (the CSP is unchanged); a delete now loses only to a newer restore, the same rule on every device; wipe/import/restore/force push/pull wait for a sync in flight instead of silently doing nothing. (8) **Linking a device that already holds content asks before replacing it — and is deliberately not a merge.** After a secondary-passphrase unlock the device looks like one that never synced (Scenario 3b), so a merge on linking would upload what was created in that session into the real repository; a merge was briefly implemented and the e2e suite (secondary-passphrase F) caught exactly that before release. The question ("This device already has N lists, M tasks …") is generic and appears on any never-synced device with content whose repository already holds data, so it is no tell; re-linking the decoy device still replaces its content with the real one, as Scenario 3b describes. (9) **Warnings (`hasWarning`) are stored as `1` instead of `true`** so IndexedDB can index them (Attention never showed a warning since March); the field was and remains plaintext metadata at rest and on the wire — value type only, no exposure change. (10) **Changing the sync password now takes over the screen until it finishes.** A modal dialog above everything (Settings included) that Escape can't dismiss, a browser prompt before the page is closed or reloaded, and — on a Paranoid device — the idle auto-lock deferred for the rotation's duration (re-armed every 15 s), because a lock mid-way drops the credentials the rotation needs and leaves it half done (recoverable, but alarming). **Impact:** an unattended Paranoid device can stay unlocked for as long as a rotation runs — its content covered by that dialog; bounded, since every GitHub request times out after 15 s and a failed rotation closes the dialog and restores the idle lock. A manual lock, the lock hotkey and lock-when-hidden still lock at once (they interrupt the rotation, which the next save of the same password completes).)

**Previously updated:** 2026-09-22 (**Every wrap of the DEK is now bound to its slot, and key management needs the passphrase.** (1) **The vault row was unauthenticated, and the two passphrase slots were interchangeable.** Each wrap of the DEK was AES-GCM under its KEK with nothing saying which slot it belonged to, so anyone able to rewrite the `vault` row of a locked device (a seized disk that is later returned, or anything running in the page) could swap `dekWrappedByPass` and `wrappedDek2`: from then on the **real passphrase ran the secondary-passphrase re-init over the real content**, and the **secondary passphrase opened the real content as an ordinary unlock** — the exact inversion the coerced-unlock feature exists to prevent, at the cost of a row swap. Every wrap (slot 1, slot 2, each security key's, the remote-unlock key's) now carries its slot as AES-GCM additional data, so a wrap moved to another slot fails to open there: a swapped row reads as two wrong passphrases (counted toward the tripwire like any other), and nothing is re-keyed. Wraps written before this change still open from any slot and are rewritten bound the next time the app holds the KEK that opens them — slot 1 at the next passphrase unlock, a security key's at its next unlock, the remote-unlock wrap at its next use, slot 2 the next time the secondary passphrase is set or removed (or at a re-key). **Residual until then:** a secondary passphrase set before this date keeps an unbound slot 2, and with it the swap exposure for that one slot — set it again to close it (Scenario 3b says the same). (2) **`confirmCurrentPassphrase`**, the gate the security settings will stand behind: accepts exactly the main passphrase (the secondary one is refused like any other and reads the same), derives it as the lock screen does, and acts on nothing — no write, no failed-attempt count, no unlock-log entry, no tab signal; it needs an unlocked vault and withholds its answer if the vault locks mid-check. Removing a security key now requires an unlocked vault, which it did not. (3) **The DEK is no longer for life.** It was minted once when Paranoid Mode was enabled and never rotated: changing the passphrase, removing a security key, turning remote unlock off or revoking an approver only re-wrapped or dropped a *wrapper* of the same key, so anyone who ever held it — an old disk image plus the passphrase of that time, a security key since removed, a trusted device since revoked, a memory dump of an unlocked session — kept reading everything this device wrote afterwards, in any later image. A **re-key** (`rekeyVault`; Settings → Security, and the default when the passphrase is changed) mints a fresh DEK and rewrites every content row, the changelog and the vault row under it in one transaction (all crypto in memory first — the same shape as the secondary-passphrase re-init), with a new salt and Argon2id, the sync secrets carried over, slot 2 re-randomised (the secondary passphrase must be set again; the UI says so to everyone, whether or not one is in use), every security key dropped (each would need a touch to re-wrap; the count is reported), remote unlock re-wrapped under the same remote-unlock key (approvers unaffected — revoking one is `removeApprover`'s job, which rotates that key), the shared-blob cache dropped, and the safety backups replaced by one fresh copy under the new key. It needs the current passphrase (the secondary one is refused like any other wrong one, and neither counts nor logs), locks the other tabs first and reloads them after, ends this tab's sync session and shows a wait screen instead of the app meanwhile, and refuses if any row is unreadable with the current key or an enable/disable is still pending. Interrupted, it rolls back to the old key (tested). **This is post-compromise security, not forward secrecy** — what was copied stays readable to whoever holds the copy and its key; see the new §4 subsection. **Impact on prior conclusions:** Scenarios 2, 3 and 8 gain a recovery step after a suspected key exposure (before, the honest answer was "re-enable Paranoid Mode from scratch"); Scenario 3b's slot 2 is re-randomised by a re-key; nothing changes about what is encrypted, the wire format, or the lock/wipe flows. (4) **The gate is in front of every change to how the vault opens.** Adding or removing a security key, setting or removing the secondary passphrase, changing the failed-attempt wipe limit, turning Paranoid Mode off, and enrolling, removing or turning off remote-unlock approvers now ask for the passphrase (the change-passphrase form and the re-key have their own field), so an unlocked session left unattended — the screen-lock grace runs up to 60 minutes, doubled by Relaxed unlock — is no longer enough to add a way in or take a control down. The secondary passphrase does not pass the gate and reads like any wrong one. After removing a security key the app offers the re-key on the spot, with the passphrase just typed. Not gated, deliberately: locking, the panic wipe, the idle timers, the extras, the passphrase Check, Verify and exports. One side effect worth stating: a toast fired while the app shell is unmounted — the re-key swaps it for a wait screen — now waits up to 5 s for the next shell instead of being dropped; a toast older than that still is, so nothing from before a lock surfaces after the unlock. (5) **Changing the sync password now rotates the whole repository — it used to break the Shared Folder and leave half the repo under the old key.** The old flow derived a new key and force-pushed the snapshot and an empty changelog under it, and stopped: every Shared Folder blob on `gtd25-blobs` stayed under the old key, so **every shared file became unreadable on every device** (a data-loss bug, not only a rotation gap); the three tier backups stayed under the old key for up to a week; the force push itself wrote the old snapshot, under the old key, to the migration backup file; the device registry's MACs (derived from the old password and salt) stopped verifying, so approver discovery and invite verification broke until each device happened to republish; and the pre-rotation history stayed reachable until the monthly squash. `rotateSyncKey` (`src/sync/key-rotation.ts`) now runs behind the settings form's password change, after a confirmation that says other devices must have synced first: it syncs under the old key, pins the new salt and a verifier of the new key in `syncMeta` so a retry rotates to the same key and refuses a different password, rewrites every live shared blob under the new key as **one root commit** of the blob branch (dangling objects until its single ref update, so nothing changes if it dies before), then — the commit point — caches the new key, stores the new password and force-pushes the snapshot **without** the old-key migration copy; then deletes the migration backups, rewrites the three tiers, re-MACs this device's registry entry, squashes the default branch on the spot and forgets the pin. Interrupted anywhere, saving the same new password again completes it; a shared file neither key opens is kept and reported, never dropped. Every other device republishes its registry entry when it adopts the new password (the password prompt does it; approver devices also do it whenever the cached salt changes). **Impact on prior conclusions:** Scenario 7's "rotation is forward-secret only" was both wrong in its terminology and optimistic about its scope — it is post-compromise security (§4), and it now actually covers the repo; the honest limit is unchanged: a clone or proxy log taken before, and GitHub's own garbage-collection schedule for unreachable objects. Not in this change: the registry MAC key is still the same PBKDF2 output as the content key imported as HMAC — a key reuse across primitives that a later change should separate with its own versioning, since fixing it invalidates every entry at once. (6) **Smaller things a review of the same area turned up.** The app's OS notifications — nudges quote task titles — were closed only by the secondary-passphrase re-init; a lock and the panic wipe now close them too (the OS's own notification history stays out of reach, as Scenario 3b says). The "wipe this device" escape on the sync-password prompt deleted the database by hand — no retry marker, a hang behind a second tab, Cache Storage, sessionStorage and the service worker left behind — and is the panic wipe now. The Paranoid panel's *Download recovery backup* wrote a plaintext zip to Downloads without asking, the one export that did not go through the export dialog; it does now, encrypted by default, plaintext only by choice, which retires the "still plaintext by design" line in Scenario 2. And the raw Argon2id output is zeroed once it has been imported as the (non-extractable) KEK, instead of lingering in the heap.)

**Previously updated:** 2026-09-22 (**Turning Paranoid Mode on or off survives the tab dying — and the safety backups around it.** (1) **An enable interrupted mid-encryption left the device looking un-Paranoid over rows it could no longer read, and a second enable then destroyed them.** The flag (`localStorage`) was raised only after every row had been rewritten, so a tab killed during the migration reloaded with no lock screen: the app ran un-Paranoid, the rows already encrypted showed blank, the PAT/sync password were still plaintext in `localSettings`, and the pre-existing plaintext safety backups were never purged. The only way out the UI offered — enabling again — minted a new DEK over the saved vault, and the rows encrypted by the first attempt became permanently unreadable (reproduced in a test before the fix). Now the flag goes up right after the vault is saved and before any row is touched, so a dead tab comes back at the lock screen and the unlock resumes the whole enable (encryption, then the credential strip, then the backup purge); an enable refuses to replace an existing vault; and a boot-time reconcile makes the flag agree with the vault in both directions (a vault saved just before the flag, and a flag left behind by a disable that had already deleted the vault, which otherwise stranded the app at a lock screen no vault could answer). Verified in Chromium by killing the tab mid-migration over 1500 rows. **If you ever saw blank lists after enabling Paranoid Mode and enabled it again, the content encrypted by the first attempt is gone from that device** — recover it from sync or another device. (2) **Disabling left the encrypted safety backups behind under a destroyed key**: listed, unrestorable, with a misleading "unlock the vault" error. The disable now rewrites them as plaintext while the key still exists (the rest of the database goes plaintext in the same step). (3) **"Download" on a safety backup wrote a plaintext zip to Downloads, even from a Paranoid device**, without asking; it now goes through the export dialog — encrypted by default in Paranoid Mode, plaintext only by explicit choice.)

**Previously updated:** 2026-09-22 (**Checking the secondary passphrase without using it.** Settings → Security → *Secondary passphrase* gains a **Check** field: type a passphrase and it says whether it is the main one, the secondary one, or neither — derived exactly as the lock screen would (same salt + KDF, slot 1 then slot 2, no trimming) but **never acted on**: no unlock, no re-key, no write of any kind, no unlock-log entry, no failed-attempt count, no tab signal. It exists so the user can confirm the secondary passphrase still works (e.g. after a main-passphrase change) without destroying the real data on this device to find out. **Impact on prior conclusions (Scenario 3b):** the "no way to query whether a secondary passphrase is set" property **holds** — the answer needs the passphrase itself, and a wrong guess reads the same whether slot 2 is in use or garbage. **New residual:** anyone holding an *unlocked* session gets a guess oracle for the secondary passphrase that is **not rate-limited and not logged** (each guess costs one full Argon2id derivation — the same as a lock-screen attempt); the lock screen's failed-attempt tripwire does not apply because the vault is already open. Against coercion it changes nothing: the lock-screen path is untouched, and a lock during a check suppresses its answer so it never surfaces on the lock screen. Also new: `e2e` now greps the built `dist/` for telltale vocabulary on every run, instead of by hand.)

**Previously updated:** 2026-09-20 (**Archiving lists — one new plaintext field and a scheduled destructive action.** Lists of both types can now be archived: `taskList.archivedAt` (a timestamp, absent = active) joins `deletedAt` in the always-plaintext metadata set, on the wire and at rest. It is **not** content — the list's `name` stays encrypted — but a backend reader now learns *which* lists you archived and *when*, and can tell an archived list from a live one without the key, the same exposure `deletedAt` already had. The new part worth stating plainly: this plaintext field **drives an automated deletion**. At startup, any list archived more than 12 months ago is soft-deleted into the Trash (cascading to its tasks and subtasks, recorded in the changelog so the deletion syncs), and the existing 30-day purge then hard-deletes it. So an attacker with **write** access to the backend — already able to destroy data by flipping `deletedAt`, which is equally unauthenticated — gains a quieter variant: back-dating `archivedAt` makes the *victim's own device* delete the list at its next start. No new capability class (see Scenario 7's least-privilege PAT recommendation), and the 30-day Trash window plus local backups remain the recovery path. Nothing else moved: no change to key derivation, the lock/unlock flows, SYNC_VERSION, or what runs while locked, and the section's device-local collapsed/expanded flag is a single boolean in `localStorage` — no names, never synced.)

**Previously updated:** 2026-09-20 (**Paranoid Mode review — controls that were not actually armed, and metadata the doc said was hidden.** Contrasted every claim in this file against the code. (1) **Four controls promised something they were not delivering.** Shared-folder blobs escaped the "locked writes fail closed" guarantee: `sharedBlobs` is binary, so it is not a middleware-handled table, and the cache keyed off the live DEK and fell back to writing plaintext — a lock landing mid-download (the phone backgrounding the app is enough) wrote file bytes to disk unencrypted. Saving sync settings cleared the plaintext PAT that remote unlock/wipe needs while locked, silently disarming **remote wipe** while Settings still read "Enabled". The failed-attempt wipe read `?? 0` — disabled — on any vault enabled before the setting existed, while Settings showed it armed at 10. The system idle lock could be permanently inert, its whole start path inside a catch that returned a no-op, with the toggle still on. All four fixed; the attempt wipe now self-heals to the default and says so once. (2) **The remote-unlock ceremony left loose ends:** abandoning a request (you unlocked another way) kept the ephemeral session key K resident for the life of the page, across later locks, with the ceremony files still in the repo; the ACR-001 digest binding rejected swapped requests in **silence**, so an active substitution attack looked like a normal approval; and only the passphrase path logged failures, leaving the audit trail tamper-evident for one unlock method out of three. (3) **Approver revocation did not exist** — this file claimed it did. It does now, and it rotates the RUK; the honest limit is that a disk image taken *before* the removal stays openable. Fixing it surfaced a latent bug: the approver side discarded any re-issued invite, so any re-key silently failed to land. (4) **`fieldTimestamps` shipped in the clear**, naming the encrypted fields of every record and when each changed — which falsified two claims here. It is encrypted as of **SYNC_VERSION 7**; a device on an older build refuses to sync until it updates, and nothing is migrated or deleted. (5) A pre-release reliability pass on all of the above caught three more, now fixed: the **"update required" gate covered only reads**, so an un-updated device's Force push (or ZIP import, backup restore, or changelog compaction) would have overwritten a newer remote and deleted the changelog — the one path in this release that could have destroyed another device's data; the new clipboard `pagehide` flush **fired on every later pagehide**, wiping a clipboard the app never owned; and counting a failed *security-key* unlock toward the wipe was wrong, because an enrolled credential can return different PRF output after an authenticator reset or on another device holding the same synced passkey. (6) Smaller: decrypted bytes survived a lock in a 60s object URL and in the clipboard auto-clear's closure; the share stash's 24h TTL was only enforced while unlocked; toasts rendered above the privacy veil; mindmap rows that failed to decrypt came back with no label; `img-src` allowed any https host. (7) **This document was overstating protection** in three places, now corrected: the PAT and this device's identity private keys are plaintext at rest while remote features are enrolled (structural — a locked device must reach its mailbox), `localSettings`/`syncMeta`/`pomodoroSounds` have no at-rest encryption at all, and `starred`/list type/custom snooze were never listed as plaintext.)

**Previously updated:** 2026-09-10 (**Secondary passphrase reliability review — and locked writes now fail closed**: (1) **Changing the main passphrase silently disabled the secondary passphrase.** The re-wrap picked a fresh salt, so slot 2 (wrapped under a KEK from the old salt) could no longer open: the secondary passphrase then read as a *wrong* passphrase and counted toward the failed-attempt wipe — exactly at the moment of coercion, with nothing in the UI to notice (by design there is no "configured" flag). The re-wrap now keeps the vault's salt + KDF (only a legacy PBKDF2 vault still moves to Argon2id), and a secondary passphrase can no longer be set on a legacy vault, whose unlock-time KDF upgrade would orphan it the same way. **A secondary passphrase set before this fix on a device whose main passphrase was later changed, or whose vault was upgraded from PBKDF2, is dead and must be set again.** (2) **The re-init left traces outside its transaction**, now destroyed right after the commit: the encrypted safety backups (unreadable under the destroyed key, but listed with their dates and failing to restore — a tell), a share stashed while locked (plaintext, and offered by the share prompt right after the unlock), the diagnostics log (sync activity, remote file names), sync bookkeeping in `localStorage`, the real repo name, the device id stamped on every real change, the remote-unlock identity, unlock-log entries for methods the vault no longer has, and the app's OS notifications (nudges quote task titles). The decoy's shared files now describe their dummy bytes (size, `text/plain`) instead of a real size/type that no longer matches. A failed re-key is logged under a neutral label. (3) **Other tabs and in-flight work:** a secondary unlock now locks the other tabs before re-keying and reloads them once the swap is on disk; a lock arriving mid re-key can no longer copy undecrypted rows into the new vault; locking ends the sync session (the operation in flight is aborted before any further local write, cached credentials are dropped) and clears in-memory UI state that could name real content (search text, a pending nudge). A remote backup already waiting out its random delay when Paranoid Mode is enabled — or the vault locks, or is re-keyed — re-checks before reading and pushing, instead of pushing whatever the device holds by then over the real remote backups. Rows the vault could not decrypt are no longer offered as merge suggestions (they all read "⚠︎ unreadable", looked like duplicates, and merging would have destroyed a row still recoverable by re-syncing). (4) **Locked writes fail closed — affects every Paranoid device, not only the secondary passphrase.** The at-rest middleware passed writes through untouched when it had no key, and the sync layer's pre-encryption also returned rows as-is without one; a sync still running when the vault locked could therefore write real remote content to IndexedDB **in plaintext**. With Paranoid Mode on and the vault locked, a write that would store plaintext content is now refused (deletes, already-encrypted rows and the disable migration's explicit bypass still pass). This closes a hole in Scenario 2's "content encrypted at rest" for the window between a lock and the end of an in-flight sync. (5) **The sync-password prompt stored the password in plaintext `localSettings` even on a Paranoid device** (and looked for the PAT there, where a Paranoid device never keeps it, so the prompt could not verify on such a device); it now stores the password in the vault like Settings → Sync does. See Scenarios 1 and 3b. Earlier 2026-07-29 — **Share into a locked vault — the hold is now visible, presence-only**: a share received while Paranoid Mode is **locked** was already stashed by the service worker and filed only after unlock, but the lock screen said nothing about it, so sharing into a locked app looked like it had silently failed. The lock screen now shows a **content-free** notice that a share is being held: it reads the stash's **timestamp only** — never title, text, url or filenames — so nothing shared is rendered before the vault is open, and it probes with `caches.has` so no cache is created on a device that never received a share. **Nothing changed about what is stored, where, or for how long:** the plaintext Cache-Storage stash, its 24h TTL + unlocked-start sweep (ACR-017) and the SW stash caps (ACR-018) are exactly as before, and the destination prompt still resumes on the next unlocked mount whichever unlock path (passphrase, security key, remote unlock) was used — a prompt interrupted by an idle re-lock also returns after the next unlock. **New, small disclosure:** someone holding the locked device can now see *that* something was shared into it (never what) — the same class of content-free signal as the locked unlock-nudge. Earlier 2026-07-27 — **Reliability pass — data-loss guard, encrypted safety backups, clock-skew detection**: (1) the "remote has a snapshot but no changelog" branch adopted the remote **without checking whether this device had data**, clearing the local tables and the pending changelog — silent loss of unpushed work whenever `gtd25-changelog.json` was missing (deleted, restored repo, interrupted setup). It now refuses and reports, changing nothing on either side. (2) The device-local safety copy is now taken **before every destructive path** (adopt-remote, restore, import), covers **mindmaps**, and on a **Paranoid device is created and encrypted** with the at-rest key instead of skipped — see Scenario 1 for what that second at-rest copy costs. Failures to write it are recorded instead of a console warning. (3) Every merge is LWW on the writer's `Date.now()`, with **no defence against a wrong device clock**: a device running ahead won every field comparison and silently dropped other devices' edits. The `Date` header of each GitHub response is now compared against the local clock; past 5 minutes it records a diagnostic and warns once per session. Stamps are NOT rewritten — that would break convergence. (4) A schema upgrade by another tab left this tab's database closed and every query failing with only a console warning; it now says so and offers a reload. Also today: **Multi-tab: locking is now app-wide**: the DEK is a per-context module variable, so locking (hotkey, idle timeout, lock-when-hidden) used to drop it **only in the tab that ran it** — a second forgotten tab stayed unlocked and readable with its own idle timer. A same-origin `BroadcastChannel` now propagates lock and wipe to every tab; it carries **signals only**, never key material, and has **no unlock signal by design**, so every message can only reduce access. A wipe additionally makes other tabs reload, closing the IndexedDB connections that block the deletion. Separately, `syncNow` now takes a cross-tab **Web Lock** so two tabs can't push the same pending changelog entries at once (never corrupting — entries are id-keyed and idempotent — but it burned API calls and tripped the 409 retry). See the LOCKED and panic-wipe entries in Scenario 3. Also today: **Capture protocol handler + capture link validation**: the manifest registers `web+gtd:` so the desktop bookmarklet can launch the installed app (Chrome refuses to capture `window.open` into an app window, which is why link handling alone did nothing). The payload lands in `?protocol=`, goes through the same sanitiser as `?capture` and is scrubbed from the address bar on the same ACR-004 path; no new capability, since any site could already navigate to `?capture`, though a link can now surface the app window and the browser gates the first protocol launch behind a permission dialog. Hardened while there: a captured `url` is stored as a task link **only if it is http(s)** — `javascript:`/`data:` values are dropped at capture time rather than trusting the render-time href sanitiser alone. Also today: **Privacy screen retimed — background-only, half the remaining idle**: the blur veil no longer raises the instant the app backgrounds, nor when it merely sits idle in the foreground. It now needs **both**: the app in the background (hidden tab or unfocused window) **and** half of the time that was still left before the auto-lock burned away. Net effect on posture — a foreground-but-unattended screen is **no longer covered**, and the delayed veil **cannot blank mobile task-switcher previews** (that snapshot is taken as you leave); a new device-local sub-setting, **"blur the moment it goes to the background"** (default off), restores both the old timing and the blanked preview. Dismissing while still in the background now restarts the countdown, closing a hole the retiming would otherwise open (one mouse move over an unfocused window would have disabled the veil indefinitely). Nothing about the auto-lock, the DEK, or what is stored changes — the veil was and remains deterrence over a DOM that still holds plaintext. See the Privacy screen entry in Scenario 3 for the full statement. Also today: **Mindmap outline import — tolerant parser + clipboard read**: the "Import outline" parser now accepts real chatbot markdown (`#`/`##` hierarchy, `-`/`*`/`+`/`1.` markers, `---` rules, tab- or space-indented outlines with no bullets). Still a **pure string parser** — no eval, no DOM, no network — under the same 2 MB / 2000-node / 1000-char caps, and the imported text lands in the same encrypted `mindmaps`/`mindmapNodes` tables as hand-typed nodes. Two posture-relevant details: (1) the indent scan is hand-rolled instead of `/^[ \t]*-\s/`, removing a **quadratic-backtracking (ReDoS) path** that a pasted megabyte of leading whitespace could have triggered — a local self-DoS only, now linear; (2) the dialog gains a **"Paste from clipboard"** button (`navigator.clipboard.readText()`, explicit user gesture, never auto-read on open) — the same clipboard-read capability Quick Capture and the Shared Folder already use, so no new permission class; failures are recorded in the redacted diagnostics log as `mindmapImport.clipboardRead` with no clipboard content. Same day, the device-local `gtd25-mindmap-ui` key gains **one boolean** — whether new maps start with smart colouring on — alongside the collapse ids and colour presets already documented there; no content, same panic-wipe sweep. Previously (2026-07-24): **Redact-mode coverage fix + unlock-audit alert**: (1) redact mode flagged the app-shell `<div>`, so its CSS rule could never reach top-layer dialogs, portalled menus or the drag ghost (browser-verified `filter: none`), and the always-visible reminder strips were never tagged at all — the flag moved to `<body>` and the sweep widened from 10 to ~40 components; residuals (native tooltips, focused fields) noted in the Redact-mode entry. (2) Failed unlock attempts since the last successful unlock now raise an **acknowledgeable dialog** instead of an auto-dismissing toast, listing each attempt's time and method; a clean unlock stays a quiet toast. Neither changes what is stored, synced or logged — the unlock log itself is unchanged. Earlier today: **CSP + Argon2id incident fix, persistent diagnostics, sync-key self-heal, image preview/copy**: (1) `script-src` gains **`'wasm-unsafe-eval'`** — WebAssembly-only eval, required by the Argon2id KDF; since ACR-016 (2026-06-09) every argon2 path had been throwing in production (secondary-passphrase setup broken, vaults upgraded to Argon2id during 06-05→09 unable to passphrase-unlock, the PBKDF2→Argon2id upgrade rejecting successful unlocks — now fail-safe and recorded). See the TCB section for the residual. (2) The **diagnostics log persists** in redacted plaintext localStorage, capped 100 entries / 7 days, swept by panic-wipe. (3) The **sync-key cache expiry keeps the salt** (public material) so the key re-derives on demand from the stored password — blob operations between syncs no longer fail with NO_SYNC_KEY after the 5/30-minute cache drop; the key-at-rest posture is unchanged. (4) Shared Folder **images preview in-page** (object URL, revoked on close) with **Copy** routed through the clipboard-hygiene wrapper, so the Paranoid auto-clear extra applies to image copies like text. Also today: **Web Share Target — destination prompt**: shared content is no longer auto-routed (files → Shared Folder, text → Inbox); the app now **asks the user** whether to file the share as an **Inbox task** or into the **Shared Folder**. A shared file's bytes always land in the E2E-encrypted Shared Folder — choosing Inbox additionally creates a task pointing at the file — so **no new plaintext-at-rest surface** is introduced; both destinations were already encrypted stores. The plaintext Cache-Storage stash now also waits for the **user's answer**: an unanswered or postponed prompt keeps the stash for the next unlocked start, **within the same 24h TTL + ACR-017 sweep** — the worst-case plaintext window is unchanged. No change to cryptography, the wire format, the SW stash caps (ACR-018), or what runs while the vault is locked. Earlier 2026-07-23: **Web Share Target file save — startup race fix**: sharing a photo/file into the app on Android could fail with "Failed to add shared file" because the share-target **consume runs at app startup**, before the async initial sync has derived+cached the sync key — and saving a Shared Folder file uploads its blob **through sync**, so `uploadSharedBlob` threw `NoSyncKeyError`/"Sync is not configured". The consume now **waits for sync readiness** (`canUploadSharedBlob` = credentials present + sync key cached) before saving files, and if sync never comes up (offline) it **keeps the stash and defers the whole payload** to the next unlocked start rather than dropping the file. **Security note:** this can keep the plaintext Cache-Storage stash across app opens until a successful consume, but **within the same 24h TTL + ACR-017 sweep** — the worst-case plaintext window is **unchanged**. No change to cryptography, the wire format, or what runs while the vault is locked. See "Web Share Target". Earlier 2026-07-23: **Mindmap smart colouring (opt-in, per map)**: a toolbar toggle that, while on, auto-colours nodes **at creation time** — each direct child of the root opens a new **branch** with its own colour, and everything created below a branch **inherits** the branch's colour, so each branch off the root reads as one colour. First branches reuse the five **theme-aware presets**; once those run out, overflow branches get **synthesised fixed-hex** colours (golden-angle hue rotation for non-repeating spread) — the same class as the user's saved custom palettes (validated `#rrggbb`, **do not adapt to dark mode**). New **encrypted** field `mindmap.smartColoring` (a boolean, added to `SENSITIVE_FIELDS.mindmap`; **no SYNC_VERSION bump** — additive + per-field LWW, same reasoning as `mindmap.background` and the node-formatting fields, including the transitional "an old build re-uploads it as plaintext until updated" residual — here only a boolean, never a name/label). The colours themselves are the **existing** per-node formatting fields, already encrypted and validated on write and render, so smart colouring adds **no new render surface**. No change to cryptography, key handling, storage, the wire format, or the lock/wipe flows. See "What is encrypted vs. always plaintext" → Mindmaps. Earlier 2026-07-22: **Paranoid extra: secondary passphrase / coerced-unlock re-init (opt-in)**: an optional second passphrase that, entered at the lock screen, looks like a normal unlock but atomically re-keys the device to **placeholder content** (structure — ids/refs/order/status/timestamps — preserved, all sensitive text replaced), drops sync credentials, and makes the secondary passphrase the device's real one (the original stops working). LUKS-style **two-slot** vault (slot 2 ALWAYS present, garbage when unused, so its presence signals nothing); re-init is a **single rolled-back-on-failure transaction** — tests assert no real-content marker survives anywhere and that an aborted run leaves the real vault intact. Deniability rests on uniform slot 2 + no stored flag + logged as a plain passphrase unlock; the shipped bundle avoids telltale vocabulary (verified — 0 “duress”/“decoy” strings in `dist`). Honest residuals: destructive on-device (recover via another device/repo), NOT forensic-proof (IndexedDB free-page ciphertext; a pre-coercion image can diff), and mild consistency tells. New Scenario 3b. Earlier 2026-07-22: **Paranoid extra: auto-clear clipboard (opt-in)**: wipe the clipboard 10–300 s after copying app content (outline/PNG/diagnostics) — **partial** mitigation, documented: can't touch OS clipboard history, needs focus to write (retries on next focus), and only compares-before-wiping when `clipboard-read` is already granted (never prompts), else clears blind. `paranoidClipboardClear*`, default off. See Scenario 3. Earlier 2026-07-22: **Paranoid extra: unlock audit trail (opt-in)**: device-local, never-synced log (≤50) of unlock method/success/time, shown post-unlock as “Last unlock … · N failed attempts since” for tamper-evidence — same plaintext class as `failedUnlockAttempts`/`unlockHistory`; a future duress unlock logs as a plain passphrase success. `paranoidUnlockLogEnabled`/`unlockLog`, default off. See Scenario 3. Earlier 2026-07-22: **Paranoid extra: redact mode (opt-in)**: sidebar eye button + Ctrl/Cmd+Shift+H blur all content-bearing elements (`data-redact` sweep), revealing only the hovered/focused one — shoulder-surfing deterrence for working in public; active flag in localStorage `gtd25-redacted` (boolean, no content, panic-wipe-swept); **deterrence only** — DOM still holds plaintext, storage/sync unchanged. Earlier 2026-07-22: **Paranoid extra: instant-lock hotkey (opt-in)**: Ctrl/Cmd+Shift+L locks the vault from anywhere, including inputs (`paranoidLockHotkeyEnabled`, device-local, default off) — strictly shrinks the unlocked window. Earlier 2026-07-22: **Paranoid extra: lock when hidden (opt-in)**: lock the vault after the tab has been hidden for 0–300 s (0 = the instant it hides) — covers tab switches, which the Chromium-only IdleDetector path never sees; background timer throttling makes non-zero delays “at least N seconds” (documented). Strictly shrinks the unlocked window; device-local `paranoidBackgroundLock*`, default off. See Scenario 3. Earlier 2026-07-22: **Paranoid extra: privacy screen (opt-in)**: while unlocked, an optional full-app **blur veil** raises on tab-background or once **50% of the idle window** passes without interaction, and drops on movement/keypress/focus (dismissal counts as real interaction and re-arms the idle timer; pointer movement is observed **only while the veil is up**, so ACR-002 — only real interaction defers the re-lock — keeps its shape). Narrows shoulder-surfing and task-switcher-preview exposure during the run-up to auto-lock; explicitly **deterrence, not cryptography** (plaintext stays in the DOM; memory capture unaffected; the DEK still drops only at the real auto-lock). Device-local toggle `paranoidPrivacyOverlayEnabled`, default off. See Scenario 3. Earlier 2026-07-22: **Downloadable safety backups**: the boot-time device-local safety backups (localStorage, **never created under Paranoid**) gained a **Download** button beside the existing Restore — it repackages the backup into the standard **unencrypted** backup zip so another device can import it. No new data is created or retained: the same plaintext already sits in this device's localStorage, and the exposure class is identical to the existing plain "Export" (**plaintext task content leaving the device** in a file the user then controls). The zip carries lists/tasks/subtasks only — mindmaps are **absent, not empty**, which the importer reads as "keep this device's mindmaps". Earlier 2026-07-22: **Mindmap image export + canvas background + saved presets**: maps can now be exported as **PNG/SVG** or **copied to the clipboard as PNG** — built client-side from the layout into a standalone SVG (real `<text>`, every label **XML-escaped**, colours resolved to literals, no network and no third-party rasteriser); the honest residual is the one inherent to any export: **plaintext content leaves the encrypted store** into a file or the system clipboard, same class as the existing markdown-outline export. New **encrypted** field `mindmap.background` (the canvas colour, `#rrggbb`, validated on write; added to `SENSITIVE_FIELDS`, no SYNC_VERSION bump — additive + per-field merge, same reasoning as the node formatting fields below). New device-local **saved colour presets** in the existing `gtd25-mindmap-ui` localStorage key (a name + three hex colours — the only user-typed text in that key); applying one writes **literal colours onto the node**, so the preset list is an authoring shortcut and never a rendering dependency. Earlier 2026-07-22: **Mindmap node formatting**: nodes gain an optional **shape** (rounded rect / circle / decision diamond) and **colours** — five theme-aware presets plus an advanced per-part picker (background / text / border) — set from a format bar that appears while a node is selected. **Five new fields on `mindmapNode`** (`shape`, `palette`, `colorBg`, `colorFg`, `colorBorder`), all added to `SENSITIVE_FIELDS` so they are **encrypted** on the wire and at rest (a colour scheme is content). **No SYNC_VERSION bump** (still 6): the fields are additive and merge per-field, so an older device cannot clobber them — the accepted transitional residual is that an **old build may re-upload the formatting fields as plaintext** (shape name / preset id / hex colour, never the label) until it updates. **New render surface, closed by construction:** colours reach a `style` attribute, so `palette` is restricted to a **known preset id** and colours to `#rrggbb`, validated **both on write and on render** — corrupt/hostile values from sync or import fall back to the default look. Presets are stored as **ids, not literal colours** (theme-aware, and nothing user-controlled is interpolated into a CSS variable name). No change to cryptography, key handling, storage locations, or lock/wipe flows. See "What is encrypted vs. always plaintext" → Mindmaps. Earlier 2026-07-21: **Mindmaps**: new section — hierarchical node maps organized in nested folders, stored as three new synced entity types (`mindmapFolders`/`mindmaps`/`mindmapNodes`) that ride the existing changelog + field-level-LWW sync (**SYNC_VERSION 5→6**, additive; older devices hit the "Update required" gate). **Posture:** folder/map **names** and node **labels** are the only content fields and are **encrypted** (`SENSITIVE_FIELDS` + Paranoid at-rest middleware coverage for the three new tables); **structure is plaintext metadata** (`mapId`/`parentId`/`folderId`/`order`/timestamps — same class as `task.listId`) so trees merge without decrypting. **New accepted residual:** a backend reader learns each map's node count/depth/fan-out/edit cadence and the folder topology (an incremental sharpening of the existing structure-leak class — never names or labels). **New rendering surface:** labels support a markdown subset rendered by a custom parser that emits **React elements only** (no innerHTML; `href`s validated to http/https), so stored-label markup injection is excluded by construction. **New import surface:** markdown-outline import is a pure string parser with node/label caps; ZIP import gains the same validation under the existing ACR-011 bounds. Device-local collapse state lives in localStorage `gtd25-mindmap-ui` as opaque ids (wiped by panic-wipe's `gtd25-*` sweep and Wipe All Data). Trash/purge/backup/export flows cover the new tables like tasks. See "What is encrypted vs. always plaintext" → Mindmaps. Earlier 2026-06-24: **Local de-duplication / merge (per-list, client-side)**: new feature that detects near-duplicate tasks/follow-ups *within a single list* (a **local lexical** title comparison — normalize + token Jaccard + character-bigram Dice; titles are compared **in memory only**, nothing leaves the device) and, on user confirmation in a review modal, **merges** the chosen entries into one survivor — folding in the others' `description`, `link`/`links`, and `discussionLog`, re-parenting subtasks, and **soft-deleting** the sources. **No security-posture change:** merge runs **entirely client-side** (no new network surface); it only ever combines content that already lives in the **encrypted** task/subtask fields (`SENSITIVE_FIELDS` — title/description/link/linkTitle/links/discussionLog), so it introduces **no new plaintext or at-rest exposure**; the only additions are local `DEDUPE_*` tunables (constants) — **no new persisted or synced fields**, and the suggestion-dismissal state is in-memory/per-session. **Reversible:** sources are soft-deleted (recoverable from Trash, plus an Undo toast that restores the survivor's pre-merge row, un-deletes the sources, and re-parents subtasks). **Concurrent-edit convergence:** survivor fields carry per-field timestamps (LWW) and `discussionLog` keeps using the existing **id-keyed union** merge, so a concurrent edit on another device cannot silently lose merged history — the residual is the standard one already documented (a concurrently-edited source can resurface from Trash via field-level merge; a single deleted discussion entry can be resurrected by a device still carrying it). Detection is skipped for lists larger than `DEDUPE_MAX_ITEMS` (bounded O(n²) cost). See "What is encrypted vs. always plaintext" and Scenarios 1/7. Earlier 2026-06-16: **Relaxed unlock — evaluation window 24 h → 36 h**: the trailing window over which re-unlocks accumulate the +10%/unlock multiplier (and over which `unlockHistory` is retained) widened from 24 h to 36 h. Net effect: a busy stretch's elevated multiplier lingers ~50% longer and reaches the cap more easily. **Worst case unchanged** — the ×2 cap, the absolute caps (idle 240 min, grace 60 min), the OS system-idle base threshold, and all wipe/lock paths are untouched; this is bounded convenience only. `unlockHistory` is now pruned to 36 h (same low-sensitivity, device-local, never-synced plaintext class). See **Scenario 3**. Earlier 2026-06-15: **Relaxed unlock (adaptive auto-lock)**: opt-in toggle (default **off**) that multiplies the **in-app idle auto-lock** and the **screen-lock grace** by a factor scaling with recent unlock frequency — **+10% per unlock beyond the first in the last 36 h, hard-capped at ×2** (`relaxedUnlockEnabled`) — to cut the number of daily security-key/trusted-device unlocks for heavy users. **Bounded by design:** never exceeds 2× the user's configured values (and the existing absolute caps: idle 240 min, grace 60 min); the **OS system-idle threshold stays at the base value** (the true-absence safety net — it also can't be live-adjusted without resetting OS idle detection), and **failed-attempt wipe, panic/remote wipe, manual lock, and ACR-002 (only real interaction re-arms) are all unchanged**. The multiplier is applied at runtime to the in-memory idle window (the next interaction re-arms it; never re-armed on a tick, which would prevent locking) and read live at screen-lock time for the grace. New device-local **`unlockHistory`** (unlock timestamps, pruned to 36 h, **never synced**, recorded only while enabled) — same plaintext class as `lastNudgeAt`; reveals unlock cadence to a seized-device reader (low sensitivity). **Honest residual:** this cannot improve the worst case — while enabled, the worst-case unlocked window during active use rises to ≤2× the configured idle/grace; enabling it authorizes that. See **Scenario 3** and Recommendation 5. Earlier 2026-06-15: **Configurable screen-lock grace**: the optional post-screen-lock app-lock grace (System idle lock → "Delay GTD25 lock after a brief screen lock") is now a user-set duration — device-local `paranoidSystemLockGraceMinutes`, clamped **1–60 min**, default **unchanged at 10** — instead of a fixed 10 minutes. Pure timing/UI knob: **no change** to cryptography, key handling, what is encrypted, storage, or the wire format; the value is device-local (not synced), exactly like its sibling enable flag. **Security note:** a larger grace **widens the window** in which the DEK stays resident in browser memory after the OS screen locks — the in-app idle timer and the system-idle→immediate-lock path are unchanged, and an enrolled remote wipe still fires while unlocked. Existing users' behavior is identical until they change the value. See **Scenario 3** and Recommendation 5. Earlier 2026-06-12: **Shared Folder clipboard paste (confirm-before-upload)**: Ctrl+V in the Shared Folder view now classifies clipboard content — files/screenshots via `clipboardData.files`, full-string http(s) URLs as links, other text as snippets — and shows a preview dialog before uploading through the existing encrypted item APIs (quota, `SENSITIVE_FIELDS` metadata encryption, blob encryption all unchanged). Replaces the previous silent-upload paste. No new persistence or wire format: pasted bytes stay **in memory** until approval (no plaintext stash, unlike the share-target path), and the image-preview object URL is revoked on close. Residuals: clipboard content is rendered on screen pre-approval (user-initiated paste; shoulder-surfing class), and a paste auto-takeover means sensitive clipboard text could be displayed unexpectedly — bounded by requiring the folder view to be open, vault unlocked, and focus outside any text field. Earlier 2026-06-12: **ACR-014 v3 — strength gate recalibrated to a realistic adversary (deliberate loosening) + GitHub Sync gate bypass closed**: the enforced floor for new secrets drops from frontier-cluster-resistant to professional-farm-resistant — the assumed offline attacker changes from a ~100,000-GPU cluster (~10⁹ PBKDF2 / ~10⁸ Argon2id guess/s) to a dedicated ~1,000-GPU professional farm for a full year (~10⁷ / ~10⁶ guess/s), an adversary class this document's scenarios actually posit. Required entropy at the unchanged ">1 year average crack" bar: sync ~55.8→**~49.2 bits**, vault ~52.5→**~45.8 bits** — practical effect: **4 random diceware words now pass both gates** (previously failed both) while 1–3 words, patterned, blacklisted, and repeated-character secrets still fail; estimator design, no-composition policy, and blacklist unchanged. Honest residuals: secrets accepted at the new floor resist the assumed farm for ~7+ years (sync) but NOT a nation-state cluster (explicit non-goal, documented), and backend ciphertext can be harvested now and cracked later on future hardware — the doc now says to prefer margin above the gate. Also closed: the **GitHub Sync settings form set/changed the sync password with no strength gate at all** (ACR-014 was bypassable there); it now enforces the same gate and shows the live strength bar. Earlier 2026-06-12: **reliability review: wipe completion guarantee + corrupt-vault unlock honesty**: from a dedicated reliability/resilience review. (1) **Wipe convergence** — panic/failed-attempt wipe previously treated a BLOCKED IndexedDB deletion (second tab holding the DB) as done and reloaded, which could leave all encrypted data behind with localStorage/SW cleared; it now arms a `gtd25-wipe-pending` marker cleared only on confirmed deletion, retried on every boot before the app reopens the DB — strengthens the wipe scenarios' "wipe actually ran" assumption (pre-imaging caveat unchanged). (2) **Failed-attempt fairness fix** — a corrupt secrets blob or a failed migration resume after a PASSED verifier no longer increments `failedUnlockAttempts`: previously a corrupted vault could burn attempts and ultimately trip the **failed-attempt wipe with the correct passphrase**; the lock screen now tells corrupt-vault/resume failures apart from a wrong passphrase. Wipe-threshold security is unaffected: wrong credentials count exactly as before (ACR-009 serialization unchanged). Also: remote-unlock requester expiry now deletes a late approval response file (dead ciphertext hygiene, ACR-006 unchanged), and periodic maintenance loops (recurring check, focus tick, approver poll) tag persistent failures into diagnostics instead of failing silently. Earlier 2026-06-12: **password-field reveal toggles**: every secret input (vault passphrase incl. the lock screen, PAT, sync password, export/import passphrases) gained the standard eye toggle to show/hide the typed value — user-initiated, display-only React state, never persisted; no change to key handling, lock flows, or what is stored; the added shoulder-surfing exposure requires a deliberate tap and is accepted (the Paranoid randomized on-screen keyboard path is unchanged). Also 2026-06-12: **"Wipe All Data" typed-confirmation gate + honest recoverability copy**: the sync-wide "Wipe All Data" action (Settings → Backups) is now gated behind typing `yes` into the confirm dialog — pure anti-accident UI friction; no change to cryptography, storage, the wire format, or what the wipe deletes. Its in-app copy was also corrected: it previously claimed the wipe "cannot be undone" and "deletes all tasks locally and remotely", while **by design** the encrypted tier backups (`gtd25-backup-{hourly,daily,weekly}.json`) are untouched, a fresh pre-wipe `gtd25-snapshot-v<ver>.backup.json` is written precisely so the wipe *can* be undone, and prior snapshots persist in default-branch git history until the ~monthly squash (all already documented below — see "Default-branch history is also bounded" and the "Backup retention caveat"). The dialog now states that encrypted remote backups are kept (or, with sync off, that the wipe is genuinely unrecoverable). Conclusion impact: nothing weakened; this closes a UI-vs-reality gap where a user could believe a wipe destroyed remote copies that in fact remain restorable — and remain readable to a Scenario 7 repo reader holding the sync password. Earlier 2026-06-11: **Paranoid Mode traffic discretion (anti-fingerprinting)**: Paranoid devices now reduce how much their sync traffic *stands out* to a TLS-intercepting proxy / monitoring security team (distinct from confidentiality, which is unchanged) — (1) **commit messages are neutralized** to a generic `"update"` so the `"gtd25 sync: …"` brand no longer appears in PUT/DELETE/commit bodies (messages are write-only — no functional effect); (2) **every poll interval is jittered ±30%** so the cadence is no longer a fixed-period beacon; (3) the **idle poll is gated behind a conditional GET** so the steady state is bodyless `304`s instead of full-body pulls. Non-paranoid devices are byte-for-byte unchanged. **Residuals (explicitly unchanged):** URL **paths** + blob branch still carry the `gtd25` brand (a filename/branch rename is a deferred backend migration), the inherent "regular encrypted blobs to a personal repo" **DLP shape** can't be made innocent against a competent analyst, and the **PAT/repo/metadata** exposures of Scenario 4 are unchanged; the only robust mitigation on a genuinely hostile network is **not syncing there**. See **Scenario 4**. Earlier 2026-06-11: **remote-unlock Approve cooldown 3s→2s**: the deliberate delay before the Approve button on the trusted device's remote-unlock prompt becomes clickable was reduced from 3 to 2 seconds. UI-friction tweak only — the ceremony's security still rests on the verification-code match, the never-approve-unsolicited rule and the request-digest binding (ACR-001), none of which change; marginally less forced reading time before approval, accepted. Earlier 2026-06-10: **discussionLog merge hardened — data-loss risk closed**: the follow-up discussion history is now merged as a **union by entry id** (per-entry newer-wins on collisions) instead of whole-field LWW, so concurrent appends/edits on two devices no longer silently drop one device's entries — this closes the data-loss residual previously documented in "What is encrypted vs. always plaintext". New, strictly smaller residuals: a concurrent **deletion** of a single entry can be resurrected by a device still carrying it, and a merged array may not propagate until the topic is next edited. No change to cryptography or the wire format (the array stays encrypted as a unit; merge runs post-decryption). Earlier 2026-06-10: **'working' status removed**: the legacy 'working' task/subtask status value and its machinery (working banner, "Next up" suggestion, Work buttons/shortcuts) were removed — superseded by Focus Mode. Legacy rows are normalized to 'todo' by a one-time local migration that syncs like any edit, plus normalization at every sync/import ingestion point (**SYNC_VERSION 4→5**; older devices hit the existing "Update required" gate until updated). No change to cryptography, key handling, or the wire format; if anything, a backend reader loses the live "which one task is being worked right now" status signal (the coarser `workedAt` timestamp remains). Earlier 2026-06-10: **Focus Mode**: new default view showing a strict 2-3 task daily commitment set. Adds **one plaintext metadata field**, `task.focusedAt` (timestamp, same class as `workedAt` — NOT in `SENSITIVE_FIELDS`), and a device-local `lastFocusRefillDay` on `localSettings` (never synced). No change to cryptography, key handling, lock flows, or the wire format. Residual: a backend reader additionally learns **which ~3 task ids are currently in focus** and the daily refill cadence — an incremental sharpening of the existing status/timestamp metadata leak, accepted. Earlier 2026-06-10: **ACR-014 strength gate v2 + live strength bar**: choosing a vault passphrase or sync password now shows a **live segmented strength bar**, and the submit gate passes only when the estimated **average offline crack time exceeds one year** at this document's own attacker rates (~55.8 bits for the sync password at PBKDF2 ~10⁹ guess/s; ~52.5 bits for the vault passphrase at Argon2id ~10⁸ guess/s). Entropy = min(charset estimate with repeat discount, word-structure estimate at 12.9 bits/word); the previous **composition rules are removed** — a long lowercase-only passphrase passes, while one or two dictionary-style words fail with an actionable hint; the common-password blacklist still hard-fails. Net effect: *stricter* on patterned secrets ("Password1!" now fails) and *fairer* to long passphrases. Residual: word detection is structural (no dictionary), so a rare or leet-mangled single word can be overrated — see "brute-force economics". Earlier 2026-06-09: **Codex AppSec remediation verified + ACR-001 fully closed** — an independent re-review confirmed all 16 audit findings fixed or accepted-and-documented (per-finding verification notes now in `codex_appsec_review.md`); the last open ACR-001 recommendation is implemented — the approver **signs the request digest into the unlock response** and the requester **rejects any response not bound to its own pending request's digest**, making the approval ceremony end-to-end bound to the verified request; the follow-up review's two new P3 findings on the share-target stash lifecycle are **fixed**: the plaintext stash is now **swept on every unlocked start** (consumed if fresh, **purged after a 24h TTL**) and cleared on the error path, so a lost `?shareTarget` redirect can no longer orphan it indefinitely (**ACR-017**); and the SW **caps stashed shares** (≤ 20 files, ≤ 30 MB per file/aggregate, skipped files surfaced) so a mis-share can't exhaust the origin's storage quota (**ACR-018**) — see "Web Share Target" below. Earlier 2026-06-09: **Web Share Target moved to POST/multipart** so Android can share **files** in — files land in the E2E-encrypted **Shared Folder**, text/links in the **Inbox**; shared content now travels in the POST **body, not the URL** (removes the GET-in-query leak), with a transient plaintext Cache-Storage stash as the documented residual. Earlier 2026-06-09: **second batch of Codex AppSec hardening (ACR-005–016)**: entity ciphertext is now AES-GCM **bound to its record (type:id) via AAD** so it can't be relocated across records — residual anti-replay/rollback documented (ACR-005); remote-unlock **requester-side TTL** wipes the in-RAM key + stale request on expiry (ACR-006); **approver invites are signed and verified against the MAC-authenticated registry** so a PAT-only writer can't register an approver bond (ACR-007); failed unlock no longer leaves the DEK resident (ACR-008) and the **attempt counter is serialized** against the latest persisted vault (ACR-009); **Pomodoro/sound-preset names documented as plaintext metadata** (ACR-010); **import resource limits** on ZIP/sound archives (ACR-011); the **security-key affordance self-heals from vault metadata** if the localStorage cache is cleared (ACR-012); the unsigned **pending wipe status is labelled advisory** while confirmed stays signed (ACR-013); a **weak-secret gate** blocks clearly-weak passphrases/sync passwords (ACR-014); **diagnostics scrub tokens/share-target/secret blobs** (ACR-015); and a **Trusted Computing Base section + production CSP** were added (ACR-016). Earlier 2026-06-09: **hardening from the Codex AppSec review**: the Paranoid idle re-lock is now re-armed **only by real user interaction** — background DEK access (recurring checks, liveQuery, sync) no longer keeps the vault unlocked (ACR-002); WebAuthn enrollment **no longer logs PRF output bytes or the salt** to the console (ACR-003); and the GET Web Share Target's query string is **redacted from service-worker logs and scrubbed from the URL before any async work** so shared content does not linger (ACR-004). Earlier 2026-06-09: **remote-unlock approval is now bound to the exact verified+displayed request** — the approver re-verifies the requester signature and requires a canonical request digest match before sealing RUK, closing the ACR-001 request-swap window where a backend/PAT writer could redirect RUK to attacker-controlled key material after the verification code was shown. Earlier 2026-06-09: the sync repo's **default branch is now also periodically history-squashed** (~monthly, content-preserving orphan commit + force-update) to bound git-history growth from per-sync JSON commits; CAS-guarded, transparent to the app's content-SHA concurrency and other devices, recovery via the preserved remote backup files. Earlier 2026-06-09: Shared Folder blobs live on a dedicated orphan branch `gtd25-blobs` that is periodically **history-squashed** (single orphan commit + force-update) to purge deleted files so the sync repo stops growing; and GitHub GCs the freed bytes on its own schedule; wipe empties the branch. Earlier 2026-06-09: added the **Shared Folder**: an E2E-encrypted link/file/snippet store synced across the user's devices; item metadata — type/name/size/url/blobId/mimeType — is encrypted with only opaque id/order/timestamps plaintext; file/snippet bytes are sync-key encrypted on the wire and DEK-encrypted at rest under Paranoid; residual leak is per-blob count + ciphertext size to a backend reader. Prior: remote-wipe device lifecycle derived from shared repo files; registry-entry deletion as decommission signal; serialized `remoteApproverFor` writes + backend-error resilience; diagnostics log hardened against payload leaks)
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
  `subtask.title/link/linkTitle/links`; the sensitive subset inside the
  `changeLog.data` snapshots (the entry's own `entityType`/`entityId`/
  `timestamp`/`deviceId` stay plaintext, as does every plaintext column of the
  changed row — a changelog entry is not an opaque blob);
  `sharedItem.type/name/size/url/blobId/mimeType` (Shared Folder — see below);
  and `mindmapFolder.name` / `mindmap.name` / `mindmap.background` /
  `mindmap.smartColoring` /
  `mindmapNode.label` + `mindmapNode.shape/palette/colorBg/colorFg/colorBorder`
  (Mindmaps — see below).
- **`fieldTimestamps`, on every entity (since SYNC_VERSION 7, 2026-09-20).** Its
  *keys* are the record's field names — including the encrypted ones — and its
  values are when each last changed. In the clear it told a backend reader, and a
  disk image of a **locked** Paranoid device, which encrypted fields exist per
  record and when each was edited. Two claims below were false while it shipped
  plaintext and are now true: the discussionLog's last append was exposed, and a
  Shared Folder link (key `url`) was distinguishable from a file (keys `blobId` +
  `mimeType`) without decrypting anything. Safe to hide because every merge runs
  after decryption. **A device on an older build refuses to sync** ("update
  required") until it updates — it does not push, migrate or delete anything.
- `task.discussionLog` is the follow-up discussion history (`{id, at, note}[]`).
  The free-text `note` is content, so the **whole array** is encrypted as a unit
  (the per-entry `at` timestamps are encrypted too — they are not exposed as
  metadata, and since v7 neither is the array's last-edit time). The sync merge for this field is a **union by entry `id`** (not
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
- `task.starred`, `taskList.type` (tasks vs. follow-ups), `task.blockedAt` /
  `completedAt` / `lastCompletedAt`: plaintext, same class as the rest of the
  row's state. A backend reader learns which items you flagged as important and
  which lists are follow-up lists.
- **`taskList.archivedAt`** — when a list was archived (absent = active), same
  class as `deletedAt`. Plaintext so the field-level merge and the startup
  expiry work without content. Residual: a backend reader learns which lists you
  archived and when; the list's `name` stays encrypted. It also **drives a
  destructive action** — a list archived over 12 months ago is soft-deleted into
  the Trash at startup (then hard-deleted by the 30-day purge), so back-dating
  this field on a writable backend makes the device delete the list itself. Same
  standing as tampering with `deletedAt` (Scenario 7); recovery is the 30-day
  Trash window and local backups.
- Follow-up ping/snooze timing — `pingedAt`, `pingCooldown`, `pingCooldownUntil`,
  `pingCooldownCustomMs`, `snoozeCadence`, `snoozeCadenceDays`, `archived` — is
  plaintext metadata. This
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

**Plaintext AT REST even under Paranoid Mode (tables the vault middleware does
not cover).** The at-rest middleware covers `tasks`/`subtasks`/`taskLists`/
`sharedItems`/`mindmapFolders`/`mindmaps`/`mindmapNodes`/`changeLog` — and
`sharedBlobs`, which is handled separately because it is binary. Everything else
in IndexedDB is readable from a disk image of a **locked** device:
- `localSettings` — and specifically:
  - **This device's long-term identity private keys** (`deviceIdentity`: P-256
    ECDH + ECDSA, as JWK) when remote unlock/wipe is enrolled. **Structural, not
    a bug:** the locked device must sign its own unlock request and reach the
    mailbox, so these cannot live behind the vault. What it costs, stated
    plainly: a disk image lets an attacker **impersonate this device** — post a
    signed unlock request (an approver still has to approve it, and the response
    is encrypted to an ephemeral key the image does not contain) and sign a fake
    wipe-status. It does **not** yield the DEK.
  - **The PAT**, for the same reason and only while remote unlock/wipe is
    enrolled (see Scenario 8). Note this contradicts nothing below but *does*
    qualify "credentials are encrypted at rest": with remote features on, one of
    them is not.
  - `remoteApproverFor[].ruk` on an **approver** device — the key that wraps
    another device's DEK. Approvers are required to be Paranoid-OFF, so their
    whole disk is plaintext anyway; this is why approver compromise is listed as
    a standing risk in Scenario 8.
  - The real repo name, the unlock log and unlock history, device name, and the
    nudge schedule.
- `syncMeta` — remote SHAs, last pull/push times, pending blob deletes: a
  sync-activity timeline that survives a lock.
- `pomodoroSounds` — **imported audio blobs, unencrypted**. Never synced, and the
  secondary-passphrase re-init does not replace them.

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
  The image-preview object URL is transient and revoked on close; a **download's**
  object URL is kept for a minute so the browser can fetch it, and is now tracked
  so a lock revokes it rather than leaving decrypted bytes resolvable at a
  same-origin `blob:` URL after the DEK is gone.
- **Deletion has no undo.** Unlike tasks and mindmaps there is no Trash: a
  deleted item is tombstoned and its backend blob removed. Since 2026-09-20 a
  **"Delete all"** empties the whole folder behind one confirmation (it loops the
  same per-item delete, so tombstones, change-log entries and blob cleanup are
  unchanged). Both are gated on an unlocked vault, and the at-rest middleware
  would refuse the write regardless.
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

- **Encrypted:** folder/map **names**, node **labels**, node **formatting**
  (`shape`, `palette`, `colorBg`, `colorFg`, `colorBorder`), and the map-level
  `background` and `smartColoring` flag, in `_enc` on the
  wire and at rest under Paranoid (the at-rest middleware covers the three new
  tables). Labels may contain a markdown subset. Formatting is encrypted because
  a colour scheme *is* content ("red = blocked"), and hiding it costs nothing —
  it is not needed to merge structure.
- **Smart colouring (opt-in per map, `mindmap.smartColoring`):** while on, node
  creation auto-assigns a **branch colour** — each direct child of the root opens
  a new branch (first the five theme-aware presets, then **synthesised fixed-hex**
  colours by golden-angle hue rotation, the same class as saved custom palettes)
  and deeper nodes inherit their parent's. It writes only the **existing** per-node
  formatting fields above (validated on write and render), so it adds **no new
  render surface**; the flag itself is a boolean, encrypted like `background`.
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
  file, paste, or **clipboard read** with a pure string parser (no eval, no DOM,
  no network), capped at 2 MB of text, 2000 nodes and 1000 chars/label; ZIP
  backup import applies the same caps plus the existing
  `MAX_RECORDS_PER_ARRAY`/size bounds (ACR-011 class). The parser is tolerant by
  design (chatbot markdown: `#`/`##` hierarchy, `-`/`*`/`+`/`1.` markers, plain
  indented text) but every pattern is anchored after a hand-rolled indent scan,
  so no regex backtracks over attacker-chosen whitespace runs. Imported labels
  are stored and rendered exactly like typed ones — the markdown renderer's
  existing sanitisation (link `href`s restricted to http/https) is what keeps a
  hostile pasted label from becoming a `javascript:` link. Reading the clipboard
  requires an explicit button press (never on dialog open) and is the same
  capability Quick Capture and the Shared Folder already use.
- **Device-local UI state:** collapse/expand state lives in localStorage
  (`gtd25-mindmap-ui`) as **opaque node ids only** — no content, plus the user's
  saved colour presets (a name + three hex colours; the only user-typed text in
  that key, low sensitivity, e.g. "Corporate") and one boolean, whether newly
  created maps start with smart colouring on (an authoring preference; the map's
  own `smartColoring` flag stays an encrypted, synced field). Applying a preset writes the
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

**The "Update required" gate now covers writes, not just reads (2026-09-20).**
It had only ever guarded the *pull* paths. A device on an older build that met a
newer remote refused to sync — and then the obvious thing to reach for is
Settings → **Force push**, which had no version check at all: it would replace
the newer snapshot with that device's older-format data and delete the
changelog, destroying every edit the updated devices had made since. The same
was true of a ZIP import, a backup restore, and the changelog compaction that
runs *before* the pull's own check. All four now refuse a remote written by a
newer version and say so. This matters on any install where devices update at
different times — which is every install, and is how a version bump like v7 is
supposed to be survivable: **the un-updated device waits, it does not lose and
does not overwrite.**

### Crypto inventory
| Purpose | Algo | Key derivation | Verifier (oracle) |
|---|---|---|---|
| Sync content | AES‑256‑GCM | PBKDF2‑SHA256, 600k, `syncPassword` | `encryptionVerifier` in snapshot |
| Vault at-rest | AES‑256‑GCM (random DEK) | DEK wrapped by Argon2id(passphrase) and/or FIDO2‑PRF — each wrap AES‑GCM with **AAD = its slot** (`slot1`/`slot2`/`prf:<credential>`/`ruk`), so wraps can't be moved between slots | `verifier` in vault row |

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
  (passphrase Argon2id and/or security key). No **remote** backups are created,
  and since 2026-07-27 the device-local safety copy is **created but encrypted**
  with the same at-rest key as the database rows (it used to be skipped outright,
  which honoured "no plaintext on disk" at the price of leaving the configuration
  that most needs a safety net without one). What that costs, stated plainly: a
  second at-rest copy of task/mindmap content exists in `localStorage`
  (`gtd25-local-backup-*`), readable only while the vault is unlocked, swept by
  the panic wipe's `gtd25-*` clear, and **holding deleted content until it
  rotates out** — two copies are kept, so a task deleted now can still sit in a
  backup taken before the deletion. No new key material and no new key exposure:
  same key, same lock, same wipe. It is never written while locked (the rows
  would still be ciphertext) — including the boot-time copy, which on a
  Paranoid device therefore only happens when the vault is unlocked within the
  first seconds after start — and a secondary-passphrase unlock deletes it
  (Scenario 3b). Enabling deletes the plaintext copies that existed before, once
  every row has been rewritten (so they stay a recovery point during the
  migration) — by `removeItem`, which, like IndexedDB, does not securely erase:
  their bytes may linger in the browser's storage files until overwritten.
  Disabling rewrites the encrypted copies as plaintext while the key still
  exists (before 2026-09-22 they were left encrypted under a destroyed key). **Locked writes fail closed** (since 2026-09-10): with the vault
  locked, the at-rest middleware refuses any write that would store plaintext
  content, so work still in flight when the vault locks — a sync mid-pull, most
  obviously — fails instead of landing on disk unencrypted; locking also aborts
  that sync session. Before this, such a sync wrote the rows it had fetched in
  plaintext. Sync credentials entered anywhere (Settings → Sync, the sync-password
  prompt) are stored only in the vault — **with one declared exception**: while
  remote unlock/wipe is enrolled the PAT is *also* kept in plaintext
  `localSettings`, because a locked device has no other way to reach its mailbox
  (Scenario 8), and so are this device's identity private keys. Saving sync
  settings used to clear that PAT copy unconditionally, which silently disarmed
  remote wipe while Settings still read "Enabled"; since 2026-09-20 the save
  preserves it when enrolled. An idle/lock screen gates access; failed-attempt
  and panic wipes exist — the attempt wipe defaults to **10** tries, is settable
  0–50, and **0 disables it**. Vaults enabled before that setting existed had it
  silently off while the UI showed it armed; they are now armed to the default on
  their next unlock, which says so once. **Only a wrong passphrase advances it.**
  A failed security-key or remote unlock is written to the unlock log — so the
  audit trail covers all three methods — but deliberately not counted, because
  neither can be told apart from a legitimate one going wrong: an enrolled
  credential can return different PRF output after an authenticator reset or on
  another device holding the same synced passkey, and the remote path is driven
  by whoever can write the repo, which would hand them a way to wipe the device
  from a distance.
  Protection is bounded by **passphrase strength** (or the security key) and is
  **only effective while locked** (see Scenario 3).
- **Turning it on or off survives the tab dying (since 2026-09-22).** The two
  halves of "this device is Paranoid" live in different stores — the flag in
  `localStorage`, the vault in IndexedDB — and can't be written atomically; the
  vault is the authority, since it holds the only key to the encrypted rows. An
  enable saves the vault (with the credentials already inside it), raises the
  flag, and only then rewrites rows; a crash at any later point comes back at the
  lock screen, and the unlock resumes the whole enable. A boot-time reconcile
  (before the first render) raises the flag for a vault saved just before a crash
  and drops a flag left behind by a disable that had already deleted the vault.
  An enable never replaces an existing vault. Before this, a crash
  mid-migration reloaded as an un-Paranoid app over half-encrypted rows (plaintext
  credentials and backups still in place), and re-enabling destroyed the rows the
  first attempt had encrypted. A device that went through that before the fix
  keeps the loss; the fix does not recover it.
- **…and with the app open in other tabs (since 2026-09-25).** A disable locks
  the app's other tabs before it decrypts anything and reloads them once it is
  done; an enable reloads them into the lock screen before it encrypts anything
  (an open tab used to read the rows mid-rewrite and crash). An at-rest key is only active while the Paranoid flag is up, and the
  disable lowers the flag before it deletes the vault, with a last decrypt pass
  in between — so a background write, in this tab or in one that missed the
  lock, can no longer leave a row encrypted under a key that stops existing a
  moment later. Before, it did: an unlocked second tab (or the disabling tab's
  own Focus refill) wrote rows nothing could ever decrypt again. **Residual:** a
  write encrypted in memory before the flag went down and stored after that last
  pass is refused (lost, not left unreadable).

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
  - **Re-key after a suspected copy (2026-09-22).** If an image *and* the
    passphrase of that time may be in someone's hands, Settings → Security →
    *Re-key this device* mints a new DEK: the image stays readable to them,
    everything written afterwards is not (post-compromise security, §4). A
    passphrase change re-keys by default.
  - **Mitigations in place:** Argon2id KDF, security-key tier (recommended for
    real seizure risk), persistent-storage request, panic/failed-attempt wipe
    (note: wipes only help *before* imaging — a copied disk is immune). The wipe
    sets a `gtd25-wipe-pending` marker that survives until the IndexedDB
    deletion is **confirmed**: a deletion blocked by a second tab is retried on
    every app boot (`retryPendingWipe`), so an interrupted wipe converges to
    complete instead of silently leaving data behind — and, since 2026-09-25,
    leaves the app that boots after it with a working (empty) database; before,
    nothing could be saved until a second reload. Since 2026-07-27 the wipe
    also **signals the other tabs** over the same-origin tab channel: they drop
    their keys and reload, which closes the very IndexedDB connections that block
    the deletion, so the common two-tab case now usually completes on the first
    attempt rather than on the next boot. The wipe does not *wait* for them —
    a panic wipe starts immediately and the marker still covers the rest.

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
  **unlocked vault**. The Paranoid panel's *Download recovery backup* goes through
  the same dialog since 2026-09-22 (encrypted by default); until then it wrote a
  plaintext zip to Downloads without asking.
- **Downloading a safety backup** (Settings → Backups → *Download*) goes through
  the same dialog and the same choice since 2026-09-22 — encrypted by default in
  Paranoid Mode. Before, it silently wrote a **plaintext** zip to Downloads, even
  from a Paranoid device.

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
  Two concrete retainers of decrypted *content* outlived the lock until
  2026-09-20 and are now cleared with it: a shared-folder download's `blob:` URL
  (kept a minute so the browser can fetch it — and resolvable from any
  same-origin context in the meantime), and the clipboard auto-clear's retained
  copy of the last copied text (up to its full 5-minute delay). The session also
  ends sync, clears the search box and dismisses a nudge that names a task, and closes the app's OS notifications
  (a nudge quotes a task title; the OS's own notification history is out of
  reach — see Scenario 3b). The panic wipe closes them too.
  - **Mitigations:** aggressive auto-lock (idle timeout + optional system-idle /
    screen-lock detection), keylogger-safe security-key unlock (no passphrase
    string in memory), short unlocked windows. The idle timer is re-armed **only by
    real user interaction** (pointer/key via `touchVaultActivity`) — **DEK access by
    background code (recurring-task checks, liveQuery refreshes, sync) no longer
    defers the re-lock**, so an idle-but-open tab still locks on schedule (ACR-002).
    **Recommendation:** keep idle timeout short and lock before walking away; treat
    memory capture while unlocked as unwinnable — and **re-key** afterwards
    (Settings → Security, 2026-09-22): a DEK lifted from memory opens nothing the
    device writes after that.
  - **Locking is app-wide, not per tab (2026-07-27).** The DEK is a module
    variable, so it used to be that locking — by hotkey, idle timeout or
    lock-when-hidden — dropped the key *only in the tab that ran it*: a second,
    forgotten tab stayed unlocked and readable, with its own idle timer running
    off its own activity. Your auto-lock was worth whatever your least-used tab
    was doing. A same-origin `BroadcastChannel` (`src/lib/tab-channel.ts`) now
    propagates it: any tab locking locks them all. Deliberate asymmetry — the
    channel carries **signals only** (`lock`, `wipe`), never key material, and
    there is **no unlock signal and must never be one**, since propagating an
    unlock would mean moving the DEK between contexts. Every message therefore
    only ever *reduces* access, so a same-origin script forging one gains
    nothing (at worst it locks or reloads you — and it could already call
    `panicWipe` directly), and a dropped message degrades to the old per-tab
    behaviour. Residual: this is in-page signalling, so a tab that is suspended
    or crashed processes it on its next run; and per-tab UI state (privacy
    screen, redact mode) is still per tab.
  - **Auto-clear clipboard (opt-in Paranoid extra, 2026-07-22):** after copying
    app content (outline / PNG / diagnostics), the clipboard is wiped once a
    configurable 10–300 s passes. **Partial mitigation, stated in the UI**: it
    cannot reach OS clipboard *managers / history* (Win+V, third-party
    managers) — only the live clipboard; the Clipboard API needs focus to write,
    so an unfocused clear retries on next focus; and it only skips a wipe of
    content-you-since-copied when `clipboard-read` is *already* granted (never
    prompted) — otherwise it clears unconditionally. Reduces, does not eliminate,
    the copied-content residue.
  - **Unlock audit trail (opt-in Paranoid extra, 2026-07-22):** a device-local,
    never-synced log (capped at 50) of unlock attempts — method + success + time
    — surfaced after unlock as "Last unlock <when> · N failed attempts since",
    so activity in your absence is **tamper-evident**. Same accepted plaintext
    class as the existing `failedUnlockAttempts` / `unlockHistory` (a
    seized-device reader learns unlock cadence; low sensitivity). A **duress**
    unlock (below) is recorded as a plain `'passphrase'` success — the log never
    distinguishes it.
  - **Redact mode (opt-in Paranoid extra, 2026-07-22):** a toggle (sidebar eye
    button / Ctrl+Cmd+Shift+H) that CSS-blurs every content-bearing card and
    name across the app, revealing only the element under the cursor or
    keyboard focus — for working with the app open in public. The active flag
    is mirrored to localStorage (`gtd25-redacted`, one boolean, no content;
    swept by the `gtd25-*` panic-wipe prefix) so it survives a lock/unlock in
    public. **Deterrence only, stated in the UI**: the plaintext is in the DOM,
    a mild blur can be defeated by OCR or a paused screen recording, and it
    does not change what is stored or synced.
    **Coverage fix (2026-07-24):** the flag was set on the app-shell `<div>`, so
    the rule `.gtd-redacted [data-redact]` could not reach anything painted
    outside that subtree — verified in a real browser: portalled menus, the
    drag-overlay ghost and every `showModal()` dialog computed `filter: none`
    while redact mode was on. It now flags `<body>`, and the sweep was widened
    from 10 to ~40 components: the always-on reminder strips (Due soon / Ready
    to discuss / Blocked — the reported leak, and the most legible thing on the
    screen), the current list-name header, the sidebar search + rename inputs,
    toasts, confirm-dialog messages, context-menu list names, drag ghosts,
    trash/attention/insights rows, merge previews, discussion notes, and the
    task/subtask/capture forms. **Known residuals:** native `title=` tooltips
    and `alt` text are browser chrome that CSS filters cannot blur; a focused
    field is revealed by design (`:focus-within`) so whatever you are actively
    typing stays legible.
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
  - **Privacy screen (opt-in Paranoid extra, 2026-07-22; retimed 2026-07-27):**
    while unlocked, a full-app blur veil raises once the app has been in the
    **background** — tab hidden, or window merely unfocused — for **half the
    time that was still left before the auto-lock** when it went away. It drops
    on any real interaction (which also re-arms the idle timer — a wake gesture
    is interaction; pointer *movement* is listened to only while the veil is up,
    so ACR-002's shape is unchanged: background code still can't defer the
    lock); waking it while still in the background restarts the countdown, so a
    stray mouse move over an unfocused window can't switch the veil off until
    the next backgrounding. This narrows the **shoulder-surfing /
    glance-at-an-unattended-screen** window during the run-up to the auto-lock.
    Until 2026-09-20 the "full-app" veil had a hole: toasts are promoted into the
    browser's **top layer** (popover), which no z-index reaches, so one fired
    just before backgrounding stayed fully legible over the blur — and several of
    them name a list or a task. They are now hidden while the veil is up.
    Two deliberate reductions in coverage versus the original timing, both the
    user's call: (1) an app that is **on screen and focused** but untouched is
    no longer veiled at all — being idle in the foreground used to be enough,
    now background is required; (2) the delayed veil **does not blank mobile
    task-switcher previews**, because that snapshot is taken at the instant of
    backgrounding, long before any countdown expires. The **"blur the moment it
    goes to the background"** sub-setting (device-local, default off) restores
    the original instant-on-background behaviour and with it the blanked
    preview — on a phone it is effectively required for that protection.
    **Deterrence, not cryptography**: the DOM behind the CSS veil still holds
    plaintext, and a memory/DOM capture is unaffected — the DEK drops only when
    the real auto-lock fires. Accepted tradeoff: a nudged mouse lifts the veil
    and defers the lock (that pair is inherent to "dismiss on movement").

### Scenario 3b — **Coerced unlock** (someone forces you to open the vault)

Optional, opt-in: a **secondary passphrase** (internally the vault's "slot 2"),
set only from Settings while unlocked. Entering it at the lock screen looks and
logs like a completely ordinary passphrase unlock, but atomically **re-keys the
device to placeholder content**: every sensitive field is replaced with lorem
while **all structure is preserved** (ids, parent/list/map refs, order, status,
timestamps), sync credentials are dropped, and the changelog / sync bookkeeping
/ shared-blob cache / security-key + remote-unlock enrolments are cleared. From
then on the secondary passphrase *is* the device's real passphrase and the
original passphrase no longer unlocks anything. Recovery of the real data is via
another device or the encrypted sync repo (re-link sync with the real sync
password). Re-linking asks before replacing the device's content (as for any
never-synced device with content) and always **replaces** it — never merges, or
the decoy session's items would be uploaded into the real repository.

- **Vault format:** the DEK is wrapped in **two slots** under the same
  salt+KDF, so one derivation per attempt tries slot 1 (normal) then slot 2
  (secondary). **Slot 2 is ALWAYS present** — random garbage when no secondary
  passphrase is configured, indistinguishable in size/shape from a real wrap —
  so its presence never reveals whether the feature is in use. Existing vaults
  are backfilled with a garbage slot 2 on next unlock.
- **Each wrap is bound to its slot (2026-09-22).** Until then the two slots were
  interchangeable: whoever could rewrite the `vault` row of a locked device
  (a seized disk that comes back, or code running in the page) could swap them,
  after which the **real passphrase ran this re-init over the real content and
  the secondary passphrase opened the real content** — the inversion this
  feature exists to prevent, bought with one row edit before the coercion. Every
  wrap now carries its slot as AES-GCM additional data, so a swapped row reads
  as two wrong passphrases and re-keys nothing (tested: swap, both fail, swap
  back, both work). A wrap from before the binding still opens from any slot
  and is rewritten bound when the app next holds its KEK — slot 1 at the next
  passphrase unlock, slot 2 when the secondary passphrase is next set or
  removed. **A secondary passphrase set before 2026-09-22 therefore keeps the
  old exposure for slot 2 until it is set again** (the settings section says so,
  to everyone, whether or not one is in use).
- **Reliability / no-trace (verified by tests — unit *and*, since 2026-09-10, an
  end-to-end Playwright suite that drives the real production build):** the e2e
  run matters because it exercises the shipped CSP, the Argon2id wasm path and
  the service worker, which is exactly the combination that broke silently in the
  2026-07-24 incident below; it asserts that after a secondary unlock no real
  content remains in IndexedDB, `localStorage`, `sessionStorage` or **Cache
  Storage**, that a held share is dropped, that other tabs lock and reload, and
  that the device never reaches GitHub. All crypto runs in memory,
  then a **single Dexie transaction** clears and rewrites every content table,
  writes the re-keyed vault, and severs sync. Interrupted mid-way ⇒ the
  transaction rolls back and the device is byte-for-byte pre-coercion (real data
  intact, both passphrases still work, retryable) — never a half-exposed state.
  Tests assert that **no marker of the real content survives anywhere** (rows,
  ciphertext, changelog, blobs, vault secrets) after a secondary unlock, that
  structure is preserved, that the old passphrase is dead, and that an aborted
  re-init leaves everything intact.
- **Beyond the transaction (added 2026-09-10 — a review found each of these
  surviving the swap):** inside the transaction the re-init also drops the repo
  name, rotates the device id stamped on every real change, drops the
  remote-unlock identity published in the repo's device registry, and keeps only
  passphrase entries in the unlock log (a security-key or remote unlock can't
  have happened on a vault that has neither). Right after the commit it deletes
  the device-local safety backups (encrypted under the destroyed key — unreadable,
  but listed with their dates and failing to restore), a share stashed while
  locked (plaintext, and otherwise offered straight after the unlock), the
  diagnostics log (sync activity, remote file names), sync bookkeeping in
  `localStorage`, and the app's OS notifications. Those can't join the Dexie
  transaction: a tab killed between commit and cleanup leaves them behind on an
  already re-keyed device — never a half-swapped vault. The decoy's shared files
  describe their dummy bytes (size, `text/plain`), not the real file's.
- **Other tabs and in-flight work:** the other tabs are told to lock before the
  re-key and to reload once it is on disk, so none keeps the real key or real
  content in memory. A lock arriving mid re-key is ignored by the re-keying tab
  (it still sits at its lock screen; the lock would have nulled the read key
  halfway and copied undecrypted rows into the new vault), and real rows that no
  longer decrypt get a decoy like any other. Locking ends the sync session and
  locked writes of content fail closed (Scenario 1), so a sync in flight at the
  lock can't put real remote content into the placeholder vault.
- **Survives changes of the main passphrase:** changing it keeps the salt and KDF
  that slot 2 depends on. Before 2026-09-10 it didn't, and the secondary
  passphrase then failed as a *wrong* passphrase (counting toward the wipe
  tripwire). A secondary passphrase can't be set on a legacy PBKDF2 vault, whose
  upgrade would orphan it. **If the main passphrase was changed after setting a
  secondary one before that date, set the secondary passphrase again.**
- **Deniability of the *feature*** rests on: slot 2 being uniformly present; the
  unlock being logged as a plain passphrase success (the audit trail never
  distinguishes it); no stored "configured" flag and a settings control that is
  identical whether or not one is set. In the **shipped bundle**, the alarming
  vocabulary is deliberately avoided — no "duress"/"decoy" strings or symbol
  names ship (verified on every e2e run, which greps the built `dist/`; "panic" does appear, but only as the
  separate, visible *Panic wipe* feature, never in this one); the neutral surface
  is a "secondary passphrase". This does **not** hide the capability from someone who
  reads the public source repo — it only avoids a device-side devtools/bundle
  grep handing an adversary the word to demand.
- **Checking without using it (added 2026-09-22):** Settings → *Secondary
  passphrase* → **Check** tells the user whether a typed passphrase is the main
  one, the secondary one, or neither, deriving it exactly as the lock screen does
  (same salt + KDF, slot 1 then slot 2, as typed and then trimmed — since
  2026-09-25, like every passphrase check) — and stops there: no unlock,
  no re-key, no write, no unlock-log entry, no failed-attempt count, no tab
  signal (tests assert the on-disk database is identical before and after, and
  that the secondary passphrase still re-keys at the lock screen afterwards). It
  answers only for a passphrase you type — a wrong guess reads "doesn't open this
  vault" whether or not slot 2 is in use — so it keeps the no-query property
  above. It needs an unlocked vault and suppresses its answer if the vault locks
  mid-check, so the answer can't appear on the lock screen. **Residual:** it is an
  unlimited, unlogged guess oracle for whoever holds an unlocked session (one
  full Argon2id derivation per guess, like a lock-screen attempt); the
  lock-screen tripwire does not cover it.
- **Honest residuals:**
  - **Destructive on this device.** The real data is gone locally; recovery
    needs another device or the repo. This defends "unlock it for me NOW", not
    data preservation.
  - **Not forensic-proof.** IndexedDB does not securely erase overwritten pages,
    so an image taken *after* a secondary unlock may still contain old ciphertext
    in free space — readable only with the real DEK, which no longer exists on
    the device. An adversary holding a **pre-coercion image** can diff and detect
    the mass re-encryption. Duress defends the coercion moment, not a before/after
    forensic comparison.
  - **Consistency tells.** "Sync never set up here", "no security key
    enrolled", no safety backups and an empty diagnostics log are mild
    inconsistencies a sophisticated adversary might probe. Two more, not
    scrubbed by the re-init: the Relaxed-unlock `unlockHistory` (a 36h list of
    unlock times, when that feature is on), and — outside this device's reach —
    the device's identity entry still published in the repo's device registry,
    which the re-init cannot delete because it drops the sync credentials in the
    same transaction. Imported pomodoro audio also survives untouched. So is timing: the
    unlock takes longer than usual (every row is decrypted and re-encrypted), and
    any other open tab reloads. A re-key that fails shows as a wrong passphrase
    but, unlike one, is neither counted toward the wipe tripwire nor logged as a
    failed attempt.
  - **Outside what a web page can clean:** the OS notification history (a nudge
    shown before the coercion may stay in the OS's own log after the app closes
    it; one shown without the service worker can't even be enumerated), browser
    history entries of `?capture=` / `web+gtd:` links (the captured page's title
    and URL), clipboard history, and the downloads folder.
  - **Open decision:** nudge notifications quote the task title on Paranoid
    devices too — a disclosure to the OS notification store that exists
    independently of this feature.
  - **Deliberately not treated as content:** Pomodoro preset names, imported sound
    file names, saved mind-map palette names and the device name — user-chosen
    labels, left as they are, the same classification that leaves them
    unencrypted at rest.
  - A **weak secondary passphrase is a real pre-coercion risk** (slot 2 wraps the
    real DEK), so it is held to the same strength gate (ACR-014) as the main
    passphrase and must differ from it.

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

- **Unattended unlocked session (2026-09-22).** A keylogger is not needed to
  abuse an unlocked laptop left for a moment: until this date, whoever sat down
  could enrol their own security key, set a secondary passphrase, add an
  approver device or set the attempt-wipe limit to 0 with no passphrase asked.
  Every such change now needs the passphrase (Scenario 3's key management is
  the list). Against a keylogger that already has the passphrase this changes
  nothing — the point is the session, not the keystrokes.

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
    Argon2id, so a **weak syncPassword is GPU-brute-forceable**. Changing the
    password protects only what is written *afterwards* (post-compromise
    security, §4): whoever copied the repo or logged the traffic before keeps
    reading that copy, and unreachable git objects survive until GitHub's
    garbage collection — there is no forward secrecy here. Since 2026-09-22 the
    change does rotate the whole repo (snapshot, changelog, every shared file,
    the backups, the registry MACs) and squashes the history on the spot;
    before, it left the shared files and backups under the old key and made
    every shared file unreadable.
  - **Paranoid Mode does not help here** — it never changes the backend bytes.
  - **Recommendations:** use a **strong, high-entropy syncPassword**; a PAT with
    **write** access also enables data destruction/tampering (use least
    privilege). Repo history squashing is **automatic** (~monthly on the default
    branch, plus the blob branch after deletes) — nothing to do by hand; it
    shrinks the standing ciphertext window but does not help against an attacker
    who already cloned or proxied it.

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
- **After a sync-password change** the registry's MACs are under the old
  password and read as forged. The device that changed it republishes its own
  entry as part of the rotation; every other device republishes when it adopts
  the new password (the password prompt does it), and approver devices also do
  whenever the salt they last published under changes. Until a device has come
  back, its entry is missing, not wrong — nothing trusts an old-MAC entry.
- **Identity-key trust.** The registry MAC (syncPassword-derived) stops a PAT-only
  attacker from injecting or substituting approver identity keys; enrolment is
  **owner-gated** (only an unlocked owner can grant an approver — delivering RUK needs
  the live DEK) and **fingerprint-confirmed**. **Revocation exists since
  2026-09-20** and re-keys: removing an approver generates a fresh RUK, hands it
  to every device that stays, re-wraps the DEK under it, and clears the removed
  device's mailbox invite. Delivery happens *before* the re-wrap, so a failure
  aborts with the old key still valid for everyone rather than leaving the vault
  wrapped under a key nobody holds; the operation is idempotent and converges on
  retry. Removing the last approver turns the feature off instead of leaving a
  dead wrap. **Honest limit:** rotation protects this disk *from here on* — a
  disk image taken **before** the removal is still openable with the copy that
  device already has, because a key cannot be un-copied. (Before this there was
  no per-approver removal at all, the teardown rotated nothing, and the receiving
  device discarded any re-issued invite, so a re-key silently failed to land.)
  Residual: trust is only as strong as the
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

### Forward secrecy vs. post-compromise security — what rotation does and does not do

Two properties, often confused, neither free:
- **Forward secrecy:** a key obtained *today* does not open what was captured
  *earlier*.
- **Post-compromise security** (backward secrecy): a key obtained *earlier* does
  not open what is written *after* the owner rotates.

**Neither key here gives forward secrecy, and nothing in this design can.** The
sync content key is derived from a static password: whoever captured ciphertext
(a TLS proxy, a repo clone, git history, a disk image) and later learns the
password reads all of it, forever — Scenario 7's "harvest now, crack later". At
rest, an old disk image plus the passphrase or DEK of that time opens that image.
Forward secrecy for a multi-device store would need per-device secrets that are
not derived from the password (an enrolment ceremony between devices) — a
redesign this app does not attempt — and against a proxy that already captured
everything there is no forward secrecy to be had with a password-derived key at
all.

**Post-compromise security is what rotation buys:**
- **At rest — re-key (2026-09-22).** A fresh DEK; everything on the device
  rewritten under it (the header entry of that date has the mechanics). After
  it, a copied wrapped DEK plus the old passphrase, a removed security key, a
  revoked approver's remote-unlock key, or a DEK from a memory dump open
  **nothing written from then on**. Old ciphertext in IndexedDB free space
  (Scenario 2's forensic residue) is unreadable without the old image *and* the
  old key — the crypto-shredding the secondary-passphrase re-init already
  relied on.
- **On the wire — changing the sync password (complete since 2026-09-22).**
  Derives a new key at a new salt and rewrites everything the old key covered:
  the snapshot and changelog, every live Shared Folder blob (as one root commit
  of the blob branch), the three tier backups and this device's registry MAC,
  drops the migration backups, and squashes the default branch on the spot so
  the old-key objects are unreachable. Resumable from any interruption (the new
  salt is pinned locally; the same password completes it). Other devices are
  asked for the new password on their next sync — anything they had not pushed
  by then is lost, which the dialog says before starting. Until that date the
  change re-encrypted the snapshot only and made every shared file unreadable.

**What rotation does not do**, said once so no scenario has to hedge: it does
not un-copy — a clone, proxy log or disk image taken before the rotation stays
exactly as readable as it was, to whoever holds its key. It does not erase —
IndexedDB does not securely delete overwritten pages, and GitHub garbage-collects
unreachable objects on its own schedule. And it is only as good as its trigger:
the app cannot know a key leaked. **Re-key after removing a security key or a
trusted device, after typing the passphrase on a machine you do not trust, and
after any suspected copy of the device's storage** (Recommendation 10).

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
ships a **Content-Security-Policy** meta. The full policy, so the gaps are
visible: `default-src 'self'`; `script-src 'self' 'wasm-unsafe-eval'`;
`style-src 'self' 'unsafe-inline'`; `img-src 'self' data: blob:`;
`font-src 'self' data:`; `connect-src 'self' https://api.github.com`;
`worker-src 'self' blob:`; `manifest-src 'self'`; `object-src 'none'`;
`base-uri 'self'`; `form-action 'self'`. `img-src` allowed **any https host**
until 2026-09-20, which left an injected script a beacon to anywhere it liked;
nothing in the app loads a remote image, so it was removed and the exfiltration
claim below now holds. `'unsafe-inline'` for styles remains, for runtime-injected
Tailwind. This raises the bar for injected-script and exfiltration attacks but
cannot stop an attacker who can replace the served bundle itself. It is build-only (the dev server needs
inline/eval for HMR).

`'wasm-unsafe-eval'` (added 2026-07-24) permits **WebAssembly compilation only — not JS
`eval`** — and is required by the Argon2id vault KDF (hash-wasm). Residual: a script
that already executes on the origin could compile attacker-supplied wasm bytes, but
script execution on the origin is already the game-over condition above; no new
injection vector is opened. **Incident note:** from the CSP's introduction (2026-06-09)
until this fix, every Argon2id operation threw in production — vaults upgraded to
Argon2id during 2026-06-05→09 could not passphrase-unlock (masked in practice by
relaxed unlock / the PRF security key), secondary-passphrase setup failed, and the
transparent PBKDF2→Argon2id upgrade rejected an otherwise-successful unlock's promise.
That upgrade is now **fail-safe** (caught + recorded to diagnostics; the unlock stands),
and `setSecondaryPassphrase` reports KDF failures as a clear user-facing error.

**Backup retention caveat:** enabling Paranoid Mode stops *new* backups but does **not**
retroactively delete remote backups created earlier (while OFF). Those older plaintext
snapshots may persist in the sync repo's history until pruned/rotated. Rotate the
syncPassword and prune old backups if the earlier plaintext exposure matters.

- **Web Share Target (Android "share to GTD25").** The share target is **POST /
  share-target (multipart/form-data)**, so shared content travels in the request
  **body, not the URL** — this removes the earlier GET-in-query-string exposure
  (no shared title/text/url in browser history, the address bar, or SW URL logs).
  The service worker can't reach the encrypted store, so it **stashes the payload in
  Cache Storage** and redirects the app to consume it: the app **prompts the user**
  to file the share as an **Inbox task** or into the **E2E-encrypted Shared Folder**
  (a shared file's bytes always land in the Shared Folder; choosing Inbox
  additionally creates a task pointing at the file). **Residual:** the Cache stash holds
  the shared bytes/text in **plaintext** until the client consumes and deletes it
  (best-effort `caches.delete`). On a **Paranoid + locked** device the stash therefore
  persists in Cache Storage **in plaintext until the vault is unlocked** and the app
  (mounted only when unlocked) processes it — a same-origin, device-local exposure for
  the share window. Since 2026-07-29 the **lock screen says a share is being held**, so
  sharing into a locked device no longer looks like a silent failure; that notice is
  **presence-only** — it reads the stash's timestamp and renders no shared content —
  and the payload is still filed only after unlock, by the same post-unlock prompt,
  for any unlock path (passphrase, security key, remote unlock). Its only new
  disclosure is *that* a share exists to whoever holds the locked device.
  The stash lifetime is **bounded** (ACR-017): the app sweeps the
  stash on **every unlocked start** — not only on the `?shareTarget` redirect — so an
  orphaned stash (redirect lost, app next opened from the launcher) is offered if
  fresh and **purged unconsumed after 24h**; an unanswered destination prompt (or an
  explicit "ask me later") keeps the stash for the next start, so the worst-case
  plaintext window is **unchanged** — the same 24h TTL + sweep bound applies whether
  or not the user has answered; the error path clears any partial stash
  on both the SW and client ends. A shared **file** whose blob upload can't run yet
  because **sync isn't initialised at consume time** (the consume runs at startup,
  before the sync key finishes deriving) is **not dropped or half-saved**: the client
  waits briefly for sync, and if it stays unavailable keeps the stash and defers the
  **whole** payload to the next unlocked start — still within the same 24h plaintext
  bound (so the worst-case exposure window is unchanged). The SW also **caps what it stashes** (ACR-018):
  ≤ 20 files, ≤ 30 MB per file and in aggregate (mirroring the Shared Folder quota,
  which remains the authoritative consume-time check), with skipped files surfaced to
  the user. Residual: the plaintext-until-unlock window on a locked Paranoid device
  remains. Mitigation: shares are user-initiated; unlock promptly, or don't share
  into a locked Paranoid device. (The bookmarklet capture still uses a GET
  `?capture` URL, which is scrubbed at the earliest point — ACR-004. Since
  2026-07-27 the manifest also declares `handle_links: 'preferred'` and registers
  the **`web+gtd:` protocol handler**, so a capture can launch the installed
  **app window** instead of a tab; its payload arrives in `?protocol=` and is
  scrubbed by the same ACR-004 path before any async work. No new capability —
  any site could already navigate to `?capture`, and both shapes run the same
  sanitiser — but two things are worth stating. **Surfacing:** a link from
  elsewhere can now bring the app window forward, which on an unlocked device
  puts content on screen; a locked Paranoid device still shows only the lock
  screen, and the browser gates the first protocol launch behind its own
  permission dialog. **Link validation:** every capture entry point is
  attacker-drivable, so a `url` param is only stored as the task's link when it
  is http(s) — a `javascript:`/`data:` value is dropped at capture time instead
  of relying solely on the render-time href sanitiser.)
- **Metadata is never protected.** Structure, timing, due dates, status, sizes,
  and device/activity patterns leak everywhere.
- **Git history + a logging TLS proxy are append-only from the defender's view.**
  Anything ever synced may be retained by an adversary; you cannot retroactively
  un-expose it. Key rotation is **forward-secret only**.
- **The diagnostics error log is local-only plaintext.** It lives in a ring buffer
  (never synced) the user can read/copy from Settings; since 2026-07-24 it also
  **persists across reloads/updates** in plaintext `localStorage`
  (`gtd25-diagnostics-log`), because a memory-only log kept vanishing before the
  error it existed to report could be read. Bounded: 100 entries, pruned after
  **7 days**, clearable from Settings, and removed by panic-wipe's `gtd25-*`
  localStorage sweep. To keep it from becoming a content sink, `recordError` only
  ever stores the text of `Error`/string inputs (plus a capped stack); any other
  thrown/rejected value is reduced to its type (`[Object]`), so an unexpected throw
  carrying an entity payload cannot leak its fields into the log. Messages/stacks
  are length-capped, and are additionally **scrubbed before storage** (ACR-015) —
  before anything touches disk: GitHub tokens, `Authorization`/`Bearer` values,
  Web-Share-Target query content (`title`/`text`/`url`), and long high-entropy
  base64 blobs (keys/ciphertext) are replaced with `[redacted…]`. Residual: scrubbed
  error metadata (context labels + messages) now rests on disk in plaintext for up
  to a week, on Paranoid devices too — accepted for debuggability; it never holds
  task/vault content by construction.
- **Client-side timed/failure wipes only run when our code runs** — useless
  against an offline disk image or memory dump. The same applies to **remote wipe**
  (Scenario 8): it is delivered only while the protected app is open and online
  (locked or unlocked).
- **What runs while locked is minimal but no longer nil.** The full list is the
  service-worker update detector/prompt, the remote-wipe watcher and lock-screen
  unlock poll (both only when Scenario 8 is enrolled), the pomodoro clock, and
  the **locked nudge** — which reads the plaintext metadata columns of
  `taskLists`/`tasks` every 60s (never content: without the DEK the rows are
  ciphertext), writes `localSettings.lastNudgeAt`, and can fire an OS
  notification saying work is due. That last one is a "this device has pending
  work" signal that exists while locked, and it mutates IndexedDB on a
  60-second beat. The lock screen also purges an expired share stash (a
  timestamp read and a delete; no key involved). Taking them in turn: the service
  worker update detector/prompt stays mounted on the lock screen so a broken
  locked build can be refreshed without wiping. It can check public update
  metadata, ask a waiting service worker to activate, and reload; it does **not**
  access the DEK, decrypted content, syncPassword, or PAT. Same-commit service
  worker refresh signals are suppressed to avoid update-banner loops. **A
  user-initiated check reports what it actually found (2026-09-22):** it waits
  for the browser's update job instead of a fixed timer, says so when nothing is
  registered to install updates or when the check did not complete, and compares
  the deployed commit against the running one, so a worker that is stuck — or
  whose script the network is rewriting — can no longer report the device as
  current. It mattered: **being able to tell whether you are running the build
  you think you are** is the first thing every other guarantee here rests on. If an update
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
10. **Re-key the device** (Settings → Security) after removing a security key or a
   trusted device, after typing the passphrase on a machine you do not trust, and
   whenever a copy of the device's storage plus the passphrase of that time may
   exist. Post-compromise security, not forward secrecy: what was copied stays
   readable (§4). A passphrase change re-keys by default.

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
