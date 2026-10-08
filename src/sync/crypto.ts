import type { SyncData, ChangeEntry } from '../db/models';

// --- Constants ---
const PBKDF2_ITERATIONS = 600_000;
const VERIFIER_PLAINTEXT = 'gtd25-encryption-check';

// `fieldTimestamps` is on every list (SYNC_VERSION 7). Its KEYS are the field
// names of the record, including the encrypted ones, and its values are when each
// one last changed — so leaving it in the clear told a backend reader, and a disk
// image of a LOCKED Paranoid device, which encrypted fields exist per record and
// when each was edited. Concretely it exposed the discussionLog's last append
// (which the doc claimed was hidden) and distinguished a shared-folder link (key
// `url`) from a file (keys `blobId`+`mimeType`) without decrypting anything.
// Safe to move inside the blob because every merge runs AFTER decryption.
const FIELD_TIMESTAMPS = 'fieldTimestamps';

// `_base` / `_pushed` (sync/conflicts.ts) name the fields and when each was last
// seen from / sent to the remote — as telling as fieldTimestamps, so they ride
// inside the blob too.
const BASE = '_base';
const PUSHED = '_pushed';

export const SENSITIVE_FIELDS: Record<string, string[]> = {
  taskList: ['name', 'savedSearches', 'notDuplicates', FIELD_TIMESTAMPS, BASE, PUSHED],
  task: ['title', 'description', 'link', 'linkTitle', 'links', 'discussionLog', FIELD_TIMESTAMPS, BASE, PUSHED],
  subtask: ['title', 'link', 'linkTitle', 'links', FIELD_TIMESTAMPS, BASE, PUSHED],
  // Shared Folder: everything except opaque id/order/timestamps is encrypted —
  // no filename, type, size, URL or blob-ref leaks. Same exposure level as tasks.
  // `expiresAt` too: in the clear it would say which device runs Paranoid Mode.
  sharedItem: ['type', 'name', 'size', 'url', 'blobId', 'mimeType', 'expiresAt', FIELD_TIMESTAMPS, BASE, PUSHED],
  // Mindmaps: names/labels are content; structural refs (parentId/folderId/mapId)
  // stay plaintext so structure merges without decrypting (like Task.listId).
  mindmapFolder: ['name', FIELD_TIMESTAMPS, BASE, PUSHED],
  mindmap: ['name', 'background', 'smartColoring', FIELD_TIMESTAMPS, BASE, PUSHED],
  // Formatting rides along encrypted: a palette is content ("red = blocked"),
  // and it costs nothing to hide it. Structure (parentId/order) stays plaintext.
  mindmapNode: ['label', 'shape', 'palette', 'colorBg', 'colorFg', 'colorBorder', FIELD_TIMESTAMPS, BASE, PUSHED],
  // A recorded sync conflict (local only, at rest): both versions are content,
  // and the field names which one (its id is a hash for the same reason).
  syncConflict: ['label', 'localValue', 'remoteValue', 'field'],
};

// --- Key cache ---
let cachedKey: CryptoKey | null = null;
let cachedSalt: string | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// Expiry drops only the KEY. The salt is public material (it ships in the
// remote snapshot) and deliberately survives, so ensureEncryptionKey() in
// sync-engine can re-derive on demand from the stored password without a
// network fetch — otherwise every blob operation between the expiry and the
// next sync fails with NO_SYNC_KEY until a restart.
function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  if (cachedKey) {
    idleTimer = setTimeout(() => {
      cachedKey = null;
      idleTimer = null;
    }, IDLE_TIMEOUT_MS);
  }
}

// Clear key when tab becomes hidden
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && cachedKey) {
      // Don't clear immediately — just shorten the timeout for background tabs
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        cachedKey = null;
        idleTimer = null;
      }, 5 * 60 * 1000); // 5 min when hidden
    } else if (document.visibilityState === 'visible') {
      resetIdleTimer();
    }
  });
}

export function clearEncryptionKey() {
  cachedKey = null;
  cachedSalt = null;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  // Locking calls this: what was decrypted goes with the keys.
  decryptedBlobs = new WeakMap();
}

// --- Decrypted entity blobs, remembered ---
//
// Every read in Paranoid Mode decrypts every row it returns, and the live
// queries re-read whole tables after each write: ~0.5 s per read at a few
// thousand tasks on a desktop, several times that on a phone. A ciphertext
// always opens to the same text, so it is decrypted once per key: the cache is
// keyed by the key object and by type, id and the ciphertext itself (a row that
// changes gets a new one — a fresh IV on every write). Only the decrypted JSON
// is kept: the row is rebuilt from what is stored now, and parsed afresh for
// each caller. Dropped on lock (clearEncryptionKey); bounded.
const MAX_DECRYPTED_BLOBS = 50_000;
let decryptedBlobs = new WeakMap<CryptoKey, Map<string, string>>();

