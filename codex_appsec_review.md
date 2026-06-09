# Codex AppSec Review

Date: 2026-06-09
Remediation verified: 2026-06-09 (independent re-review of `main`; see "Remediation Verification" below)

Scope: repository-wide static review of the GTD app, with focus on the end-to-end encrypted sync model, Paranoid Mode, remote unlock/wipe flows, import/export, capture, and diagnostics. The review was grounded in `THREAT_MODEL.md` and source inspection. No dynamic exploit harness or browser-driven testing was run.

Method: Codex Security-style multi-pass review using independent threat-model passes, candidate finding discovery, validation, and attack-path analysis.

> **Status (2026-06-09):** All 16 findings have been remediated or explicitly accepted-and-documented, and each fix was independently re-verified against source and tests. Fixing commits: `9da4610` (ACR-001), `62250bf` (ACR-002/003/004), `f5ccbed` (ACR-005…016), `7a2c2dd` (share target moved to POST), plus a follow-up closing the last ACR-001 recommendation (request digest signed into the approval response). Per-finding verification notes are in "Remediation Verification"; two new low-priority findings from the follow-up review (ACR-017, ACR-018) are at the end — both fixed the same day (stash startup sweep + TTL, SW-side stash caps).

## Executive Summary

The app has a thoughtful crypto design for protecting task content from the backend: sync uses client-side AES-GCM over declared sensitive fields, Paranoid Mode encrypts IndexedDB content at rest, and destructive remote-wipe execution verifies command signatures. I did not find evidence of a straightforward XSS sink such as `dangerouslySetInnerHTML`, and link handling appears to use URL sanitization plus `noopener noreferrer`.

The highest-priority issue is in remote unlock approval: the approver verifies one pending request for display, then re-reads and approves whatever request is currently present. A backend writer or compromised PAT holder can swap the request after the user sees the code, causing the user to encrypt their Recovery Unlock Key to an attacker-controlled session key.

The second high-priority issue is Paranoid Mode idle locking. Background reads through the vault middleware appear to reset the idle timer, so routine app activity can keep the vault unlocked indefinitely even if the user is not interacting with the device.

There are also several medium-priority confidentiality and threat-model gaps: WebAuthn PRF material is logged during security-key enrollment, share-target data can appear in URL logs, Pomodoro sound preset data is synced in plaintext, remote-unlock requests lack requester-side expiry cleanup, and sync integrity would benefit from additional authenticated context and anti-replay controls.

## Findings

| ID | Priority | Severity | Confidence | Area | Status |
| --- | --- | --- | --- | --- | --- |
| ACR-001 | P1 | High | High | Remote unlock | Fixed (verified) — `9da4610` + follow-up |
| ACR-002 | P1 | High | High | Paranoid Mode | Fixed (verified) — `62250bf` |
| ACR-003 | P2 | Medium | High | WebAuthn PRF | Fixed (verified) — `62250bf` |
| ACR-004 | P2 | Medium | High | Share target / SW | Fixed (verified) — `62250bf`, `7a2c2dd` |
| ACR-005 | P2 | Medium | Medium | Sync integrity | Fixed (AAD) + residual documented — `f5ccbed` |
| ACR-006 | P2 | Medium | High | Remote unlock | Fixed (verified) — `f5ccbed` |
| ACR-007 | P2 | Medium | Medium | Remote unlock | Fixed (verified) — `f5ccbed` |
| ACR-008 | P2 | Medium | Medium | Paranoid Mode | Fixed (verified) — `f5ccbed` |
| ACR-009 | P2 | Medium | Medium | Paranoid Mode | Fixed (verified) — `f5ccbed` |
| ACR-010 | P2 | Medium | High | Sync data model | Accepted & documented — `f5ccbed` |
| ACR-011 | P3 | Low/Medium | High | Import | Fixed (verified) — `f5ccbed` |
| ACR-012 | P3 | Low/Medium | Medium | Security key UX | Fixed (verified) — `f5ccbed` |
| ACR-013 | P3 | Low/Medium | Medium | Remote wipe UX | Accepted & documented — `f5ccbed` |
| ACR-014 | P3 | Low | Medium | Secret UX | Fixed (verified) — `f5ccbed` |
| ACR-015 | P3 | Low | Medium | Diagnostics | Fixed (verified) — `f5ccbed` |
| ACR-016 | P3 | Low | High | Threat model / platform | Fixed (verified) — `f5ccbed` |
| ACR-017 | P3 | Low/Medium | High | Share target / SW | New (2026-06-09 follow-up) — Fixed (verified) |
| ACR-018 | P3 | Low | High | Share target / SW | New (2026-06-09 follow-up) — Fixed (verified) |

