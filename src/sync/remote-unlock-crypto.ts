// Asymmetric crypto for the Paranoid-Mode remote unlock & wipe feature.
//
// All public-key operations use WebCrypto P-256 (universally available, incl.
// Safari): ECDH for "encrypt a secret TO a device" and ECDSA for "this command
// came FROM a device". The module is pure plumbing — it holds no state and knows
// nothing about the vault, the backend, or React.
//
// Trust model (see THREAT_MODEL.md): device identity public keys are distributed
// through a registry on the sync backend, authenticated by a MAC keyed off the
// syncPassword (which a PAT-only attacker does not have) so identity keys cannot
// be injected or substituted.

// --- base64 helpers (mirror src/db/vault-crypto.ts) ---
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
const utf8 = new TextEncoder();

// --- Identity keys ---

export interface PublicIdentity {
  ecdhPub: JsonWebKey;   // P-256 ECDH public key (encrypt-to-device)
  ecdsaPub: JsonWebKey;  // P-256 ECDSA public key (verify commands from device)
}
export interface DeviceIdentity extends PublicIdentity {
  ecdhPriv: JsonWebKey;
  ecdsaPriv: JsonWebKey;
}

/**
 * Generate this device's long-term identity: a P-256 ECDH keypair (for receiving
 * ECIES-encrypted secrets) and a P-256 ECDSA keypair (for signing commands).
 * Keys are returned as JWK so they can be persisted in localSettings.
 */
export async function generateIdentityKeys(): Promise<DeviceIdentity> {
  const ecdh = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const ecdsa = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const [ecdhPub, ecdhPriv, ecdsaPub, ecdsaPriv] = await Promise.all([
    crypto.subtle.exportKey('jwk', ecdh.publicKey),
    crypto.subtle.exportKey('jwk', ecdh.privateKey),
    crypto.subtle.exportKey('jwk', ecdsa.publicKey),
    crypto.subtle.exportKey('jwk', ecdsa.privateKey),
  ]);
  return { ecdhPub, ecdhPriv, ecdsaPub, ecdsaPriv };
}

export function publicIdentityOf(id: DeviceIdentity): PublicIdentity {
  return { ecdhPub: id.ecdhPub, ecdsaPub: id.ecdsaPub };
}

// --- ECDSA sign / verify ---

const ECDSA_PARAMS = { name: 'ECDSA', hash: 'SHA-256' } as const;

export async function signPayload(ecdsaPrivJwk: JsonWebKey, message: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', ecdsaPrivJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign(ECDSA_PARAMS, key, message as BufferSource);
  return bytesToBase64(new Uint8Array(sig));
}

export async function verifyPayload(ecdsaPubJwk: JsonWebKey, sigBase64: string, message: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('jwk', ecdsaPubJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify(ECDSA_PARAMS, key, base64ToBytes(sigBase64) as BufferSource, message as BufferSource);
  } catch {
    return false;
  }
}

// --- ECIES (encrypt bytes TO a device's ECDH public key) ---
//
// Wire form (JSON, base64 fields): { epk: ephemeral ECDH public JWK, iv, ct }.
// Sender makes an ephemeral ECDH keypair, does ECDH against the recipient public
// key, HKDF-SHA256 expands the shared secret to an AES-256-GCM key, encrypts.
// Forward-secret: the ephemeral private key is discarded, so a later compromise
// of the recipient's long-term key still cannot be paired with a captured epk.

export interface EciesBlob { epk: JsonWebKey; iv: string; ct: string }

const HKDF_INFO = utf8.encode('gtd25-remote-unlock-ecies');

async function deriveEciesKey(ecdhPriv: CryptoKey, ecdhPub: CryptoKey, usage: KeyUsage): Promise<CryptoKey> {
  const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: ecdhPub }, ecdhPriv, 256);
  const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: HKDF_INFO as BufferSource },
    hkdfKey,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

export async function eciesEncryptTo(recipientEcdhPubJwk: JsonWebKey, plaintext: Uint8Array): Promise<EciesBlob> {
  const recipientPub = await crypto.subtle.importKey('jwk', recipientEcdhPubJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const aesKey = await deriveEciesKey(eph.privateKey, recipientPub, 'encrypt');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plaintext as BufferSource);
  const epk = await crypto.subtle.exportKey('jwk', eph.publicKey);
  return { epk, iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ct)) };
}

