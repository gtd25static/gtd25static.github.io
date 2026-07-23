import type { SyncData, ChangeEntry } from '../db/models';

// --- Constants ---
const PBKDF2_ITERATIONS = 600_000;
const VERIFIER_PLAINTEXT = 'gtd25-encryption-check';

export const SENSITIVE_FIELDS: Record<string, string[]> = {
  taskList: ['name'],
  task: ['title', 'description', 'link', 'linkTitle', 'links', 'discussionLog'],
  subtask: ['title', 'link', 'linkTitle', 'links'],
  // Shared Folder: everything except opaque id/order/timestamps is encrypted —
  // no filename, type, size, URL or blob-ref leaks. Same exposure level as tasks.
  sharedItem: ['type', 'name', 'size', 'url', 'blobId', 'mimeType'],
  // Mindmaps: names/labels are content; structural refs (parentId/folderId/mapId)
  // stay plaintext so structure merges without decrypting (like Task.listId).
  mindmapFolder: ['name'],
  mindmap: ['name', 'background', 'smartColoring'],
  // Formatting rides along encrypted: a palette is content ("red = blocked"),
  // and it costs nothing to hide it. Structure (parentId/order) stays plaintext.
  mindmapNode: ['label', 'shape', 'palette', 'colorBg', 'colorFg', 'colorBorder'],
};

// --- Key cache ---
let cachedKey: CryptoKey | null = null;
let cachedSalt: string | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  if (cachedKey) {
    idleTimer = setTimeout(() => {
      cachedKey = null;
      cachedSalt = null;
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
        cachedSalt = null;
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
}

export function hasEncryptionKey(): boolean {
  return cachedKey !== null;
}

export function getCachedEncryptionKey(): CryptoKey | null {
  resetIdleTimer();
  return cachedKey;
}

export function cacheEncryptionKey(key: CryptoKey, salt: string) {
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

export async function encryptBytes(key: CryptoKey, bytes: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    bytes as BufferSource,
  );
  const result = new Uint8Array(iv.length + ciphertext.byteLength);
  result.set(iv);
  result.set(new Uint8Array(ciphertext), iv.length);
  return result;
}

export async function decryptBytes(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = data.slice(0, 12);
  const ciphertext = data.slice(12);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
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
  if (!entity._enc || typeof entity._enc !== 'string') return entity;

  const aad = entityAad(entityType, entity);
  let plaintext: string;
  try {
    // New blobs are bound to type+id; verify that binding.
    plaintext = await decryptBlob(key, entity._enc, aad);
  } catch (err) {
    // Fallback for blobs written before AAD binding (no additionalData). If there is no
    // AAD to try, this was already the unbound attempt, so the error is genuine.
    if (!aad) throw err;
    plaintext = await decryptBlob(key, entity._enc);
  }
  const sensitiveData = JSON.parse(plaintext) as Record<string, unknown>;

  // Spread decrypted fields back, remove _enc
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entity)) {
    if (k !== '_enc') {
      result[k] = v;
    }
  }
  Object.assign(result, sensitiveData);
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

export async function decryptSyncData(key: CryptoKey, data: SyncData): Promise<SyncData> {
  const [taskLists, tasks, subtasks, sharedItems, mindmapFolders, mindmaps, mindmapNodes] = await Promise.all([
    Promise.all(data.taskLists.map((e) => decryptEntity(key, e as unknown as Record<string, unknown>, 'taskList'))),
    Promise.all(data.tasks.map((e) => decryptEntity(key, e as unknown as Record<string, unknown>, 'task'))),
    Promise.all(data.subtasks.map((e) => decryptEntity(key, e as unknown as Record<string, unknown>, 'subtask'))),
    Promise.all((data.sharedItems ?? []).map((e) => decryptEntity(key, e as unknown as Record<string, unknown>, 'sharedItem'))),
    Promise.all((data.mindmapFolders ?? []).map((e) => decryptEntity(key, e as unknown as Record<string, unknown>, 'mindmapFolder'))),
    Promise.all((data.mindmaps ?? []).map((e) => decryptEntity(key, e as unknown as Record<string, unknown>, 'mindmap'))),
    Promise.all((data.mindmapNodes ?? []).map((e) => decryptEntity(key, e as unknown as Record<string, unknown>, 'mindmapNode'))),
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

export async function decryptChangeEntries(key: CryptoKey, entries: ChangeEntry[]): Promise<ChangeEntry[]> {
  const result: ChangeEntry[] = [];
  for (const entry of entries) {
    if (entry.operation === 'delete' || !entry.data || !entry.data._enc) {
      result.push(entry);
      continue;
    }
    try {
      const decrypted = await decryptEntity(key, entry.data, entry.entityType);
      result.push({ ...entry, data: decrypted });
    } catch {
      // Corrupted entry — return as-is (still has _enc, will fail validateEntityShape downstream)
      console.warn(`Failed to decrypt ${entry.entityType} entry ${entry.id}, skipping`);
      result.push(entry);
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