## Remediation Verification (2026-06-09)

Each finding was re-verified against the current `main` by independent source inspection and by running the regression tests. The original finding texts below are kept unchanged as the audit record.

- **ACR-001 — Fixed.** `readPendingApproval()` returns a canonical SHA-256 `requestDigest` over the signed request bytes (`src/sync/remote-unlock.ts`, `requestDigest()`); `approveRemoteUnlock(pat, repo, fromDeviceId, expectedDigest)` re-reads the request, re-verifies the requester signature, and aborts unless the re-read request hashes to the digest the user saw. The follow-up change also signs the digest into the approval response (`responseBytes` now covers `requestDigest`) and the requester rejects any response not bound to its own pending request's digest — all five recommendations are now implemented. Tests: `src/__tests__/security/remote-unlock-flow.test.ts` ("swapped after the code was shown", "different but validly-signed request", "signs the request digest into the response", "approver-signed response bound to a different request digest").
- **ACR-002 — Fixed.** The vault key provider and `getDEK()` no longer reset the idle timer; only explicit user activity (`touchVaultActivity()`, wired to pointerdown/keydown in `src/App.tsx`) defers re-lock (`src/db/vault.ts`). Test: `src/__tests__/security/vault-lock.test.ts` ("background DB reads do NOT defer the idle re-lock"). Residual (accepted): no hard maximum unlock duration independent of activity; system-level idle lock remains as a separate control.
- **ACR-003 — Fixed.** `src/sync/webauthn-prf.ts` logs only presence booleans (`!!ext.prf?.enabled`, `!!ext.prf?.results?.first`), never PRF output or salts. Repo-wide grep found no console logging of key material. Test: `src/__tests__/security/webauthn-prf-logging.test.ts`.
- **ACR-004 — Fixed.** The share target moved to POST/multipart (`vite.config.ts`, commit `7a2c2dd`): shared content travels in the request body, not the URL. The service worker logs origin+path only (`redactUrlForLog()`, `src/sw.ts`), and the legacy GET capture path scrubs the query string via `history.replaceState` before any async work (`src/hooks/use-url-capture.ts`). Tests: `url-capture-scrub.test.tsx`, `share-target.test.tsx`. Residual: the SW's Cache Storage stash holds the shared payload in plaintext until consumed (documented in `THREAT_MODEL.md`; see also new findings ACR-017/ACR-018).
- **ACR-005 — Partially implemented; residual documented.** Sensitive-field ciphertext is now bound to its record via AES-GCM AAD = `entityType:id` (`entityAad()`, `src/sync/crypto.ts`), so ciphertext cannot be silently relocated across records or entity types (test: `src/__tests__/sync/crypto.test.ts` AAD cases). Snapshot-level MAC/signature, anti-replay counters, and field-name binding are NOT implemented; `THREAT_MODEL.md` explicitly documents rollback/replay and plaintext-metadata tampering as accepted residual risk.
- **ACR-006 — Fixed.** Requester-side pending state carries `expiresAt` (request TTL); on expiry the in-RAM session key is zeroed and the stale remote request deleted (`pendingUnlockExpired()` / `expirePendingUnlock()`, `src/sync/remote-unlock.ts`). Test: "requester-side expiry (ACR-006)" suite.
- **ACR-007 — Fixed.** Approver invites are signed over canonical bytes binding recipient, sender, timestamp, and the exact RUK ECIES blob (`inviteBytes()`); `pollApproverInbox()` verifies the signature against the MAC-authenticated registry entry and uses registry-derived (not self-asserted) sender identity. Tests: three ACR-007 cases in `remote-unlock-flow.test.ts` (unsigned, tampered, non-registry sender).
- **ACR-008 — Fixed.** `finishUnlock()` (`src/db/vault.ts`) validates all vault secrets into locals before assigning `currentDek`; post-verifier errors roll back `currentDek`/`currentSecrets` and the idle timer. Test: `vault-attempt-wipe.test.ts` ("does not leave the DEK resident when vault secrets are corrupt").
- **ACR-009 — Fixed.** Unlock attempts are serialized (`serializeUnlock()` promise chain) and `registerFailedAttempt()` re-reads the latest persisted vault record before incrementing. Test: `vault-attempt-wipe.test.ts` ("counts every concurrent wrong attempt").
- **ACR-010 — Accepted & documented.** Pomodoro settings and sound-preset names are classified as plaintext metadata by design in `THREAT_MODEL.md` (with the explicit caveat that user-authored preset names are backend-visible).
- **ACR-011 — Fixed.** Import limits enforced before parse/decompress: ZIP 50 MB, decoded payload 80 MB, 200k records per array (`src/db/export-import.ts`); sound archives 100 MB, 200 files, 15 MB/file, 150 MB aggregate (`src/db/sound-import.ts`). Tests: `export-import.test.ts`, `sound-import.test.ts` rejection cases.
- **ACR-012 — Fixed.** `refreshSecurityKeyFlag()` (`src/db/vault.ts`) derives security-key availability from vault metadata and self-heals the localStorage cache; the lock screen calls it on mount. Test: `vault-security-key.test.ts` ("re-derives the security-key flag…").
- **ACR-013 — Accepted & documented.** Wipe execution remains signature-verified (the critical control). The "pending" lifecycle status is derived from the unsigned command file by design, labeled advisory in the UI (`SecuritySettings.tsx`), and documented as such in `THREAT_MODEL.md`; confirmed status is device-signed.
- **ACR-014 — Fixed.** A dependency-free strength gate (`src/lib/password-strength.ts`: min length 10, common-password list, character variety) blocks clearly weak vault passphrases and sync passwords at enrollment. Residual: intentionally lighter than zxcvbn; unique-but-mediocre passphrases can pass. Test: `password-strength.test.ts`.
- **ACR-015 — Fixed.** `redactSecrets()` (`src/lib/diagnostics.ts`) strips GitHub token formats, Authorization/Bearer headers, share-target query params, and long base64 blobs from all recorded messages and stacks. Test: `diagnostics.test.ts`.
- **ACR-016 — Fixed.** `THREAT_MODEL.md` gained a "Trusted Computing Base" section (hosting, build pipeline, SW update channel, browser/OS); a production CSP is injected at build time (`vite.config.ts`): `default-src 'self'`, `script-src 'self'` (no inline script), `connect-src 'self' https://api.github.com`, `object-src 'none'`. Residual: `style-src 'unsafe-inline'` retained for runtime style injection; a CSP cannot defend against a compromised served bundle (documented).

