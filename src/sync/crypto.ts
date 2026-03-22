import type { SyncData, ChangeEntry } from '../db/models';

// --- Constants ---
const PBKDF2_ITERATIONS = 600_000;
const VERIFIER_PLAINTEXT = 'gtd25-encryption-check';

const SENSITIVE_FIELDS: Record<string, string[]> = {
  taskList: ['name'],
  task: ['title', 'description', 'link', 'linkTitle', 'links'],
  subtask: ['title', 'link', 'linkTitle', 'links'],
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

export async function encryptBlob(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext),
  );

  // Concat IV + ciphertext
  const result = new Uint8Array(iv.length + ciphertext.byteLength);
  result.set(iv);
  result.set(new Uint8Array(ciphertext), iv.length);
  return uint8ToBase64(result);
}

export async function decryptBlob(key: CryptoKey, base64Str: string): Promise<string> {
  const data = base64ToUint8(base64Str);
  const iv = data.slice(0, 12);
  const ciphertext = data.slice(12);

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext,
  );

  return new TextDecoder().decode(plaintext);
}

// --- Per-entity encryption ---

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

  // Encrypt
  const blob = await encryptBlob(key, JSON.stringify(sensitiveData));

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
  _entityType: string,
): Promise<Record<string, unknown>> {
  if (!entity._enc || typeof entity._enc !== 'string') return entity;

  const plaintext = await decryptBlob(key, entity._enc);
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
  const [taskLists, tasks, subtasks] = await Promise.all([
    Promise.all(data.taskLists.map((e) => encryptEntity(key, e as unknown as Record<string, unknown>, 'taskList'))),
    Promise.all(data.tasks.map((e) => encryptEntity(key, e as unknown as Record<string, unknown>, 'task'))),
    Promise.all(data.subtasks.map((e) => encryptEntity(key, e as unknown as Record<string, unknown>, 'subtask'))),
  ]);

  return {
    ...data,
    taskLists: taskLists as unknown as SyncData['taskLists'],
    tasks: tasks as unknown as SyncData['tasks'],
    subtasks: subtasks as unknown as SyncData['subtasks'],
  };
}

export async function decryptSyncData(key: CryptoKey, data: SyncData): Promise<SyncData> {
  const [taskLists, tasks, subtasks] = await Promise.all([
    Promise.all(data.taskLists.map((e) => decryptEntity(key, e as unknown as Record<string, unknown>, 'taskList'))),
    Promise.all(data.tasks.map((e) => decryptEntity(key, e as unknown as Record<string, unknown>, 'task'))),
    Promise.all(data.subtasks.map((e) => decryptEntity(key, e as unknown as Record<string, unknown>, 'subtask'))),
  ]);

  return {
    ...data,
    taskLists: taskLists as unknown as SyncData['taskLists'],
    tasks: tasks as unknown as SyncData['tasks'],
    subtasks: subtasks as unknown as SyncData['subtasks'],
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