function rememberedPlaintext(key: CryptoKey, id: string): string | undefined {
  return decryptedBlobs.get(key)?.get(id);
}

function rememberPlaintext(key: CryptoKey, id: string, plaintext: string): void {
  let blobs = decryptedBlobs.get(key);
  if (!blobs) decryptedBlobs.set(key, (blobs = new Map()));
  if (blobs.size >= MAX_DECRYPTED_BLOBS) blobs.delete(blobs.keys().next().value!); // the oldest
  blobs.set(id, plaintext);
}

export function hasEncryptionKey(): boolean {
  return cachedKey !== null;
}

export function getCachedEncryptionKey(): CryptoKey | null {
  resetIdleTimer();
  return cachedKey;
}

// Whether a sync key may be cached right now. db/vault installs the real rule —
// never while a Paranoid vault is locked: locking drops the key, and a derivation
// still running at that moment (PBKDF2-600k, ~1 s) used to put it back afterwards.
let mayCacheKey: () => boolean = () => true;

export function setSyncKeyCacheGuard(guard: () => boolean): void {
  mayCacheKey = guard;
}

export function cacheEncryptionKey(key: CryptoKey, salt: string) {
  if (!mayCacheKey()) return;
  cachedKey = key;
  cachedSalt = salt;
  resetIdleTimer();
}

export function getCachedSalt(): string | null {
  return cachedSalt;
}

// --- Primitives ---

export function generateSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return uint8ToBase64(bytes);
}

export async function deriveKey(password: string, saltBase64: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  const salt = base64ToUint8(saltBase64);

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptBlob(key: CryptoKey, plaintext: string, aad?: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, ...(aad ? { additionalData: aad as BufferSource } : {}) },
    key,
    encoder.encode(plaintext),
  );

  // Concat IV + ciphertext
  const result = new Uint8Array(iv.length + ciphertext.byteLength);
  result.set(iv);
  result.set(new Uint8Array(ciphertext), iv.length);
  return uint8ToBase64(result);
}

export async function decryptBlob(key: CryptoKey, base64Str: string, aad?: Uint8Array): Promise<string> {
  const data = base64ToUint8(base64Str);
  const iv = data.slice(0, 12);
  const ciphertext = data.slice(12);

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, ...(aad ? { additionalData: aad as BufferSource } : {}) },
    key,
    ciphertext,
  );

  return new TextDecoder().decode(plaintext);
}

// --- Binary (raw bytes) encryption ---
// Key-agnostic: used with the sync key (wire) AND the Paranoid DEK (at rest).
// Returns/consumes IV(12) || ciphertext as raw bytes (no base64 — the GitHub
// layer base64-encodes for transport, the at-rest cache stores bytes directly).

export async function encryptBytes(key: CryptoKey, bytes: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, ...(aad ? { additionalData: aad as BufferSource } : {}) },
    key,
    bytes as BufferSource,
  );
  const result = new Uint8Array(iv.length + ciphertext.byteLength);
  result.set(iv);
  result.set(new Uint8Array(ciphertext), iv.length);
  return result;
}

export async function decryptBytes(key: CryptoKey, data: Uint8Array, aad?: Uint8Array): Promise<Uint8Array> {
  const iv = data.slice(0, 12);
  const ciphertext = data.slice(12);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, ...(aad ? { additionalData: aad as BufferSource } : {}) },
    key,
    ciphertext as BufferSource,
  );
  return new Uint8Array(plaintext);
}

// --- Per-entity encryption ---

// AES-GCM additional-authenticated-data binding the sensitive-field blob to the record
// it belongs to: the entity type + its id. The blob then can't be silently relocated
// onto a different record (e.g. moving task A's encrypted title/description onto task B)
// — a swap fails authentication and surfaces as unreadable rather than impersonating
// B's content (ACR-005). Newly-written blobs carry this AAD; legacy blobs (written
// before this change) have none and are still readable via the fallback below, gaining
// the binding the next time the record is re-encrypted.
const teAad = new TextEncoder();
function entityAad(entityType: string, entity: Record<string, unknown>): Uint8Array | undefined {
  const id = entity.id;
  if (typeof id !== 'string' || id.length === 0) return undefined; // no stable id -> no binding
  return teAad.encode(`${entityType}:${id}`);
}

export async function encryptEntity(
  key: CryptoKey,
  entity: Record<string, unknown>,
  entityType: string,
): Promise<Record<string, unknown>> {
  const fields = SENSITIVE_FIELDS[entityType];
  if (!fields) throw new Error(`Unknown entity type for encryption: ${entityType}`);

  // Extract sensitive fields
  const sensitiveData: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in entity) {
      sensitiveData[field] = entity[field];
    }
  }

  // Encrypt — bound to this record's type+id when an id is present.
  const blob = await encryptBlob(key, JSON.stringify(sensitiveData), entityAad(entityType, entity));

  // Build result without sensitive fields
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entity)) {
    if (!fields.includes(k)) {
      result[k] = v;
    }
  }
  result._enc = blob;
  return result;
}

