# GTD25 — Security Review & Threat Model

**Last updated:** 2026-06-07 (remote unlock & wipe: a trusted Paranoid-OFF device can unlock or wipe a locked device via a backend-relayed, forward-secret key exchange)
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
  `subtask.title/link/linkTitle/links`; and the `changeLog.data` snapshots.
- `task.discussionLog` is the follow-up discussion history (`{id, at, note}[]`).
  The free-text `note` is content, so the **whole array** is encrypted as a unit
  (the per-entry `at` timestamps are encrypted too — they are not exposed as
  metadata). ⚠️ Because field-level sync merge is last-write-wins per field, two
  devices that each append **or edit** a discussion between syncs will keep only
  one device's array — a **data-loss** risk (not a confidentiality one); the
  in-app history editor (edit past notes / add entries) makes a clobber slightly
  more likely. Accepted for a single-user app; a union-by-`id` merge is a possible
  future hardening.

**Always plaintext (metadata), at rest AND on the wire AND on the backend:**
- task/list/subtask **ids**, `listId`, `taskId`, `status`, `order`, `dueDate`,
  `createdAt`, `updatedAt`, `deletedAt`, recurrence/warning flags, `deviceId`,
  changelog `timestamp`. These are DB indexes and sync metadata.
- Follow-up ping/snooze timing — `pingedAt`, `pingCooldown`, `pingCooldownUntil`,
  `snoozeCadence`, `snoozeCadenceDays`, `archived` — is plaintext metadata. This
  is deliberate: it lets the "ready to discuss" count and the nudge engine work
  without unlocking the vault (the topic *titles* still require an unlocked vault
  to read). It also leaks how often you revisit topics.

➡️ **Metadata leakage is inherent to every scenario below.** An adversary always
learns the structure, size, timing, due dates, completion state, device count,
and activity patterns of your data — only the free-text content is protected.

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

**Per‑guess cost & assumed attacker** (order‑of‑magnitude, deliberately
attacker‑favourable — a ~100,000‑GPU frontier cluster):

| KDF | ~per‑GPU rate | ~aggregate (100k GPUs) |
|---|---|---|
| PBKDF2‑600k | 10⁴–10⁵ guess/s | **~10⁹ guess/s** |
| Argon2id 64 MiB | 10³–10⁴ guess/s (memory‑hard caps parallelism) | **~10⁸ guess/s** |

**Entropy of common secret styles:** lowercase ≈ 4.7 bits/char · alphanumeric ≈
5.95 · full‑ASCII ≈ 6.55 · **diceware word ≈ 12.9 bits/word** · digit ≈ 3.32.

**Average time to crack (search half the space) at the rates above:**

| Secret | ~Entropy | Sync `syncPassword` (PBKDF2, ~10⁹/s) | Vault `passphrase` (Argon2id, ~10⁸/s) |
|---|---|---|---|
| 6‑digit PIN | ~20 bits | **instant** | **instant** |
| 8‑char random alnum | ~48 bits | ~28 hours | ~12 days |
| 4 diceware words | ~52 bits | ~20 days | ~6 months |
| 10‑char random alnum | ~60 bits | ~13 years | ~130 years |
| 5 diceware words | ~65 bits | ~440 years | ~4,400 years |
| 6 diceware words | ~77 bits | ~3.5 million years | ~35 million years |

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
  copies** (which an adversary may retain forever). It therefore needs **more**
  entropy than feels intuitive: target **≥ 5 diceware words (~65 bits)**, ideally
  6. An 8‑char "complex" password (~48 bits) falls in **hours**.
- **The vault `passphrase`** should likewise be **≥ 4–5 diceware words**; below
  ~50 bits it is days/months against a serious adversary with the disk image.
- **The genuinely unbreakable tier is the security key** (hardware‑bound 256‑bit
  PRF, no guessable secret). Prefer it where offline attack is a real concern.
- These figures assume *random* secrets. Human‑memorable, patterned, or
  dictionary‑derived passwords have far less entropy than their length suggests
  and can fall orders of magnitude faster (smart mask/rule attacks).

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
    (note: wipes only help *before* imaging — a copied disk is immune).

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
  any in-browser scheme.
