# Codex AppSec Review

Date: 2026-06-09

Scope: repository-wide static review of the GTD app, with focus on the end-to-end encrypted sync model, Paranoid Mode, remote unlock/wipe flows, import/export, capture, and diagnostics. The review was grounded in `THREAT_MODEL.md` and source inspection. No dynamic exploit harness or browser-driven testing was run.

Method: Codex Security-style multi-pass review using independent threat-model passes, candidate finding discovery, validation, and attack-path analysis.

## Executive Summary

The app has a thoughtful crypto design for protecting task content from the backend: sync uses client-side AES-GCM over declared sensitive fields, Paranoid Mode encrypts IndexedDB content at rest, and destructive remote-wipe execution verifies command signatures. I did not find evidence of a straightforward XSS sink such as `dangerouslySetInnerHTML`, and link handling appears to use URL sanitization plus `noopener noreferrer`.

The highest-priority issue is in remote unlock approval: the approver verifies one pending request for display, then re-reads and approves whatever request is currently present. A backend writer or compromised PAT holder can swap the request after the user sees the code, causing the user to encrypt their Recovery Unlock Key to an attacker-controlled session key.

The second high-priority issue is Paranoid Mode idle locking. Background reads through the vault middleware appear to reset the idle timer, so routine app activity can keep the vault unlocked indefinitely even if the user is not interacting with the device.

There are also several medium-priority confidentiality and threat-model gaps: WebAuthn PRF material is logged during security-key enrollment, share-target data can appear in URL logs, Pomodoro sound preset data is synced in plaintext, remote-unlock requests lack requester-side expiry cleanup, and sync integrity would benefit from additional authenticated context and anti-replay controls.

## Findings

| ID | Priority | Severity | Confidence | Area | Status |
| --- | --- | --- | --- | --- | --- |
| ACR-001 | P1 | High | High | Remote unlock | Action required |
| ACR-002 | P1 | High | High | Paranoid Mode | Action required |
| ACR-003 | P2 | Medium | High | WebAuthn PRF | Action required |
| ACR-004 | P2 | Medium | High | Share target / SW | Action required |
| ACR-005 | P2 | Medium | Medium | Sync integrity | Design hardening |
| ACR-006 | P2 | Medium | High | Remote unlock | Action required |
| ACR-007 | P2 | Medium | Medium | Remote unlock | Design hardening |
| ACR-008 | P2 | Medium | Medium | Paranoid Mode | Action required |
| ACR-009 | P2 | Medium | Medium | Paranoid Mode | Action required |
| ACR-010 | P2 | Medium | High | Sync data model | Threat-model gap |
| ACR-011 | P3 | Low/Medium | High | Import | Hardening |
| ACR-012 | P3 | Low/Medium | Medium | Security key UX | Hardening |
| ACR-013 | P3 | Low/Medium | Medium | Remote wipe UX | Hardening |
| ACR-014 | P3 | Low | Medium | Secret UX | Hardening |
| ACR-015 | P3 | Low | Medium | Diagnostics | Hardening |
| ACR-016 | P3 | Low | High | Threat model / platform | Documentation |

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

## Notable Existing Controls

- Sensitive task fields are field-encrypted for sync through `SENSITIVE_FIELDS`.
- Task links appear to use `sanitizeUrl()` and external links use `rel="noopener noreferrer"`.
- No obvious `dangerouslySetInnerHTML` usage was observed.
- Diagnostics avoid serializing arbitrary object payloads by default.
- Remote wipe execution verifies signatures before acting.
- Registry MACs help reject forged remote-unlock registry entries.

These controls are useful, but they do not remove the findings above.

## Recommended Implementation Order

1. Fix ACR-001 by binding remote-unlock approval to the exact verified request.
2. Fix ACR-002 by separating DEK reads from user-activity idle refresh.
3. Remove WebAuthn PRF logging and service-worker URL logging.
4. Enforce requester-side remote-unlock expiry and clear ephemeral keys.
5. Decide whether Pomodoro/sound preset data is encrypted content or plaintext metadata.
6. Add sync AAD, snapshot integrity, and anti-replay semantics.
7. Harden import limits, diagnostics redaction, security-key UX, remote-wipe status trust, and CSP.
8. Update `THREAT_MODEL.md` to reflect the final decisions and residual risks.

## Verification Plan

Recommended targeted tests:

- Remote unlock request-swap regression test.
- Remote unlock requester expiry test.
- Paranoid idle timeout test with background DB reads.
- WebAuthn enrollment logging regression test.
- Share target and service-worker redaction test.
- Sync ciphertext context-swap test.
- ZIP and sound import size/count rejection tests.

Recommended broad checks after implementing fixes:

- `npm run lint`
- `npm test -- --run`
- Production build plus CSP smoke test

## Assumptions and Open Questions

- I treated user-authored Pomodoro sound preset names as potentially sensitive content until the product explicitly classifies them as metadata.
- This was a static review. Findings that depend on browser behavior, WebAuthn extension outputs, or service-worker logging should be validated dynamically.
- Line numbers and code paths are current as of the local `main` branch reviewed on 2026-06-09.