## Follow-up Review (2026-06-09)

A second pass targeted code that landed after the original audit snapshot or that the audit covered only lightly: the POST share-target pipeline (`src/sw.ts`, `src/lib/share-target.ts`, `src/hooks/use-share-target.ts`), the Shared Folder blob lifecycle (`src/sync/shared-blobs.ts`), default-branch history squashing (`src/sync/history-compaction.ts`), and a repo-wide sweep for sensitive-material logging and new plaintext sync fields.

Clean areas: Shared Folder blobs use two correctly separated crypto layers (sync-key AES-GCM on the wire; DEK at rest when Paranoid, applied in `shared-blobs.ts` because the field-oriented middleware can't handle binary); blob ids are random with no filename/type leak and all `sharedItem` metadata fields are sync-encrypted; blob-branch compaction and default-branch squashing rebuild orphan commits and re-check the ref before force-updating, and only ciphertext ever becomes GC-pending unreachable history; capture/share links pass through `sanitizeUrl()` (non-http(s) → `#`) at render; no console logging of key material was found. Two new findings, both in the share-target stash lifecycle, are documented as ACR-017 and ACR-018 below; both were fixed the same day.

## ACR-001: Remote Unlock Approval Request Can Be Swapped After Code Display

Affected code:

- `src/sync/remote-unlock.ts`
- `readPendingApproval()` verifies the pending request signature, freshness, and code before the UI displays it.
- `approveRemoteUnlock()` re-reads `devices/{requester}/pendingUnlockRequest` and only checks expiry before using the re-read `epk` to encrypt `entry.ruk`.

Attack:

1. A legitimate requester creates a signed pending unlock request.
2. The approver device reads and verifies it, then displays the human confirmation code.
3. Before approval is submitted, a backend writer, compromised PAT, or malicious same-account sync client replaces the pending request with a new request using attacker-controlled ECIES key material.
4. `approveRemoteUnlock()` encrypts the Recovery Unlock Key to the swapped request.

Impact: the attacker receives a valid remote-unlock response encrypted to a key they control and can recover `entry.ruk`. This bypasses the human code-verification ceremony.

Existing controls: request display verification is present, and the response is signed by the approver. The gap is that approval is not bound to the exact verified request.

Recommended fix:

- Return a canonical request digest from `readPendingApproval()`.
- Include verified immutable request fields in the approval object: requester id, nonce, `epk`, ciphertext, issue time, expiry, and signature.
- In `approveRemoteUnlock()`, re-fetch the pending request and require its canonical digest to match the digest that was displayed to the user.
- Prefer passing the verified request object into approval instead of trusting a fresh backend read.
- Include the request digest in the signed approval response.

Recommended tests:

- Unit test: verify request A, replace backend document with request B, call approval for A, assert approval fails.
- Unit test: approve unchanged request A, assert response includes and signs A's digest.

## ACR-002: Paranoid Mode Idle Lock Can Be Kept Alive by Background DB Reads

Affected code:

- `src/db/vault.ts`
- `setVaultKeyProvider()` resets the idle timer whenever the middleware asks for the DEK.
- `src/db/vault-middleware.ts`
- `src/App.tsx`
- `src/hooks/use-recurring.ts`

Attack:

While a vault is unlocked, background app code reads encrypted stores through the vault middleware. For example, recurring-task checks run on an interval and query task data. Because middleware reads call the key provider, and the key provider resets idle state, non-user activity can keep the vault unlocked.

Impact: Paranoid Mode's inactivity guarantee is weakened. On an untrusted or shared device, the vault may remain unlocked far longer than the configured idle timeout while the tab remains open.

Existing controls: system idle detection still exists, and manual lock remains available. The application idle lock is the affected control.

Recommended fix:

- Separate "DEK access" from "user activity."
- Only pointer, keyboard, focus, visibility, or explicit user actions should refresh idle timers.
- Middleware should retrieve the current DEK without extending idle time.
- Consider a hard maximum unlock duration independent of activity for Paranoid Mode.

Recommended tests:

- Fake timers: unlock vault, perform periodic DB reads without user activity, assert auto-lock fires.
- Fake timers: unlock vault, emit user activity before timeout, assert auto-lock extends.

## ACR-003: WebAuthn PRF Extension Result Is Logged During Enrollment

Affected code:

- `src/sync/webauthn-prf.ts`

Issue:

The WebAuthn registration path logs `ext.prf`. Depending on authenticator/browser behavior, that object may include PRF output material under `results.first`, which is used as key-encryption-key material for Paranoid Mode.

Impact: sensitive key material can be exposed to browser devtools, console collection, or any diagnostic capture that includes console logs.

Recommended fix:

- Remove the `console.log` of PRF extension output.
- If debugging is needed, log only booleans such as "PRF supported" and never log PRF results or salts.
- Add a regression check or lint rule for logging `prf`, `ruk`, `dek`, `kek`, or raw cryptographic bytes.

Recommended tests:

- Unit or integration check that security-key enrollment does not call console logging with extension results.

## ACR-004: Share Target Content Can Leak Through GET Query Strings and Service Worker Logs

Affected code:

- `vite.config.ts`
- `src/hooks/use-url-capture.ts`
- `src/sw.ts`

Issue:

The PWA share target uses `method: "GET"` with `title`, `text`, and `url` query parameters. The app later clears the URL with `history.replaceState`, but the service worker logs the fetch URL first. Shared text, links, and titles can therefore appear in browser history, devtools, service-worker logs, screenshots, or copied diagnostics.

Impact: captured task content can leak outside the encrypted data model before it is stored.

Recommended fix:

- Prefer a POST-based Web Share Target with form data, then immediately transfer content to the app.
- Remove request URL logging in the service worker, or redact query strings before logging.
- If GET must remain for compatibility, keep query values minimal and clear them at the earliest possible point.

Recommended tests:

- Share-target test: captured content is accepted.
- Service-worker test: logs do not contain query parameters or shared text.

## ACR-005: Sync Ciphertexts Need Stronger Authenticated Context and Anti-Replay Semantics

Affected code:

- `src/sync/crypto.ts`
- `src/sync/sync-engine.ts`

Issue:

Sensitive fields are encrypted with AES-GCM, but the threat model should more explicitly define what metadata and object context are authenticated. A backend writer should not be able to replay old encrypted field values, swap ciphertexts across compatible records, downgrade snapshots, or tamper with plaintext metadata without clear detection semantics.

Impact: confidentiality of encrypted fields may remain intact, but integrity and freshness of the synchronized task graph can be degraded. For a GTD app, tampering with due dates, list membership, completion state, recurrence metadata, or replaying old task content can create real workflow harm.

Recommended fix:

- Use AES-GCM AAD that includes at least: dataset id, record type, record id, field name, schema version, and sync generation or object revision.
- Add snapshot-level signatures or MACs over canonicalized metadata and encrypted fields.
- Add monotonic per-device operation counters or vector-clock style anti-replay checks.
- Document exactly which metadata tampering remains accepted by design.

Recommended tests:

- Ciphertext from task A cannot be moved to task B.
- Ciphertext from field `description` cannot be moved to field `title`.
- Old snapshot replay is detected or explicitly resolved according to documented policy.

## ACR-006: Remote Unlock Requester-Side Expiry Is Not Enforced After Request Creation

Affected code:

- `src/sync/remote-unlock.ts`

Issue:

The requester stores pending unlock state in memory with a nonce and ephemeral key, then polls for a response. The pending state does not appear to carry or enforce `expiresAt` on the requester side. Approvers reject stale requests, but a signed response for the still-resident nonce can be accepted as long as the tab keeps the pending key material.

Impact: stale unlock ceremonies may remain viable longer than intended if a tab stays open. This increases the useful window for delayed or replayed responses.

Recommended fix:

- Store `expiresAt` with pending requester state.
- Refuse responses and wipe the ephemeral key after expiry.
- Delete the remote pending request when local expiry fires.
- Include the original request digest in the response signature and verify it.

Recommended tests:

- After expiry, a validly signed response for the nonce is rejected.
- Pending ephemeral key material is cleared after expiry or cancellation.

## ACR-007: Approver Invites Are Decrypt-Only, Not Source-Authenticated

Affected code:

- `src/sync/remote-unlock.ts`

Issue:

Approver invites are encrypted to the recipient, but the invite acceptance path trusts decrypted fields such as sender id, sender name, sender signing key, and Recovery Unlock Key. If a malicious same-account writer can create a decryptable invite, the recipient may register attacker-controlled approver relationships.

Impact: this can confuse the trust graph and create social-engineering or recovery-flow attacks, even if later unlock request signatures are checked.

Recommended fix:

- Sign invites with the sender's established device signing key.
- Bind invite fields into the signature: recipient id, sender id, sender public keys, RUK id, issued time, expiry, and invite purpose.
- Show a verifiable device fingerprint during pairing.
- Consider requiring an out-of-band code for approver enrollment.

Recommended tests:

- Unsigned invite is rejected.
- Invite with modified sender key or recipient id is rejected.

## ACR-008: Partial Unlock Failure Can Leave the DEK Resident

Affected code:

- `src/db/vault.ts`

Issue:

The unlock path sets `currentDek = dek` before all unlock validation has completed. If later validation fails, for example due to corrupt vault secrets, the DEK can remain resident while the UI may still consider the vault locked or failed to unlock.

Impact: inconsistent lock state and avoidable key residency after failed unlock.

Recommended fix:

- Validate all required vault secrets before assigning `currentDek`.
- Use a local variable for candidate DEK material until unlock is fully complete.
- On any unlock error path, explicitly wipe candidate/current key material and reset lock state.

Recommended tests:

- Corrupt `vault.secrets`, attempt unlock, assert `isVaultUnlocked()` is false and protected DB reads fail.

## ACR-009: Failed Unlock Attempt Counter Can Race

Affected code:

- `src/db/vault.ts`

Issue:

Failed unlock attempts are derived from a `vault` object that may be stale across concurrent attempts. Multiple wrong attempts can race and collapse to a smaller count.

Impact: the optional wipe-after-failed-attempts control can be delayed or bypassed by concurrency.

Recommended fix:

- Increment attempts transactionally against the latest persisted vault record.
- Serialize unlock attempts with an in-process mutex.
- Treat concurrent unlock attempts as one active operation and reject additional attempts until it completes.

Recommended tests:

- Launch concurrent wrong unlock attempts and assert the stored counter increments once per attempt or the attempts are serialized.

## ACR-010: Pomodoro and Sound Preset Data Are Synced in Plaintext

Affected code:

- `src/sync/crypto.ts`
- `src/sync/sync-engine.ts`
- `src/db/vault-middleware.ts`
- `src/components/pomodoro/PomodoroSettingsModal.tsx`

Issue:

`SENSITIVE_FIELDS` covers task-list names and task/subtask content, but Pomodoro settings and sound presets are included in sync snapshots without field encryption. Sound preset names are user-authored and can contain personal context. Paranoid Mode at-rest middleware also appears scoped to tasks, subtasks, task lists, and changelog records.

Impact: backend-visible sync snapshots can reveal user-authored preset names, productivity patterns, notification choices, and possibly uploaded audio metadata. This may be acceptable metadata, but it is not called out clearly in the threat model.

Recommended fix:

- Decide whether Pomodoro settings and sound preset names are content or metadata.
- If content, add them to field-level sync encryption and Paranoid Mode at-rest encryption.
- If metadata, explicitly list them in `THREAT_MODEL.md` as plaintext by design.

Recommended tests:

- Sync snapshot test asserts preset names are encrypted or explicitly redacted.
- Vault test asserts local preset records are encrypted if they are classified as sensitive.

## ACR-011: ZIP and Sound Imports Lack Resource Limits

Affected code:

- `src/db/export-import.ts`
- `src/db/sound-import.ts`

Issue:

ZIP import reads archive entries and JSON payloads before applying strict size, count, or decompressed-content limits. Sound import accepts every `.m4a` and `.mp3` entry without clear aggregate size or count limits.

Impact: malicious or accidental imports can consume memory, storage, or CPU, causing a denial of service in the browser. I did not see a zip-slip issue because the code reads named entries rather than extracting paths to disk.

Recommended fix:

- Enforce maximum archive size, decompressed `data.json`/`data.enc` size, record counts, string lengths, and sound count/aggregate bytes.
- Reject nested paths or unexpected entries unless explicitly supported.
- Stream or chunk large inputs where feasible.

Recommended tests:

- Oversized `data.json` is rejected before parse.
- Excessive sound files are rejected with a user-facing error.

## ACR-012: Security-Key Unlock Depends on a LocalStorage Capability Flag

Affected code:

- `src/db/vault.ts`
- `src/components/LockScreen.tsx`

Issue:

The UI's security-key availability depends partly on a `localStorage` flag. Clearing or tampering with localStorage can hide the security-key unlock path and push the user toward passphrase unlock.

Impact: this is primarily a downgrade and recovery UX issue, not a direct crypto bypass. On untrusted devices it may weaken the intended "use hardware key here" behavior.

Recommended fix:

- Derive security-key availability from vault metadata whenever possible.
- Treat localStorage only as a cache.
- Offer a hardware-key-only mode that removes the passphrase wrapper after enrollment, if that matches the product's recovery model.

Recommended tests:

- With vault metadata indicating security-key enrollment and localStorage cleared, the key unlock option remains visible.

## ACR-013: Remote Wipe Lifecycle UI Trusts Unsigned Pending Metadata

Affected code:

- `src/sync/remote-wipe.ts`

Issue:

Remote wipe execution verifies signed commands, which is the critical control. Some lifecycle and display code around pending commands, status entries, and registry deletion appears to consume backend state that may be writable by the sync backend or another device.

Impact: attackers may not be able to force an unsigned wipe execution, but they may be able to confuse owner-side UI status or device lifecycle displays.

Recommended fix:

- Sign or MAC owner-visible pending wipe metadata.
- Bind status updates to signed command ids.
- Treat unsigned status as advisory and label it as such in the threat model.

Recommended tests:

- Forged status for a non-issued command is ignored or marked untrusted.

## ACR-014: Weak-Secret UX Is Mostly Advisory

Affected code:

- `src/sync/sync-password.ts`
- `src/db/vault.ts`
- passphrase and sync password enrollment UI

Issue:

The threat model relies on high-entropy sync passwords and Paranoid Mode passphrases. Existing UI guidance may not be enough to prevent weak secrets.

Impact: offline guessing risk against exported/synced encrypted data if users choose weak secrets. PBKDF2 and Argon2id parameters help, but cannot compensate for very weak input.

Recommended fix:

- Add zxcvbn-style strength checks and block clearly weak passphrases/passwords.
- Encourage generated recovery phrases for sync passwords.
- Show distinct warnings for sync password and local vault passphrase because they protect different attack surfaces.

Recommended tests:

- Common weak passwords are rejected.
- Long random passphrases are accepted.

## ACR-015: Diagnostics Should Redact Error/String Secrets

Affected code:

- `src/lib/diagnostics.ts`

Issue:

Diagnostics intentionally avoid JSON-stringifying arbitrary object payloads, which is good. Error messages, string payloads, and stacks can still include captured URLs, PAT-like tokens, task content, or other secrets.

Impact: copied diagnostics can disclose sensitive user content or credentials.

Recommended fix:

- Redact common token formats, `?title=`, `?text=`, `?url=`, authorization headers, and long high-entropy strings.
- Consider a "copy diagnostics" preview that makes redaction visible.

Recommended tests:

- Error containing a PAT-like token is redacted.
- Error containing share-target query parameters is redacted.

## ACR-016: Threat Model Should Explicitly Cover Platform Trust Boundaries

Affected documents/code:

- `THREAT_MODEL.md`
- `index.html`
- service worker and deployment pipeline

Issue:

The threat model correctly says metadata is plaintext and same-origin XSS is high impact, but it should be more explicit about platform trust boundaries:

- GitHub Pages or hosting compromise is equivalent to serving malicious same-origin code.
- Build pipeline, dependency compromise, and service-worker update compromise are full client compromise.
- Existing non-Paranoid remote backups may remain after enabling Paranoid Mode.
- Browser extensions and local OS malware are out of scope unless separately mitigated.

Recommended fix:

- Add a dedicated "Trusted Computing Base" section to `THREAT_MODEL.md`.
- Add a strict CSP in `index.html` where compatible with the Vite build.
- Document remote-backup retention and provide an optional backup-pruning flow when enabling Paranoid Mode.

Recommended tests:

- CSP smoke test for production build.
- Verify the app runs without inline script/style violations or document required exceptions.

## ACR-017: Share-Target Stash Can Be Orphaned in Plaintext Cache Storage

Found in the 2026-06-09 follow-up review (post-audit code, commit `7a2c2dd`). Status: **fixed** (same day).

Fix implemented: `useShareTarget` now sweeps the stash on every unlocked app start (probing `caches.has` first so a normal launch never creates the cache), not only on the `?shareTarget` redirect — a fresh orphaned stash is consumed, one older than `SHARE_STASH_TTL_MS` (24h) is purged unconsumed; the `?shareTarget=error` path clears the (possibly partial) stash on both ends (client `clearStash()` and the SW's own catch). Tests: `share-target.test.tsx` ("consumes an orphaned fresh stash", "purges a stale orphaned stash", "clears a (possibly partial) stash on the SW error redirect", "does not touch the URL or the (empty) cache on a normal launch").

Affected code:

- `src/sw.ts` — `handleShareTarget()` stashes the shared payload (meta + file bytes) in Cache Storage, then redirects to `/?shareTarget=1`.
- `src/hooks/use-share-target.ts` — the consumer runs only when the `shareTarget` URL flag is present, and only inside the unlocked app.

Issue:

The stash is consumed (and cleared) only when the app loads with `?shareTarget=1`. If that navigation is lost — the user shares to a locked Paranoid device and closes the tab before unlocking, the redirect fails, or the app is next opened normally from the launcher — the plaintext payload remains in Cache Storage indefinitely. Nothing else ever sweeps `SHARE_CACHE`. Two adjacent gaps compound this:

- The `?shareTarget=error` path returns without calling `clearStash()`, yet a partial stash is possible (in `handleShareTarget()` the meta `cache.put` can succeed before a file `cache.put` fails and triggers the error redirect).
- `meta.ts` (the stash timestamp) is recorded but never read, so there is no age-based expiry.

Impact: shared content (titles, links, text, file bytes) can persist in plaintext outside the encrypted data model for an unbounded time, including on Paranoid devices whose at-rest guarantee the user relies on. Exposure requires local/same-origin access, so this is a residual-confidentiality issue, not a remote one.

Recommended fix:

- Sweep the share stash on every unlocked app start, not only when the URL flag is present: consume it if fresh, purge it if stale (use the existing `meta.ts` with a TTL of e.g. 24h).
- Call `clearStash()` on the `error` path too.
- Document the (shortened) stash window in `THREAT_MODEL.md`.

Recommended tests:

- Stash present without the URL flag → consumed or purged on app start.
- Stale stash (old `meta.ts`) → purged without import.
- `?shareTarget=error` → stash cleared.

## ACR-018: Service Worker Stashes Shared Payloads Without Size or Count Limits

Found in the 2026-06-09 follow-up review (post-audit code, commit `7a2c2dd`). Status: **fixed** (same day).

Fix implemented: `handleShareTarget()` filters files through `selectFilesToStash()` (`src/lib/share-target.ts`) before stashing — per-file and aggregate caps of 30 MB (mirroring `MAX_SHARED_FOLDER_BYTES`) and at most 20 files; the skipped count travels in the stash meta and the app toasts "N shared file(s) were too large to receive" after consume. The consume-time quota in `createFileItem` remains the authoritative check. Tests: `share-target.test.tsx` (`selectFilesToStash` cap suite + skipped-files toast).

Affected code:

- `src/sw.ts` — `handleShareTarget()` writes every shared file into Cache Storage unconditionally.
- `src/hooks/use-shared-items.ts` — the Shared Folder quota (30 MB) is enforced only later, at consume time in `createFileItem()`.

Issue:

The OS share sheet can hand the SW arbitrarily large files (e.g. a multi-GB video). The SW stashes everything before any limit applies, so the browser's storage quota can be consumed by content that the app would reject anyway. This mirrors ACR-011's import-limits concern, applied to the share-target entry point.

Impact: storage exhaustion / denial of service on the origin's quota; mostly self-inflicted, but a single mis-share can degrade the app (failed cache writes, eviction pressure on other cached data). No confidentiality impact beyond ACR-017.

Recommended fix:

- In `handleShareTarget()`, enforce per-file and aggregate caps aligned with the Shared Folder quota (e.g. skip files over 30 MB, cap total stash at 30 MB and file count at ~20), recording skipped files in the meta so the app can toast a clear error.
- Keep the existing consume-time quota as the authoritative check.

Recommended tests:

- Oversized shared file is not stashed and the user is informed.
- Aggregate over-quota share stashes only what fits.

## Notable Existing Controls

- Sensitive task fields are field-encrypted for sync through `SENSITIVE_FIELDS`.
- Task links appear to use `sanitizeUrl()` and external links use `rel="noopener noreferrer"`.
- No obvious `dangerouslySetInnerHTML` usage was observed.
- Diagnostics avoid serializing arbitrary object payloads by default.
- Remote wipe execution verifies signatures before acting.
- Registry MACs help reject forged remote-unlock registry entries.

These controls are useful, but they do not remove the findings above.

## Recommended Implementation Order

All items below are done (see "Remediation Verification"); the list is kept as the audit record.

1. ~~Fix ACR-001 by binding remote-unlock approval to the exact verified request.~~ Done (`9da4610` + follow-up signing the digest into the response).
2. ~~Fix ACR-002 by separating DEK reads from user-activity idle refresh.~~ Done (`62250bf`).
3. ~~Remove WebAuthn PRF logging and service-worker URL logging.~~ Done (`62250bf`).
4. ~~Enforce requester-side remote-unlock expiry and clear ephemeral keys.~~ Done (`f5ccbed`).
5. ~~Decide whether Pomodoro/sound preset data is encrypted content or plaintext metadata.~~ Decided: plaintext metadata, documented (`f5ccbed`).
6. ~~Add sync AAD, snapshot integrity, and anti-replay semantics.~~ AAD done; snapshot integrity/anti-replay accepted as documented residual (`f5ccbed`).
7. ~~Harden import limits, diagnostics redaction, security-key UX, remote-wipe status trust, and CSP.~~ Done (`f5ccbed`).
8. ~~Update `THREAT_MODEL.md` to reflect the final decisions and residual risks.~~ Done (each fixing commit).

Remaining open items: none — ACR-017 and ACR-018 (share-target stash lifecycle; P3) were fixed the same day.

## Verification Plan

All targeted tests below exist and pass (1000+ tests in the suite):

- Remote unlock request-swap regression test — `remote-unlock-flow.test.ts` (plus response-digest binding tests).
- Remote unlock requester expiry test — `remote-unlock-flow.test.ts`.
- Paranoid idle timeout test with background DB reads — `vault-lock.test.ts`.
- WebAuthn enrollment logging regression test — `webauthn-prf-logging.test.ts`.
- Share target and service-worker redaction test — `share-target.test.tsx`, `url-capture-scrub.test.tsx`.
- Sync ciphertext context-swap test — `sync/crypto.test.ts`.
- ZIP and sound import size/count rejection tests — `export-import.test.ts`, `sound-import.test.ts`.

Broad checks after implementing fixes (all green as of 2026-06-09):

- `npm run lint`
- `npm test -- --run`
- Production build plus CSP smoke test

## Assumptions and Open Questions

- I treated user-authored Pomodoro sound preset names as potentially sensitive content until the product explicitly classifies them as metadata. *Resolved: classified as plaintext metadata by design, documented in `THREAT_MODEL.md` (ACR-010).*
- This was a static review. Findings that depend on browser behavior, WebAuthn extension outputs, or service-worker logging should be validated dynamically.
- Line numbers and code paths are current as of the local `main` branch reviewed on 2026-06-09.