- **Paranoid ON + LOCKED — 🟠.** On lock the app drops the DEK (`currentDek=null`),
  clears cached secrets, and clears the sync key; the encrypted data lives in
  IndexedDB, not necessarily in the heap. A dump taken while locked recovers
  *much less*, but **not nothing**: JS strings (a recently typed passphrase), or a
  not-yet‑garbage-collected key object, may linger; a full process dump can
  include the browser's crypto subsystem. **Locking reduces, does not eliminate.**
  - **Mitigations:** aggressive auto-lock (idle timeout + optional system-idle /
    screen-lock detection), keylogger-safe security-key unlock (no passphrase
    string in memory), short unlocked windows. **Recommendation:** keep idle
    timeout short and lock before walking away; treat memory capture while
    unlocked as unwinnable.

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
    visible to such a proxy. Paranoid Mode does **not** change this surface (it's
    a *local* protection).

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
identity key; the approver stores RUK. To unlock, the locked device posts a signed
request carrying an **ephemeral session key K (RAM-only)** ECIES-encrypted to the
approver; the approver returns RUK encrypted under K; the locked device unwraps the
DEK. Device identity keys are distributed via a registry **authenticated by a
syncPassword-derived HMAC**.

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
  an attack signal → deny**. Residual: this leans on user vigilance (don't approve
  prompts you didn't initiate; check the code).
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
  locked device's app to be open and online** (it polls; a powered-off/closed device
  receives the command on next open).

---

## 4. Cross-cutting residual risks (true in multiple scenarios)
- **Metadata is never protected.** Structure, timing, due dates, status, sizes,
  and device/activity patterns leak everywhere.
- **Git history + a logging TLS proxy are append-only from the defender's view.**
  Anything ever synced may be retained by an adversary; you cannot retroactively
  un-expose it. Key rotation is **forward-secret only**.
- **Client-side timed/failure wipes only run when our code runs** — useless
  against an offline disk image or memory dump. The same applies to **remote wipe**
  (Scenario 8): it is delivered only while the locked app is open and online.
- **What runs while locked is minimal but no longer nil:** if remote unlock/wipe is
  enrolled (Scenario 8), the lock screen polls the backend mailbox (conditional
  requests) and can run `panicWipe` on an approver-signed command or unlock on an
  approved response. It uses the plaintext PAT and never touches the DEK/content.
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
   (Scenario 3).
6. **Do setup / passphrase changes on a trusted device** (Scenario 5).
7. Treat a complex passphrase as essential; a low-entropy one is the limiting
   factor for the disk-seizure case (Scenario 2).
8. **Encrypt manual ZIP exports** (Export → passphrase or sync password). An
   unencrypted export on disk is plaintext content + metadata (Scenario 2).
9. **If you enable remote unlock/wipe** (Scenario 8): pick only devices you fully
   control as approvers, confirm the fingerprint at enrolment, never approve an
   unlock prompt you did not initiate (and check the verification code), and accept
   that the PAT is plaintext at rest while it is enabled (use a least-privilege PAT).

## 6. Summary matrix (content confidentiality)
| # | Threat | Paranoid OFF | Paranoid ON |
|---|---|---|---|
| 2 | Disk imaging | 🔴 plaintext + creds | 🟠 to passphrase/key strength; metadata leaks; forensic residue (⚠️ PAT plaintext if remote unlock/wipe enrolled — Scenario 8) |
| 3 | Memory dump | 🔴 | 🔴 if unlocked; 🟠 if locked (not guaranteed) |
| 4 | TLS interception | 🟠 content safe (sync key); PAT+metadata exposed | 🟠 same (identical wire) |
| 5 | Keylogger | 🟠 syncPassword/PAT captured | 🟠 passphrase captured; 🟢 if security-key-only & untyped |
| 6 | Repo name, no PAT | 🟢 if repo private | 🟢 if repo private |
| 7 | Backend readable | 🟠 content to syncPassword strength; metadata fully exposed | 🟠 same (no effect) |
| 8 | Remote unlock/wipe (opt-in) | n/a | 🟢 unlock is forward-secret vs disk+backend; ⚠️ PAT plaintext at rest; approver holds RUK (approver+disk = DEK); wipe = recoverable DoS |

---

## 7. Keeping this document updated
Whenever a change affects the security posture — cryptography, key derivation,
what is encrypted vs. plaintext, storage locations, the sync/wire format, auth/PAT
handling, the lock/unlock or wipe flows, backups, or what runs while locked — this
file MUST be updated in the same change, and the user MUST be told what changed and
which prior threat-model conclusions it affects.