export async function decryptEntity(
  key: CryptoKey,
  entity: Record<string, unknown>,
  entityType: string,
): Promise<Record<string, unknown>> {
  if (entity._enc === undefined) return entity;
  // Anything but ciphertext here is forged or corrupt. Passed through, a non-string
  // `_enc` reached the field merge and then the at-rest layer, which took it for
  // "already encrypted" and stored the real content beside it in plaintext.
  if (typeof entity._enc !== 'string') throw new Error(`Malformed ${entityType} record: _enc is not ciphertext`);

  const aad = entityAad(entityType, entity);
  const blobId = `${entityType}\u0000${String(entity.id)}\u0000${entity._enc}`;
  let plaintext = rememberedPlaintext(key, blobId);
  if (plaintext === undefined) {
    try {
      // New blobs are bound to type+id; verify that binding.
      plaintext = await decryptBlob(key, entity._enc, aad);
    } catch (err) {
      // Fallback for blobs written before AAD binding (no additionalData). If there is no
      // AAD to try, this was already the unbound attempt, so the error is genuine.
      if (!aad) throw err;
      plaintext = await decryptBlob(key, entity._enc);
    }
    rememberPlaintext(key, blobId, plaintext);
  }
  const sensitiveData = JSON.parse(plaintext) as Record<string, unknown>;

  // Spread decrypted fields back, remove _enc — and any content field sitting in
  // the clear beside the ciphertext: content only ever comes from the blob, or a
  // backend writer could add a description or link to a genuine record.
  // (fieldTimestamps stays: rows written before SYNC_VERSION 7 carry it outside.)
  const content = new Set((SENSITIVE_FIELDS[entityType] ?? []).filter((f) => f !== FIELD_TIMESTAMPS));
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entity)) {
    if (k !== '_enc' && !content.has(k)) {
      result[k] = v;
    }
  }
  Object.assign(result, sensitiveData);
  // Timestamps on both sides (a row stamped while locked — e.g. a startup expiry
  // setting deletedAt — gets them outside its ciphertext): keep the later of each,
  // or the outside ones were silently dropped here.
  const outer = entity[FIELD_TIMESTAMPS];
  const inner = sensitiveData[FIELD_TIMESTAMPS];
  if (outer && inner && typeof outer === 'object' && typeof inner === 'object') {
    const merged: Record<string, number> = { ...(inner as Record<string, number>) };
    for (const [k, v] of Object.entries(outer as Record<string, unknown>)) {
      if (typeof v === 'number' && !(merged[k] >= v)) merged[k] = v;
    }
    result[FIELD_TIMESTAMPS] = merged;
  }
  return result;
}

// --- SyncData-level encryption ---

export async function encryptSyncData(key: CryptoKey, data: SyncData): Promise<SyncData> {
  const [taskLists, tasks, subtasks, sharedItems, mindmapFolders, mindmaps, mindmapNodes] = await Promise.all([
    Promise.all(data.taskLists.map((e) => encryptEntity(key, e as unknown as Record<string, unknown>, 'taskList'))),
    Promise.all(data.tasks.map((e) => encryptEntity(key, e as unknown as Record<string, unknown>, 'task'))),
    Promise.all(data.subtasks.map((e) => encryptEntity(key, e as unknown as Record<string, unknown>, 'subtask'))),
    Promise.all((data.sharedItems ?? []).map((e) => encryptEntity(key, e as unknown as Record<string, unknown>, 'sharedItem'))),
    Promise.all((data.mindmapFolders ?? []).map((e) => encryptEntity(key, e as unknown as Record<string, unknown>, 'mindmapFolder'))),
    Promise.all((data.mindmaps ?? []).map((e) => encryptEntity(key, e as unknown as Record<string, unknown>, 'mindmap'))),
    Promise.all((data.mindmapNodes ?? []).map((e) => encryptEntity(key, e as unknown as Record<string, unknown>, 'mindmapNode'))),
  ]);

  return {
    ...data,
    taskLists: taskLists as unknown as SyncData['taskLists'],
    tasks: tasks as unknown as SyncData['tasks'],
    subtasks: subtasks as unknown as SyncData['subtasks'],
    ...(data.sharedItems ? { sharedItems: sharedItems as unknown as SyncData['sharedItems'] } : {}),
    ...(data.mindmapFolders ? { mindmapFolders: mindmapFolders as unknown as SyncData['mindmapFolders'] } : {}),
    ...(data.mindmaps ? { mindmaps: mindmaps as unknown as SyncData['mindmaps'] } : {}),
    ...(data.mindmapNodes ? { mindmapNodes: mindmapNodes as unknown as SyncData['mindmapNodes'] } : {}),
  };
}