export async function eciesDecrypt(recipientEcdhPrivJwk: JsonWebKey, blob: EciesBlob): Promise<Uint8Array> {
  const recipientPriv = await crypto.subtle.importKey('jwk', recipientEcdhPrivJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const ephPub = await crypto.subtle.importKey('jwk', blob.epk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const aesKey = await deriveEciesKey(recipientPriv, ephPub, 'decrypt');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(blob.iv) as BufferSource }, aesKey, base64ToBytes(blob.ct) as BufferSource);
  return new Uint8Array(pt);
}

// --- Registry MAC (authenticates device identity keys) ---
//
// K_reg = PBKDF2-SHA256(syncPassword, salt, 600k) imported as an HMAC key. Only
// fleet devices that know the syncPassword can mint/verify registry entries; a
// PAT-only attacker cannot. PBKDF2 matches the sync KDF so brute-force economics
// are no weaker than the content key. Derivation is done at enrollment, not on a
// hot path.

const PBKDF2_ITERATIONS = 600_000;

export async function deriveRegistryMacKey(syncPassword: string, saltBase64: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey('raw', utf8.encode(syncPassword), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: base64ToBytes(saltBase64) as BufferSource, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function registryMac(macKey: CryptoKey, message: Uint8Array): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', macKey, message as BufferSource);
  return bytesToBase64(new Uint8Array(sig));
}

export async function verifyRegistryMac(macKey: CryptoKey, macBase64: string, message: Uint8Array): Promise<boolean> {
  try {
    return await crypto.subtle.verify('HMAC', macKey, base64ToBytes(macBase64) as BufferSource, message as BufferSource);
  } catch {
    return false;
  }
}

// --- Verification code & fingerprint (human cross-checks) ---

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
}

/**
 * Short, deterministic code derived from request material, shown on BOTH the
 * requesting and approving screens so the user can confirm they match. A
 * substituted request yields a different code. Format e.g. "47-12".
 */
export async function verificationCode(material: Uint8Array): Promise<string> {
  const h = await sha256(material);
  const n = ((h[0] << 8) | h[1]) % 10000; // 0..9999
  const s = n.toString().padStart(4, '0');
  return `${s.slice(0, 2)}-${s.slice(2)}`;
}

/**
 * A stable "safety number" for a device's public identity, shown on both devices
 * during enrollment for a one-time out-of-band match (backstops a weak
 * syncPassword). Format: five groups of five digits.
 */
export async function identityFingerprint(pub: PublicIdentity): Promise<string> {
  const msg = utf8.encode(canonicalIdentity(pub));
  const h = await sha256(msg);
  let digits = '';
  for (let i = 0; i < 13 && digits.length < 25; i++) {
    digits += ((h[i * 2] << 8) | h[i * 2 + 1]).toString().padStart(5, '0').slice(0, 5);
  }
  digits = digits.slice(0, 25);
  return digits.replace(/(\d{5})(?=\d)/g, '$1 ');
}

// --- Canonical byte encodings (sign/MAC the same bytes on both ends) ---

/** Deterministic JSON for a JWK public key (sorted keys), so both ends hash identically. */
function canonicalJwk(jwk: JsonWebKey): string {
  const { kty, crv, x, y } = jwk;
  return JSON.stringify({ kty, crv, x, y });
}

function canonicalIdentity(pub: PublicIdentity): string {
  return `${canonicalJwk(pub.ecdhPub)}|${canonicalJwk(pub.ecdsaPub)}`;
}

/** Bytes a registry entry's MAC covers. */
export function registryEntryBytes(e: {
  deviceId: string; name: string; ecdhPub: JsonWebKey; ecdsaPub: JsonWebKey; paranoid: boolean; updatedAt: number;
}): Uint8Array {
  return utf8.encode(
    `${e.deviceId}|${e.name}|${canonicalJwk(e.ecdhPub)}|${canonicalJwk(e.ecdsaPub)}|${e.paranoid ? 1 : 0}|${e.updatedAt}`,
  );
}

export { bytesToBase64 as b64encode, base64ToBytes as b64decode };
