# GitHub-as-Backend: a portable sync protocol

**Status:** extracted from `gtd25`, a client-only PWA in production use across Android + desktop Chrome.
**Audience:** engineers and coding agents implementing a similar backend in another project, potentially in another language.
**Scope:** the sync protocol only — not this app's UI, data model, or feature set.

This document describes a **serverless, offline-first, end-to-end-encrypted multi-device sync protocol** that uses a
private GitHub repository as its storage tier and the GitHub REST API as its wire protocol. There is no backend to
operate, no database to host, no auth service, and no per-user cost.

It is written to be implementable from scratch. Where a decision was non-obvious, the rationale and the failure it
prevents are stated, because those are the parts a reimplementation gets wrong.

> **Read §1 and §13 first.** This design is excellent inside a narrow envelope and a bad idea outside it. Confirm the
> fit before implementing anything else.

---

## Table of contents

1. [When to use this (and when not to)](#1-when-to-use-this-and-when-not-to)
2. [Operating constraints the design assumes](#2-operating-constraints-the-design-assumes)
3. [Storage layout](#3-storage-layout)
4. [Data model contract](#4-data-model-contract)
5. [Encryption](#5-encryption)
6. [The sync algorithm](#6-the-sync-algorithm)
7. [Concurrency and conflict resolution](#7-concurrency-and-conflict-resolution)
8. [Consistency model — what you actually get](#8-consistency-model--what-you-actually-get)
9. [Error handling and retries](#9-error-handling-and-retries)
10. [Scheduling and cadence](#10-scheduling-and-cadence)
11. [Repository growth control](#11-repository-growth-control)
12. [Lifecycle operations](#12-lifecycle-operations)
13. [GitHub API limits and how they translate into a budget](#13-github-api-limits-and-how-they-translate-into-a-budget)
14. [Lessons learned (the expensive ones)](#14-lessons-learned-the-expensive-ones)
15. [Known limitations and residual risks](#15-known-limitations-and-residual-risks)
16. [Implementation checklist](#16-implementation-checklist)
17. [Test matrix](#17-test-matrix)
18. [Porting notes](#18-porting-notes)

---

## 1. When to use this (and when not to)

### Good fit

| Condition | Why it matters |
|---|---|
| **Single user, few devices** (1–5) | Write contention is near zero; optimistic concurrency almost never loses. |
| **Small dataset** (≤ ~10 MB of JSON state) | The whole state is re-serialized on compaction; every sync reads it. |
| **Latency tolerance of seconds to minutes** | Polling-based. Remote edits land in ~0–30 s normally, minutes under backoff. |
| **Writes are per-entity and small** | The change-log design assumes an entity fits comfortably in one JSON entry. |
| **You want zero infrastructure** | No server, no DB, no auth service, no bills, no on-call. |
| **You want E2EE with a trivial threat model** | The storage provider is untrusted by construction; nothing to breach server-side. |
| **The user owns the storage** | The data lives in the user's own repo. No lock-in, no vendor access. |

### Bad fit — do not use this

| Condition | Why it breaks |
|---|---|
| **Multi-user collaboration** | There is no access control below repo level, no per-user identity, and no merge model for concurrent human editing. Everyone with repo access shares one encryption key. |
| **Real-time / sub-second sync** | Polling floor is one request per interval; the API rate limit caps you at ~1 req/s sustained per token. |
| **Large or binary-heavy data** | The Contents API is JSON+base64 (+33 % inflation). See §13. |
| **High write frequency** | Every push is a git commit. Thousands of writes/hour will hit both rate limits and repository bloat. |
| **Server-authoritative logic** | There is no server. Validation, quotas, and business rules are client-side only — a hostile client can write anything the PAT allows. |
| **Regulated data with audit requirements** | Commit metadata is written by the GitHub account; there is no independent audit trail, and a compromised PAT can rewrite history. |
| **Untrusted client devices** | The PAT and the encryption key live on the device. Device compromise is total compromise. |
| **You need atomic multi-entity transactions** | Each Contents API `PUT` is an independent commit. See §8. |

**Decision rule:** if two humans might write concurrently, or if you need sub-second propagation, stop here and use a
real backend. Everything else in this document assumes one user's own devices.

---

## 2. Operating constraints the design assumes

These are load-bearing. If your project violates one, the corresponding mechanism must be redesigned.

1. **One logical writer.** All devices belong to one user. Concurrency is *incidental* (two devices of the same person,
   one possibly offline), never *contended* (two people editing the same field on purpose).
2. **Devices are trusted.** Any device holding the passphrase can read and write everything. There is no per-device
   revocation beyond rotating the PAT and the passphrase.
3. **Clocks are approximately correct.** Conflict resolution is timestamp-based (§7). A device with a badly wrong clock
   will either always win or never win. There is no server clock to anchor to. See §15.
4. **The full state fits in memory.** Compaction decrypts, merges, re-encrypts and re-uploads the entire snapshot.
5. **Offline is normal, not exceptional.** All writes go to a local database first and sync later. The network is an
   optimization, never a precondition for a user action.
6. **The user can lose data by losing a passphrase.** With real E2EE there is no recovery path. This must be surfaced
   in the UI at setup time, not buried.
7. **The repository is private.** E2EE means a public repo would "only" leak metadata, but that is still a real leak
   (entity counts, ordering, activity timing) and the commit history is permanent.

---

## 3. Storage layout

All files live at the repository root of a private repo the user owns.

### Default branch

| File | Role | Written when |
|---|---|---|
| `<app>-snapshot.json` | **Authoritative full state.** The complete encrypted database. | On compaction, migration, force-push, wipe, import, restore. |
| `<app>-changelog.json` | **Append-only delta log** since the last compaction. A JSON array of change entries. | On every push. Reset to `[]` on compaction. |
| `<app>-backup-hourly.json`<br>`<app>-backup-daily.json`<br>`<app>-backup-weekly.json` | **Point-in-time recovery.** Snapshot-format copies at three retention tiers. | Fire-and-forget after a successful sync, if the tier is stale. |
| `<app>-snapshot-v{N}.backup.json` | **Pre-migration rollback.** The snapshot as it existed before a schema migration. | Before a sync-version migration; pruned to the newest 2. |

### Dedicated orphan branch (binary blobs)

| Path | Role |
|---|---|
| `<blob-branch>` : `<blob-dir>/{blobId}` | Encrypted file bytes, one git blob per user file. `blobId` is an opaque random id — no extension, no filename. |
| `<blob-branch>` : `<blob-dir>/.keep` | Placeholder so the branch always has a non-empty tree. |

**Why a separate orphan branch for blobs:** blob deletion must reclaim space, and reclaiming space in git means
rewriting history. Keeping blobs off the default branch lets you force-squash the blob branch aggressively without
ever touching the history that holds the user's task data. This separation is the single most important layout
decision in the design.

### The two-file split (snapshot + changelog)

This is the core idea, and it exists to solve a specific problem: **the Contents API has no append operation.**

- Writing *only* a snapshot means every small edit re-uploads the entire state. Expensive, and every write is a
  whole-file conflict.
- Writing *only* a log means unbounded growth and an O(history) read on every device start.

So: the changelog absorbs frequent small writes (a few hundred bytes each), and the snapshot absorbs the changelog
periodically. The changelog is a **bounded buffer**, not a permanent record.

```
        small edits                       periodically
device ─────────────► changelog.json ──────────────────► snapshot.json
                      (bounded, hot)                     (full state, cold)
```

---

## 4. Data model contract

Every synced entity **must** carry these fields. This is the minimum the merge engine needs.

```jsonc
{
  "id":        "opaque-stable-unique-id",  // never reused, generated client-side
  "createdAt": 1721800000000,              // epoch ms
  "updatedAt": 1721800000000,              // epoch ms, max of all field timestamps
  "deletedAt": 1721800000000,              // epoch ms | absent — soft delete (tombstone)
  "fieldTimestamps": {                     // per-field last-modified, epoch ms
    "title": 1721800000000,
    "status": 1721800005000
  }
  // ...domain fields
}
```

**Rules:**

- `id`, `createdAt`, `updatedAt` and `fieldTimestamps` are **excluded** from per-field merge (they are metadata about
  the merge, not merged content).
- Deletes are **never** hard deletes on the wire. Set `deletedAt` and let the tombstone propagate. A hard delete is
  indistinguishable from "this device hasn't seen the entity yet", and would be resurrected on the next sync.
- `fieldTimestamps` must be stamped **on the writing device, at write time**, for exactly the fields that changed.
  Stamping every field on every write destroys field-level merge and silently degrades to entity-level LWW.

### Change entry

```jsonc
{
  "id":         "unique-entry-id",   // for idempotent dedup
  "deviceId":   "stable-per-device", // so a device can skip its own entries
  "timestamp":  1721800000000,
  "entityType": "task",
  "entityId":   "the-entity-id",
  "operation":  "upsert" | "delete",
  "data":       { /* the FULL entity after the write, encrypted */ },
  "v":          6                    // schema version that produced this entry
}
```

**`data` carries the full entity, not a diff.** Diffs require an agreed base state; full entities make every entry
independently applicable in any order. With field-level timestamps riding along, a full-entity upsert is already a
semantic diff — the merge extracts what actually changed.

**`v` matters.** A device running an old app version will push entries in the old shape. The receiver normalizes each
entry through a per-entry migration before applying it. Without this, a stale device silently corrupts fresh data.

### Local-only state (never synced)

Keep a per-device record holding: credentials, `deviceId`, last-pulled/pushed timestamps, the last-seen snapshot SHA,
and compaction bookkeeping. Syncing any of this creates feedback loops.

---

## 5. Encryption

E2EE is **mandatory once sync is enabled**, not an option. An optional-encryption path doubles every code path and
guarantees that someone ships plaintext by accident.

### Key derivation

```
key = PBKDF2-HMAC-SHA256(passphrase, salt, iterations = 600_000) → AES-256-GCM key
salt = 16 random bytes, generated once on first sync, stored PLAINTEXT in the snapshot
```

The salt is public material by design — it must be readable by a new device before that device can derive anything.
Use a memory-hard KDF (Argon2id) instead if your runtime has one available and you can guarantee it works in
production (see the CSP lesson in §14).

### Verifier

Store in the snapshot, plaintext-adjacent:

```
encryptionVerifier = AES-GCM(key, "<app>-encryption-check")
```

On every key resolution, decrypt the verifier **before** touching real data. A wrong passphrase is then a clean,
instant, non-destructive failure instead of a cascade of decrypt errors mid-merge. This one field prevents an entire
class of "I typed the wrong password and now my sync is broken" bugs.

### Per-entity envelope

Encrypt **selected fields**, not whole entities:

```jsonc
// plaintext entity
{ "id": "t1", "listId": "l1", "order": 3, "updatedAt": 172…, "title": "Call the bank", "description": "…" }

// on the wire
{ "id": "t1", "listId": "l1", "order": 3, "updatedAt": 172…,
  "_enc": "base64(iv || ciphertext)" }   // { title, description } inside
```

**What stays plaintext, and why:** ids, foreign keys, ordering, status, timestamps and `fieldTimestamps`. The sync
engine must sort, merge, and resolve conflicts **without holding the key** — a locked device still needs to compact,
reconcile and detect version skew. Encrypting structure would force a decrypt of the entire dataset for every
bookkeeping operation.

**What this leaks:** entity counts, structure, activity timing, and status distribution. Say so explicitly in your
threat model. Do not claim "everything is encrypted" when it is not.

### AAD binding (do this)

Bind each ciphertext to the record it belongs to:

```
aad = "<entityType>:<entityId>"
ciphertext = AES-GCM(key, plaintext, additionalData = aad)
```

Without it, an attacker with repo write access can **relocate** a valid ciphertext onto a different record — moving
task A's encrypted title onto task B. It decrypts perfectly and impersonates B's content. With AAD, the swap fails
authentication and surfaces as unreadable.

**Migration note:** if you add AAD to an existing deployment, attempt the bound decrypt first and fall back to the
unbound one, so legacy blobs stay readable and gain the binding on their next re-encryption.

### Binary blobs

Two independent layers, applied separately:

- **On the wire:** `AES-GCM(syncKey, fileBytes)` → uploaded as raw bytes to the blob branch.
- **At rest locally:** encrypted with the local at-rest key if your app has one, plaintext otherwise.

Do not conflate them. The wire key is derived from the sync passphrase; the at-rest key belongs to the local vault.
They rotate independently.

### Key caching and expiry

Cache the derived key in memory (600 k PBKDF2 iterations is ~100–500 ms — you cannot re-derive per operation). Expire
it on idle and when the app is backgrounded.

> **Critical:** expire the **key**, but keep the **salt**. The salt is public and re-derivation needs it. If you drop
> both, every operation between the expiry and the next successful sync fails with "no key" and *restarting the app
> becomes the only fix*. See §14, lesson 4.

Provide an explicit `ensureKey()` that re-derives on demand from the stored passphrase + surviving salt, and call it
from every path that needs the key outside a sync.

---

## 6. The sync algorithm

One entry point, `sync()`, handles the steady state and every bootstrap case. Pseudocode below is normative; error
handling is in §9.

```
function sync(manual = false, pushLimit = null) -> remainingCount:

  ── 0. GUARDS ────────────────────────────────────────────────────────────
  signal = acquireLock()            # single in-flight sync per device
  if not signal: return BUSY
  if offline: release; return BUSY
  creds = getCredentials()          # null → sync disabled or vault locked → no-op
  if not creds: release; return BUSY
  setDirtyFlag(true)                # crash marker; cleared only on clean finish

  ── 1. FETCH ─────────────────────────────────────────────────────────────
  (changelogFile, snapshotFile) = parallel(GET changelog, GET snapshot)
  remoteEntries = parseJsonSafe(changelogFile) ?? []     # parse failure → treat as empty
  changelogSha  = changelogFile.sha

  ── 2. OVERSIZE GUARD ────────────────────────────────────────────────────
  if remoteEntries.length > MAX_CHANGELOG_ENTRIES:       # e.g. 500
      compact(); refetch changelog

  ── 3. BOOTSTRAP PATHS (mutually exclusive, ordered) ──────────────────────
  if no snapshot and no changelog:            → FIRST SYNC: push local as snapshot, changelog=[]
  if snapshot and no changelog:               → ADOPT: replace local from snapshot, changelog=[]
  if snapshot and changelog and never pulled: → FRESH DEVICE: delegate to forcePull()

  ── 4. VERSION GATE ──────────────────────────────────────────────────────
  if snapshot.syncVersion > LOCAL_SYNC_VERSION:
      notifyUpdateRequired(); return ERROR    # refuse to touch data you don't understand
  # older remote is handled in step 7

  ── 5. WIPE GATE ─────────────────────────────────────────────────────────
  if snapshot.wipedAt and snapshot.wipedAt != lastWipeSeenAt and snapshot.wipedAt > lastPulledAt:
      verifyPassphrase(); local safety backup; replace local from snapshot;
      keep own pending entries newer than wipedAt (re-apply them), drop older ones;
      lastWipeSeenAt = snapshot.wipedAt; continue    # the normal pull/push below
                                                     # applies what others pushed since

  ── 6. KEY ───────────────────────────────────────────────────────────────
  key = resolveKey(snapshot.encryptionSalt)   # → key | NEEDS_PASSPHRASE
  if key == NEEDS_PASSPHRASE: return BUSY     # UI prompts; sync retries later
  if not checkVerifier(key, snapshot.encryptionVerifier):
      forgetStoredPassphrase(); promptUser(); return ERROR

  ── 7. MIGRATE REMOTE (if older) ─────────────────────────────────────────
  if snapshot.syncVersion < LOCAL_SYNC_VERSION:
      backupSnapshotAs("snapshot-v{old}.backup.json")
      decrypt → runMigrations → re-encrypt → PUT snapshot

  ── 8. APPLY REMOTE ──────────────────────────────────────────────────────
  foreign = remoteEntries.filter(e => e.deviceId != myDeviceId)
  foreign = decrypt(foreign)
  applyEntries(foreign)                       # field-level merge, see §7

  ── 9. RECONCILE AGAINST SNAPSHOT  ← DO NOT SKIP ─────────────────────────
  if snapshot.sha != lastSeenSnapshotSha:
      reconcile(decrypt(snapshot))            # field-level merge, not replace
      store lastSeenSnapshotSha = snapshot.sha
  # Rationale: entries this device never saw may have been absorbed into the
  # snapshot and erased from the changelog while it was offline. Without this
  # step those changes are lost forever. See §14, lesson 1.

  ── 10. PUSH LOCAL ───────────────────────────────────────────────────────
  pending = getPendingEntries(limit = pushLimit)
  pending = pending.filter(e => e.id not in remoteEntries)   # dedup, see §14 lesson 3
  if pending:
      body = remoteEntries ++ encrypt(pending)
      putWithConflictRetry(changelog, body, changelogSha)     # §7
      clearPushedEntries(pending)

  ── 11. COMPACT (threshold) ──────────────────────────────────────────────
  if remoteEntries.length + pending.length >= COMPACTION_THRESHOLD:   # e.g. 30
      compact()

  ── 12. FINISH ───────────────────────────────────────────────────────────
  updateSyncMeta(lastPulledAt, lastPushedAt, snapshotSha, pendingChanges)
  consecutiveErrors = 0
  setDirtyFlag(false)
  fireAndForget(createBackups, compactBlobBranch, squashHistory)
  return countRemainingPending()
```

### Compaction

Compaction is the garbage collector of this protocol. It folds the changelog into the snapshot and resets the log.

```
function compact():
  snapshot  = decrypt(GET snapshot)
  changelog = decrypt(GET changelog);  changelogShaAtRead = changelog.sha
  if changelog is empty: return

  for entry in changelog sorted by timestamp ascending:
      if entry.operation == delete:  mark tombstone on snapshot entity
      else:                          snapshot[entity] = merge(snapshot[entity], entry.data, entry.timestamp)

  snapshot = dropTombstonesOlderThan(30 days)      # bounded tombstone retention
  snapshot = applyRetentionPolicies(snapshot)      # e.g. archive old completed items
  snapshot.syncVersion = LOCAL_SYNC_VERSION
  preserve snapshot.encryptionSalt and .encryptionVerifier   # ← never regenerate
  PUT snapshot (encrypted, with its SHA)

  ── the compaction lock ──
  fresh = GET changelog
  if fresh.sha != changelogShaAtRead:
      return                      # someone pushed while we worked — DO NOT clear
  PUT changelog = "[]" (with fresh.sha)
```

**Why the re-read before clearing:** between reading the changelog and writing the snapshot, another device may have
appended entries. Clearing blindly deletes changes that were never absorbed. The SHA check makes the clear a
compare-and-swap.

**Why simultaneous compaction by two devices is harmless:** both write snapshots containing the same entities keyed by
`id`, so the write is idempotent. At most one device's SHA check passes, so at most one clears the log. The other
skips, and the next cycle absorbs whatever remains. *Losing* a compaction is always safe; *clearing* wrongly is not.
Design every ambiguous branch to fall on the "skip the clear" side.

---

## 7. Concurrency and conflict resolution

Three independent mechanisms, at three different layers.

### Layer 1 — Optimistic concurrency on the file (server-side)

The Contents API returns a content SHA on read and accepts it on write. A `PUT` with a stale SHA fails with **409
Conflict**. This is compare-and-swap, and it is the only server-side synchronization primitive available.

```
retries = 0
while retries < MAX_RETRIES:                    # 3
    try:
        newSha = PUT(file, body, expectedSha)
        break
    catch CONFLICT:
        retries += 1
        fresh = GET(file)                        # someone else won
        newForeign = fresh.entries - alreadySeen - ours
        applyEntries(decrypt(newForeign))        # ← absorb their work FIRST
        body = fresh.entries.filter(not ours) ++ ours   # rebuild on top of theirs
        expectedSha = fresh.sha
        sleep(500ms * retries + random(0..500ms))  # jittered backoff
```

Three points that are easy to get wrong:

1. **Apply the winner's entries before rebuilding your body.** Otherwise you overwrite with a body that never
   incorporated their changes and you have silently lost data — a 409 handled as "just retry with the new SHA" is a
   data-loss bug wearing a retry's clothes.
2. **Deduplicate by entry id when rebuilding.** Your entries may already be in the fresh body.
3. **Jitter the backoff.** Fixed backoff makes N devices retry in lockstep forever.

After `MAX_RETRIES`, give up and return. The entries are still in the local pending log; the next sync retries. Never
force-write past a conflict.

### Layer 2 — Field-level last-write-wins (entity merge)

Entity-level LWW is *not good enough*: "device A renamed the task" and "device B edited its description" are not in
conflict, but entity-level LWW discards one of them.

```
function merge(local, remote, remoteTimestamp) -> merged | null:
    if either side lacks fieldTimestamps:
        return remoteTimestamp >= local.updatedAt ? remote : null   # legacy fallback

    for key in union(keys(local), keys(remote)) minus EXCLUDED:
        if remote.fieldTimestamps[key] > local.fieldTimestamps[key]:
            merged[key] = remote[key]        # key absent in remote → delete the field
            merged.fieldTimestamps[key] = remote.fieldTimestamps[key]
        # ties and local-newer: keep local

    if nothing changed: return null          # signals "no write needed"
    merged.updatedAt = max(local.updatedAt, remote.updatedAt)
    return merged
```

Returning `null` for "already up to date" is worth the awkwardness: it prevents a write, which prevents a change
entry, which prevents a sync, which prevents an infinite sync loop between two devices.

### Layer 2b — Union-merged collections

Some fields are **append logs** (activity history, comments, event lists). Per-field LWW is wrong for them: two
devices each appending an entry means one device's append is discarded wholesale.

```
function unionById(localArr, remoteArr, localTs, remoteTs):
    winner = remoteTs > localTs ? remoteArr : localArr
    result = map()
    for e in loser:  result[e.id] = e
    for e in winner: result[e.id] = e       # id collisions resolve to the winner's version
    return sortDeterministically(result.values())   # by (timestamp, id)
```

Declare these fields explicitly in a set. The sort must be **fully deterministic**, including the tie-break, or two
devices produce different byte sequences for identical content and ping-pong writes forever.

Residual: a deletion from such a collection can be resurrected by a device still carrying the entry. Accepted here
because append dominates. If deletion matters in your domain, put tombstones inside the collection too.

### Layer 3 — Deletion

Soft delete (`deletedAt`), propagated as a normal field. A delete entry wins if `entry.timestamp >= local.updatedAt`.
Tombstones are dropped from the snapshot after **30 days** during compaction.

The retention window is a bet: *no device stays offline longer than 30 days*. A device offline for 31 days will
resurrect every entity it holds that was deleted elsewhere, because the tombstone is gone and its local copy looks
like a legitimate unseen entity. Pick the window to match how long your users' devices realistically stay dark, and
document it.

---

## 8. Consistency model — what you actually get

Be precise about this; the guarantees are weaker than "it syncs".

**You get:**

- **Eventual convergence** for entities that are edited on one device at a time (the overwhelmingly common case).
- **Per-field merge** for entities edited concurrently on different fields.
- **Read-your-writes** on the originating device, always and immediately (local DB is the source of truth locally).
- **Durability under network failure** — writes are local-first; the network only publishes.
- **Monotonic bootstrap** — a fresh device always lands on a complete, consistent snapshot.

**You do NOT get:**

- **Atomicity across files.** The snapshot and changelog are separate `PUT`s, hence separate commits. A device
  pulling between them sees a torn state. It is *tolerated*: the snapshot is authoritative, the changelog is additive,
  and the next sync repairs. It is not *prevented*.
  → *If you need atomicity, use the Git Data API instead: build a tree with all changed files, create one commit, and
  `PATCH` the ref with `force: false`. That is a genuine compare-and-swap over multiple files. This app uses the Git
  Data API only for history compaction; using it for the main write path is the most valuable upgrade available.*
- **Causality.** Timestamps are physical, not logical. There are no vector clocks, no happens-before. Two edits that
  are causally related but arrive out of order merge by wall-clock only.
- **Conflict detection.** Conflicts are resolved silently. Users are never asked. This is intentional for a
  single-user app and unacceptable for a multi-user one.
- **Deterministic tie-breaking.** Two edits to the same field at the *same millisecond* on two devices can converge to
  different values on each device, permanently. See §15.
- **Server-side validation.** Anything with the PAT can write anything. All invariants are client-enforced.

---

## 9. Error handling and retries

### Classify errors once, at the source

Classify where you still hold the real error (HTTP status, response headers), and pass a **typed** result upward. The
UI must never string-match error messages.

| Category | Detection | Response |
|---|---|---|
| `rate-limited` | 403 + `X-RateLimit-Remaining: 0` + `X-RateLimit-Reset` | Park the scheduler until reset + 1 s buffer. Do not retry. |
| `auth` | 401, or 403 without rate-limit headers | Stop. User must fix the token. Retrying is pointless and burns quota. |
| `repo-missing` | 404 on the repo | Stop. Also the symptom of a valid PAT lacking access to that repo. |
| `update-required` | remote `syncVersion` > local | Stop, prompt to update the app. **Never** write. |
| `conflict` | 409 | Retry with merge, bounded (§7). |
| `wrong-password` | AES-GCM decrypt failure (`OperationError`) | Forget the stored passphrase, prompt. Do not wipe anything. |
| `corrupt-remote` | JSON parse failure, malformed API response | Do not write. Surface loudly. |
| `server` | 5xx | Exponential backoff, throttle user-visible toasts. |
| `timeout` | request timeout / abort | Backoff, retry. |
| `network` | fetch threw / offline | Backoff, retry. Not an error state worth alarming the user about. |

### Backoff

```
interval = consecutiveErrors == 0
           ? BASE_POLL                                          # 30 s
           : min(BASE_POLL * 2^consecutiveErrors, 300_000)      # 30 → 60 → 120 → 240 → 300 s cap
```

Reset `consecutiveErrors` to 0 **only** on a fully successful sync.

### Rules that prevent the worst failures

1. **Never write on a parse failure.** Corrupted remote → read-only until a human intervenes. Writing "repairs" a
   corrupt file by overwriting real data with your partial view.
2. **Validate entity shape before applying.** Check required fields on every incoming entry; skip and log malformed
   ones. A single bad entry must not poison the batch.
3. **Validate the API response shape.** GitHub can return HTML error pages, proxies can inject content. Assert that
   `content` and `sha` are strings before using them.
4. **Timeout every request** (~15 s) and abort the whole sync on a global timeout (~45 s). A hung request holds the
   sync lock, which stops all future syncs.
5. **Fire-and-forget the housekeeping.** Backups, blob compaction and history squash must never fail a sync. Catch,
   log, continue.
6. **Throttle user-visible errors.** A GitHub outage is one notification, not one every 30 seconds.
7. **Keep a dirty flag** in persistent storage: set at sync start, cleared on clean finish. A flag surviving a restart
   means the last sync died mid-flight — useful for diagnostics and for deciding to force a full reconcile.
8. **Persist a diagnostics log** with an age cap (e.g. 7 days). Errors that only reproduce on a user's device are
   otherwise unreportable — and an in-memory log is empty by the time the user opens the panel.

### The sync lock

```
function acquireLock():
    if lockHeld and (now - lockStartedAt) < SYNC_TIMEOUT:  return null      # busy
    if lockHeld:  abortPrevious()                                          # expired → force-reset
    lockStartedAt = now; abortController = new
    return abortController.signal
```

Release in a `finally`. An unreleased lock is a permanently broken sync that only a restart fixes — the expiry check
is the safety net for the case where you got it wrong anyway.

---

## 10. Scheduling and cadence

The scheduler exists to serve two opposed goals: *changes should propagate quickly* and *we must not burn the rate
limit*. A state machine resolves it.

```
                   ┌──────────────────────────────────────┐
                   │              stopped                 │
                   └──────────────────┬───────────────────┘
                                      │ sync enabled
                   ┌──────────────────▼───────────────────┐
      ┌───────────►│   idle — poll every 30 s (backoff)   │
      │            └──────────────────┬───────────────────┘
      │                               │ local change
      │            ┌──────────────────▼───────────────────┐
      │            │ first-wait — until 3 s of user idle, │
      │            │ hard deadline 15 s                   │
      │            └──────────────────┬───────────────────┘
      │                               │ push first small batch (5)
      │            ┌──────────────────▼───────────────────┐
      └────────────┤ batching — 10 entries / 30 s, until  │
        drained    │ the pending queue is empty           │
                   └──────────────────────────────────────┘
```

Design points:

- **Debounce on user idleness, not on a fixed timer.** Sync after ~3 s of no input, with a hard deadline (~15 s) so a
  continuously-typing user still gets their data pushed.
- **Small first batch, larger subsequent batches.** The first batch (5 entries) gets *something* replicated fast; the
  rest (10 per cycle) drains without spamming the API.
- **Sync on visibility change,** with a minimum re-sync interval (~10 s) to stop tab-switchers from hammering.
- **Sync on `online`.**
- **Flush on hide with a keepalive request.** When the page is being backgrounded, fire one `PUT` with `keepalive`
  set so the browser completes it after the page suspends. Guard it: only if cached state is fresh (< 60 s), and
  treat it as best-effort. The data is safe locally regardless. **This is what makes entry-id dedup mandatory** (§14,
  lesson 3).
- **Conditional GET for idle polling.** Cache the `ETag` per file and poll with `If-None-Match`. A `304` costs no
  rate limit at all. Only escalate to a full sync when something actually changed or something is pending. This turns
  the steady state from "two full-body pulls every 30 s" into "two bodyless 304s".
- **Jitter the interval** if traffic-analysis resistance matters. A fixed 30-second beacon is a fingerprint.

---

## 11. Repository growth control

Every `PUT` is a commit. Left alone, a sync repo grows without bound — and unlike a database, git never forgets.

| Mechanism | Trigger | Effect |
|---|---|---|
| **Changelog compaction** | ≥ 30 pending entries, or > 500 entries (forced) | Folds the log into the snapshot; log resets to `[]`. |
| **Tombstone pruning** | Every compaction | Drops soft-deletes older than 30 days. |
| **Retention policies** | Every compaction | Domain-specific (e.g. archive items completed > 90 days ago). |
| **Blob branch squash** | Pending deletions, or every 6 h | Rebuilds the blob branch as a single orphan commit keeping only live blobs. |
| **Default branch squash** | ~Monthly | Rebuilds the default branch as a single orphan commit with the identical tree. |

### Why squashing the default branch is safe

Git blob SHAs are **content-addressed**. Squashing history changes commits, not file content SHAs. Since the protocol's
optimistic concurrency keys off *content* SHA (not commit history), every device keeps syncing across a squash without
noticing. Recovery does not depend on git history either — it depends on the backup files, which live in the tree.

```
function squash(branch):
    head = getRef(branch)
    { treeSha, parents } = getCommit(head)
    if parents is empty: return                     # already squashed
    newCommit = createCommit(tree = treeSha, parents = [])   # orphan, identical tree
    if getRef(branch) != head: return               # concurrent push — abort
    updateRef(branch, newCommit, force = true)
```

The **re-read of the ref before the force-update** is the entire safety mechanism. Never force-update without it.

### The blob branch specifically

```
function compactBlobs(liveBlobIds):
    tree = getTree(getCommit(getRef(blobBranch)).treeSha, recursive = true)
    if tree.truncated: return                       # >100k entries — bail, do not guess
    keep = tree.blobs.filter(b => b.path == KEEP_PATH or liveBlobIds.has(basename(b.path)))
    if keep.length == tree.blobs.length: return     # nothing to drop
    ensure keep is non-empty (re-create the placeholder if needed)
    newTree   = createTree(keep)                    # reuses existing blob SHAs — no re-upload
    newCommit = createCommit(newTree, parents = [])
    if getRef(blobBranch) changed: return
    updateRef(blobBranch, newCommit, force = true)
```

Guards that matter:

- **Build the keep-set from the branch's own tree**, intersected with the live set. Never from a device's local view
  alone.
- **Require a successful sync first.** A device that hasn't pulled yet believes the folder is empty; letting it
  compact would wipe every blob. Gate on "we just synced successfully" *and* "we know of ≥1 item or made a deletion".
- **Bail on a truncated tree.** A partial listing looks exactly like "these files don't exist".

**GitHub does not run `git gc` on demand.** Unreachable objects linger for an unspecified period. Squashing makes
objects unreferenced; it does not immediately reclaim bytes, and it does **not** make leaked secrets instantly
unretrievable. Never treat a squash as a security control.

---

## 12. Lifecycle operations

| Operation | Behaviour | Critical guard |
|---|---|---|
| **Enable sync (first device)** | Push local state as the snapshot; changelog `[]`. | Generate the salt once. Never regenerate it while data exists. |
| **Add a device** | Bootstrap: pull the snapshot, apply the changelog on top, replace local state — then put back what only this device had (merge shared ids field by field, fold a local Inbox into the synced one) and push it. | Verify the passphrase against the verifier **before** replacing anything local. Never drop a joining device's own data: a device used offline before sync was set up would otherwise lose it silently. |
| **Force push** | Overwrite the remote snapshot with full local state; clear changelog. | **Refuse if local is empty and remote is not.** This one guard prevents the single worst data-loss bug in the design. Back up the remote first. |
| **Force pull** | Replace local state from remote snapshot + changelog. | Apply **all** entries including this device's own — its local DB may be the thing being recovered. |
| **Wipe all data** | Push an empty snapshot stamped `wipedAt`; reset the changelog to `[]`; squash the blob branch. | Back up the remote snapshot first. **Reset, never delete, the changelog**: a remote with a snapshot and no changelog is refused by every device that has data. |
| **Import backup** | Replace local, push as a snapshot with a fresh `wipedAt`. | FK-validate the import: drop orphans rather than importing dangling references. |
| **Restore backup tier** | Fetch the tier file, verify, decrypt, replace local, push with `wipedAt`. | Verify the passphrase against *that file's* verifier — a backup may predate a passphrase change. |
| **Change passphrase** | New salt → re-derive → force push everything re-encrypted. | Other devices detect the salt change, fail the verifier, and prompt. There is no automatic rekey. |

### The `wipedAt` mechanism

A destructive operation (wipe, import, restore) stamps the snapshot with `wipedAt = now`, resets the changelog to
`[]` and records `lastWipeSeenAt = wipedAt` on the device that did it. Every other device checks:

```
if snapshot.wipedAt != myLastWipeSeenAt and snapshot.wipedAt > myLastPulledAt:
    → this device has NOT seen the wipe → bootstrap from the snapshot, keep only its own
      pending edits newer than the wipe, record lastWipeSeenAt, then sync normally
```

This is what makes "wipe" mean *wipe everywhere* instead of "wipe here and let the other devices push it all back".
Everything in the changelog after the reset was pushed after it, so the adopting device applies it rather than
clearing it (clearing it destroyed other devices' post-reset edits).

- **Keep `wipedAt` through compaction.** A device offline through the reset must still adopt it when it returns,
  however many compactions happened meanwhile.
- **Adopt a reset once, by identity.** `wipedAt` comes from the resetting device's clock and `lastPulledAt` from this
  one's; with a clock running behind, the comparison alone stays true and the device would re-adopt the reset on
  every sync, discarding its own edits each time. `lastWipeSeenAt` makes it a one-time event.
- **Repair a missing changelog.** Older builds deleted it; a snapshot carrying `wipedAt` with no changelog is
  recreated with `[]` and then handled as above.

---

## 13. GitHub API limits and how they translate into a budget

*Verify these against current GitHub documentation — they change.*

### Rate limits

| Limit | Value | Consequence for the design |
|---|---|---|
| Primary, authenticated (PAT) | **5,000 requests/hour** | ~1.4 req/s sustained. A 30 s poll of 2 files = 240 req/h/device. Comfortable for ≤5 devices; fatal for a shared repo used by many users. |
| **`304 Not Modified` responses** | **do not count** | This is why conditional GET polling is the single highest-value optimization available. |
| Concurrent requests | ~100 | Never an issue at this scale; do not fan out unbounded parallel requests anyway. |
| Secondary limits on content-generating requests (POST/PUT/PATCH/DELETE) | points-based, per-minute and per-hour | Bulk imports that push thousands of entries **will** trip these. Batch the writes into fewer, larger files. |
| CPU time | ~90 s per 60 s wall clock | Only reachable with pathological usage. |

**Budget worked example** — 3 devices, 30 s poll, conditional GET:
`3 devices × 120 polls/h × 2 files = 720 requests/h`, of which nearly all return 304 and cost nothing. Actual
metered usage is dominated by writes: a busy hour might be 60–100 requests. Headroom is roughly 50×.

**Without** conditional GET, the same fleet spends 720 metered req/h — still under the cap, but a fourth device plus
an error-retry storm gets uncomfortable.

### Payload limits

| Limit | Value | Consequence |
|---|---|---|
| Contents API `GET` returning JSON `content` | **≤ 1 MB** | Above this the `content` field is **empty**. You must re-request with `Accept: application/vnd.github.raw`. Silently returning empty content for large files is a classic first-week bug. |
| Contents API `GET` with raw media type | up to **100 MB** | The only way to read large files through the Contents API. |
| Files > 100 MB | **unsupported** | Requires Git LFS. Out of scope for this design. |
| Base64 encoding | **+33 % size** | Everything you write through the Contents API inflates. Budget accordingly. |
| AES-GCM overhead | +12 B IV, +16 B tag per blob | Negligible per file, non-negligible across thousands of tiny entities. |
| Repository size | soft recommendation **< 1 GB**; warnings around 5 GB | With history retained forever, this is the real cap — hence §11. |

**Practical guidance:** cap total user-visible storage in the app (this app uses **30 MB**), and keep individual files
to a few MB. The reason is not the API's hard limit but the fact that the entire snapshot is read, decrypted,
re-encrypted and re-uploaded on every compaction.

### Semantics you must design around

- **No append operation.** Every write is a full-file replace. This is why the changelog exists and why it must stay
  bounded.
- **No atomic multi-file write via the Contents API.** Each `PUT` is its own commit. Use the Git Data API
  (tree → commit → ref CAS) if you need atomicity.
- **No push notifications.** Polling is the only option for a client-only app. Webhooks require a server.
- **No server-side query.** You cannot ask "what changed since X". You fetch whole files and diff client-side.
- **No transactions or locks.** SHA-based CAS is the only primitive.
- **History is permanent-ish.** Anything ever committed is retrievable until GitHub GCs unreachable objects on its own
  schedule. Never commit a secret, even briefly.
- **The PAT is a bearer token with no scoping below repo level.** Use a fine-grained PAT restricted to a single repo
  with `contents: read/write`. Nothing weaker works; nothing stronger should be granted.

---

## 14. Lessons learned (the expensive ones)

These are the bugs that were not obvious from the design and cost real debugging time. If you implement nothing else
from this document, implement the mitigations here.

### 1. The compaction gap — silent data loss

**Symptom:** a device offline for a while comes back and is missing changes that other devices definitely made.

**Cause:** device A goes offline. Devices B and C sync, accumulate entries, and compact — the entries are absorbed
into the snapshot and the changelog is reset to `[]`. Device A returns, fetches the changelog (empty), sees nothing to
apply, and concludes it is up to date. The changes exist only in the snapshot, which A never reads in the steady state.

**Fix:** track the last-seen snapshot SHA. Whenever it changes, **reconcile the full snapshot into the local database
with a field-level merge** (not a replace — local unsynced changes must survive). This is step 9 in §6 and it is not
optional.

### 2. Compaction that clears a changelog it never read

**Symptom:** occasional lost entries under multi-device activity.

**Cause:** compaction reads the changelog, does slow work (decrypt, merge, encrypt, upload snapshot), then clears the
changelog. Another device appended during that window; the clear destroys those entries.

**Fix:** re-fetch the changelog immediately before clearing and compare SHAs. If it moved, skip the clear entirely.
Make the ambiguous case always fall on "don't clear".

### 3. Keepalive flush creates duplicate entries

**Symptom:** duplicated entries in the remote changelog; occasional resurrection of stale values.

**Cause:** the on-hide keepalive `PUT` is fire-and-forget — the page is suspending, so there is no way to await it and
clear the local pending queue. Those entries are pushed *and* still pending locally, so the next sync pushes them again.

**Fix:** give every change entry a unique id and, before pushing, drop pending entries whose ids already appear
remotely (and delete them locally). Idempotency by construction rather than by coordination.

### 4. Dropping the salt with the key breaks everything until restart

**Symptom:** "no encryption key" errors on any operation between syncs; only restarting the app fixes it.

**Cause:** the key cache expires on idle/backgrounding for security. The implementation cleared **both** the key and
the salt. Without the salt there is no way to re-derive, and nothing re-populates it until a full sync happens to run.

**Fix:** expire the key, keep the salt (it is public material). Provide an explicit `ensureKey()` that re-derives from
the stored passphrase + surviving salt, and call it from every non-sync path that needs the key.

**Generalized lesson:** when you expire a cache for security, verify there is a **re-derivation path that does not
require the original trigger**. "Restart the app" is not a recovery path.

### 5. A Content-Security-Policy that silently kills your KDF

**Symptom:** a cryptographic operation works in dev and fails only in production, for six weeks, unnoticed.

**Cause:** a hardening CSP was added that omitted `'wasm-unsafe-eval'`. The Argon2id implementation compiles
WebAssembly, so every Argon2 code path threw in production only. Dev had no CSP; tests had no browser CSP.

**Fix:** `script-src 'self' 'wasm-unsafe-eval'` when using WASM crypto — and, more importantly, **verify security-critical
paths against the built, deployed bundle**, not the dev server. A dev-only test suite cannot see a CSP bug, a service
worker bug, or a bundler bug.

### 6. Merge must be able to say "nothing changed"

**Symptom:** two devices syncing forever, each write triggering the other.

**Cause:** a merge that always returns an entity causes a local write, which records a change entry, which pushes,
which the other device applies and re-writes.

**Fix:** the merge returns `null` when the local entity is already current, and the caller skips the write entirely.

### 7. Union-merged arrays need a fully deterministic sort

**Symptom:** two devices repeatedly rewriting the same entity with identical content.

**Cause:** the union produced the same *set* in different *orders* on each device, so each saw the other's version as
different and rewrote it.

**Fix:** sort by a total order with a deterministic tie-break (`timestamp, then id`).

### 8. Version-gate before touching anything

A device running an older app version must **refuse** to write when the remote schema version is newer — not attempt a
best-effort merge. One old device writing an old-shaped snapshot corrupts the state for the whole fleet. Refusing is a
minor inconvenience; corrupting is unrecoverable.

Symmetrically, stamp every change entry with the schema version that produced it, and normalize incoming entries by
that version on the receiving side.

### 9. Force push is a loaded gun

An empty local database force-pushed over a populated remote destroys everything on every device. It happens: a
mis-click right after a wipe, or before the first pull completes.

**Fix:** refuse the push when local is empty and remote is not, and back up the remote before any destructive
overwrite. Both guards are three lines each.

### 10. Test with realistic data volumes

Behaviour verified on 3 entities can be completely different on 100. This bit us in a non-sync area (an animation that
never armed on large datasets because the layout landed across several commits instead of one), and the lesson
transfers directly: **probe with real-sized data**, especially anything involving batching, thresholds, or timing.

---

## 15. Known limitations and residual risks

Stated plainly, because a reimplementation should decide consciously whether to accept them.

1. **Millisecond ties diverge.** If two devices write the same field at the exact same millisecond, `remote > local`
   is false on both sides and each keeps its own value — permanently, since compaction preserves the same rule.
   *Vanishingly rare in single-user use; trivially fixed in a new implementation by tie-breaking on `deviceId`
   lexicographically. Do that if you are writing this fresh.*
2. **No clock-skew handling.** A device with a materially wrong clock either always wins merges (fast clock) or never
   wins (slow clock), silently. There is no server clock to anchor against. Mitigation for a new implementation: on
   sync, compare the local clock against the API response `Date` header and warn (or refuse to write) beyond a
   threshold.
3. **Tombstone window vs. offline window.** A device offline longer than the tombstone retention (30 days) resurrects
   entities deleted elsewhere.
4. **Torn state between snapshot and changelog.** Non-atomic multi-file writes; tolerated, not prevented (§8).
5. **Metadata leakage.** Entity counts, structure, ordering, status, sizes and sync timing are plaintext by design.
   E2EE protects content, not shape or rhythm.
6. **Passphrase loss = total loss.** No recovery, no reset, no escrow.
7. **PAT compromise = full read/write** to the repo — including the ability to delete history. E2EE means the attacker
   cannot *read* content, but they can destroy it. Backups mitigate; nothing prevents.
8. **Repository history retention.** Anything ever committed persists until GitHub garbage-collects unreachable
   objects, on its own schedule.
9. **Client-side-only validation.** Any client with the PAT can write malformed data. Receivers must validate shape
   defensively on every entry.
10. **Fire-and-forget housekeeping can starve.** Backups, blob compaction and history squash only run after a
    *successful* sync. A device that never syncs successfully never performs them.

---

## 16. Implementation checklist

Ordered so each step is testable before the next.

**Phase 1 — local first**
- [ ] Local database with the entity contract from §4 (`id`, `createdAt`, `updatedAt`, `deletedAt`, `fieldTimestamps`).
- [ ] Every mutation stamps `fieldTimestamps` for exactly the changed fields.
- [ ] Every mutation writes a change entry **in the same transaction as the data write.** A change that is written
      without its entry never syncs; an entry without its change syncs a lie.
- [ ] Soft deletes only.
- [ ] Cap the change log when sync is disabled, so it cannot grow forever for users who never enable sync.

**Phase 2 — API layer**
- [ ] `getFile` / `putFile` / `deleteFile` with SHA-based CAS, per-request timeout, and shape validation.
- [ ] Rate-limit detection from response headers, surfaced as a distinct typed error.
- [ ] Conditional `getFile` with `ETag` / `If-None-Match`.
- [ ] Binary helpers (raw media type for download, base64 for upload) if you need blobs.
- [ ] Git Data API helpers (ref / tree / commit / blob) if you need history compaction or atomic multi-file writes.

**Phase 3 — crypto**
- [ ] KDF with a stored public salt.
- [ ] Verifier written to the snapshot; checked before any decryption of real data.
- [ ] Per-entity field encryption with AAD binding, and a legacy fallback path if you are retrofitting.
- [ ] In-memory key cache with idle expiry that **keeps the salt**, plus an explicit `ensureKey()`.

**Phase 4 — merge**
- [ ] `merge(local, remote, ts)` returning `null` when unchanged.
- [ ] Union-merge for append-style collections, with a deterministic sort.
- [ ] Entity shape validation before applying any remote entry.
- [ ] Per-entry schema-version normalization.

**Phase 5 — engine**
- [ ] Sync lock with expiry and guaranteed release.
- [ ] The full `sync()` flow from §6, including all bootstrap branches.
- [ ] **Snapshot reconciliation on SHA change** (lesson 1).
- [ ] Conflict retry that applies the winner's entries before rebuilding (§7).
- [ ] Compaction with the SHA-guarded clear (lesson 2).
- [ ] Entry-id dedup before push (lesson 3).
- [ ] Version gate that refuses to write when remote is newer.

**Phase 6 — operations**
- [ ] Scheduler state machine, backoff, rate-limit parking.
- [ ] Force push (with the empty-local guard), force pull, wipe (with `wipedAt`), import, restore.
- [ ] Backup tiers with remote freshness checks and jitter.
- [ ] History compaction for the default branch and the blob branch, both with ref re-read guards.
- [ ] Typed error classification surfaced to the UI, plus a persistent diagnostics log.

---

## 17. Test matrix

The sync layer should be the most heavily tested part of the codebase. It fails rarely, in production, on someone
else's device, and destructively.

**Merge semantics**
- Field-level merge picks the newer value per field, independently.
- Merge returns "unchanged" when local is already current.
- Missing `fieldTimestamps` on either side falls back to entity-level LWW.
- Union arrays converge regardless of which side is newer; sort is deterministic.
- Tombstone wins when its timestamp ≥ local `updatedAt`.

**Engine flows**
- First sync with no remote; bootstrap from snapshot; fresh device with both files present.
- Own-device entries are filtered out on pull; **all** entries are applied on force pull.
- Push returns the remaining pending count for batch continuation.
- Version gate blocks on a newer remote.
- `wipedAt` forces a bootstrap when newer than `lastPulledAt`, once per reset (`lastWipeSeenAt`), keeping
  post-reset entries from other devices and this device's own post-reset edits.

**Concurrency**
- 409 retry re-fetches, applies foreign entries, rebuilds, and succeeds.
- 409 retry gives up cleanly after N attempts, leaving pending entries intact.
- Compaction skips the clear when the changelog SHA moved.
- Two simultaneous compactions do not lose entries.
- Blob/history compaction aborts when the ref moved.

**Failure injection**
- Corrupted changelog JSON; truncated snapshot; HTML error page instead of JSON.
- Network error, 5xx, timeout, abort.
- Rate-limit response parks the scheduler and resumes after reset.
- The sync lock is always released — after success, after failure, after abort.
- Wrong passphrase: verifier fails, nothing is written, nothing is wiped.

**Data-loss guards (assert these explicitly)**
- Force push refuses empty-local-over-populated-remote.
- Wipe backs up the remote snapshot before overwriting.
- Snapshot reconciliation recovers entries absorbed by a compaction that happened while offline.
- A device that pushed via the keepalive flush does not duplicate those entries on the next sync.

**Crypto**
- Round-trip encrypt/decrypt for entities, entries and binary blobs.
- AAD binding: a ciphertext moved to another entity id **fails** to decrypt.
- Legacy unbound blobs still decrypt via the fallback.
- Verifier accepts the right passphrase and rejects the wrong one.

---

## 18. Porting notes

The protocol is language-agnostic. What must be swapped:

| Concern | Browser (this implementation) | Elsewhere |
|---|---|---|
| Local store | IndexedDB (Dexie) | SQLite, LMDB, files — any store with transactions |
| Crypto | Web Crypto (`crypto.subtle`) | libsodium, OpenSSL, Tink — AES-256-GCM + PBKDF2/Argon2id |
| HTTP | `fetch` + `AbortSignal` | Any client with per-request timeouts |
| Scheduling | timers + `visibilitychange` | A background worker or daemon loop |
| Backgrounding | `keepalive` fetch on hide | Graceful-shutdown hook that flushes pending writes |
| Offline detection | `navigator.onLine` | Connection probe or OS network API |

**What does not change:** the file layout, the two-file split, the change-entry format, `fieldTimestamps` merge,
SHA-based CAS, the compaction lock, tombstone semantics, the version gate, and every guard in §14. Those are the
protocol. Everything else is plumbing.

**Interoperability:** two implementations in different languages can share one repository provided they agree on the
JSON shapes, the KDF parameters, the AES-GCM layout (`iv || ciphertext`, 12-byte IV), the AAD string format, the
sensitive-field lists per entity type, and the sync version number. Fix all of these in a shared spec before writing
the second implementation — a mismatch in any one of them is a silent decryption failure or a silent data loss.

---

## Appendix: reference constants

Tuned for a personal task app across ~3 devices. Re-tune for your workload; the relationships matter more than the
values.

| Constant | Value | Rationale |
|---|---|---|
| `POLL_INTERVAL` | 30 s | Balances propagation latency against rate limit. |
| `BACKOFF_CAP` | 300 s | 30 → 60 → 120 → 240 → 300. |
| `IDLE_THRESHOLD` | 3 s | Debounce: sync after the user pauses. |
| `FIRST_BATCH_DELAY` | 15 s | Hard deadline so continuous typing still pushes. |
| `FIRST_BATCH_SIZE` / `BATCH_SIZE` | 5 / 10 | Fast first replication, then steady drain. |
| `MIN_RESYNC_INTERVAL` | 10 s | Debounces visibility-change syncs. |
| `COMPACTION_THRESHOLD` | 30 entries | Keeps the changelog small enough to fetch cheaply. |
| `MAX_CHANGELOG_ENTRIES` | 500 | Hard ceiling; forces compaction before the next pull. |
| `MAX_RETRIES` (409) | 3 | Beyond this, defer to the next sync. |
| `REQUEST_TIMEOUT` | 15 s | Per HTTP request. |
| `SYNC_TIMEOUT` | 45 s | Whole-sync lock expiry. |
| `KEY_IDLE_TIMEOUT` | 30 min | Key cache expiry while active. |
| `KEY_HIDDEN_TIMEOUT` | 5 min | Shorter expiry when backgrounded. |
| `PBKDF2_ITERATIONS` | 600,000 | OWASP guidance for PBKDF2-HMAC-SHA256. |
| `TOMBSTONE_RETENTION` | 30 days | Must exceed the longest realistic offline period. |
| `BLOB_COMPACTION_INTERVAL` | 6 h | Sweeps deletions made on other devices. |
| `HISTORY_SQUASH_INTERVAL` | ~30 days | Bounds git history growth. |
| `MAX_TOTAL_STORAGE` | 30 MB | App-level cap; keeps compaction cheap. |

---

*Extracted from the `gtd25` implementation in `src/sync/`. The authoritative source is the code; where this document
and the code disagree, the code is right and this document should be corrected.*