// Every row of an encrypted snapshot carries ciphertext (encryptEntity always adds
// `_enc`). One without it, or with an `_enc` that is not ciphertext, was planted
// or corrupted by whoever can write the repository: drop it (this device keeps
// its own copy, and the next compaction rewrites the row from it). Ciphertext
// that fails to open still throws, as before.
function decryptRows(key: CryptoKey, rows: unknown[] | undefined, entityType: string): Promise<Record<string, unknown>[]> {
  const wellFormed = (rows ?? []).filter((e) => {
    if (typeof (e as Record<string, unknown>)._enc === 'string') return true;
    console.warn(`Dropping a ${entityType} row without ciphertext from the snapshot`);
    return false;
  });
  return Promise.all(wellFormed.map((e) => decryptEntity(key, e as Record<string, unknown>, entityType)));
}

export async function decryptSyncData(key: CryptoKey, data: SyncData): Promise<SyncData> {
  const [taskLists, tasks, subtasks, sharedItems, mindmapFolders, mindmaps, mindmapNodes] = await Promise.all([
    decryptRows(key, data.taskLists, 'taskList'),
    decryptRows(key, data.tasks, 'task'),
    decryptRows(key, data.subtasks, 'subtask'),
    decryptRows(key, data.sharedItems, 'sharedItem'),
    decryptRows(key, data.mindmapFolders, 'mindmapFolder'),
    decryptRows(key, data.mindmaps, 'mindmap'),
    decryptRows(key, data.mindmapNodes, 'mindmapNode'),
  ]);

  return {
    ...data,
    taskLists: taskLists as unknown as SyncData['taskLists'],
    tasks: tasks as unknown as SyncData['tasks'],
    subtasks: subtasks as unknown as SyncData['subtasks'],
    ...(data.sharedItems ? { sharedItems: sharedItems as unknown as SyncData['sharedItems'] } : {}),
    ...(data.mindmapFolders ? { mindmapFolders: mindmapFolders as unknown as SyncData['mindmapFolders'] } : {}),
    ...(data.mindmaps ? { mindmaps: mindmaps as unknown as SyncData['mindmaps'] } : {}),
    ...(data.mindmapNodes ? { mindmapNodes: mindmapNodes as unknown as SyncData['mindmapNodes'] } : {}),
  };
}

export async function encryptChangeEntries(key: CryptoKey, entries: ChangeEntry[]): Promise<ChangeEntry[]> {
  return Promise.all(
    entries.map(async (entry) => {
      if (entry.operation === 'delete' || !entry.data) return entry;
      const encrypted = await encryptEntity(key, entry.data, entry.entityType);
      return { ...entry, data: encrypted };
    }),
  );
}

/**
 * Decrypt incoming changelog entries. An upsert without ciphertext is dropped —
 * every entry pushed to an encrypted repository is encrypted, so a plaintext one
 * was planted by whoever can write it, and would be shown as the user's own —
 * unless `allowPlaintext`: only for the first encryption of a repository that
 * has never been encrypted (no salt yet), whose older entries are plaintext.
 */
export async function decryptChangeEntries(
  key: CryptoKey,
  entries: ChangeEntry[],
  { allowPlaintext = false }: { allowPlaintext?: boolean } = {},
): Promise<ChangeEntry[]> {
  const result: ChangeEntry[] = [];
  for (const entry of entries) {
    if (entry.operation === 'delete' || !entry.data) {
      result.push(entry);
      continue;
    }
    if (entry.data._enc === undefined) {
      if (allowPlaintext) result.push(entry);
      else console.warn(`Dropping a ${entry.entityType} entry ${entry.id} without ciphertext`);
      continue;
    }
    try {
      const decrypted = await decryptEntity(key, entry.data, entry.entityType);
      result.push({ ...entry, data: decrypted });
    } catch {
      // Forged or corrupt: dropped. Passed on as-is it could still be applied —
      // nothing downstream rejects an entry carrying plaintext fields beside a
      // bogus `_enc` — and compaction would merge it over the snapshot's row.
      console.warn(`Failed to decrypt ${entry.entityType} entry ${entry.id}, skipping`);
    }
  }
  return result;
}

// --- Verifier ---

export async function createVerifier(key: CryptoKey): Promise<string> {
  return encryptBlob(key, VERIFIER_PLAINTEXT);
}

export async function checkVerifier(key: CryptoKey, verifier: string): Promise<boolean> {
  try {
    const result = await decryptBlob(key, verifier);
    return result === VERIFIER_PLAINTEXT;
  } catch {
    return false;
  }
}

// --- Base64 helpers ---

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
