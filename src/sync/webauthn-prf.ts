// WebAuthn PRF-based unlock for Paranoid Mode.
//
// The platform authenticator (Windows Hello / Touch ID) derives a stable
// 32-byte secret from a fixed salt via the PRF extension. That secret becomes
// the key-encryption key (KEK) that wraps the vault DEK — so a biometric touch
// reconstructs the KEK and unwraps the DEK, with no passphrase typed.
//
// No biometric data ever leaves the authenticator; the browser only sees the
// derived PRF bytes. This module is pure WebAuthn plumbing: it knows nothing
// about the vault. It returns raw bytes / credential ids and lets vault.ts wire
// them to the DEK. Every entry point degrades gracefully (returns null) when
// WebAuthn/PRF is unavailable or the user cancels — the caller falls back to the
// passphrase.

const RP_NAME = 'GTD25';

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** True when the browser exposes the WebAuthn API at all. */
export function isWebAuthnSupported(): boolean {
  return typeof window !== 'undefined'
    && typeof window.PublicKeyCredential !== 'undefined'
    && !!navigator.credentials;
}

/** True when a platform (built-in biometric) authenticator is present. */
export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  if (!isWebAuthnSupported()) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export interface PrfRegistration {
  credentialId: string;  // base64 rawId, stored for allowCredentials on unlock
  prfOutput: Uint8Array; // 32-byte secret used to derive the KEK
}

/**
 * Enroll a platform credential and obtain its PRF output for `prfSalt`.
 * Returns null when WebAuthn/PRF is unsupported or the user cancels.
 */
export async function registerPrfCredential(prfSalt: string): Promise<PrfRegistration | null> {
  if (!isWebAuthnSupported()) return null;
  const saltBytes = base64ToBytes(prfSalt);

  try {
    const cred = (await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: RP_NAME, id: window.location.hostname },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: 'gtd25-vault',
          displayName: 'GTD25 Vault',
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },   // ES256
          { type: 'public-key', alg: -257 }, // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'preferred',
        },
        timeout: 60_000,
        extensions: { prf: { eval: { first: saltBytes as BufferSource } } },
      },
    })) as PublicKeyCredential | null;
    if (!cred) return null;

    const ext = cred.getClientExtensionResults();
    if (!ext.prf?.enabled) return null; // authenticator lacks PRF support

    const credentialId = bytesToBase64(new Uint8Array(cred.rawId));

    // The PRF output is frequently NOT returned on create() — per spec it may
    // only surface on a subsequent assertion. Fetch it via an immediate get().
    const onCreate = ext.prf.results?.first;
    const prfOutput = onCreate
      ? new Uint8Array(onCreate)
      : await getPrfOutput(credentialId, prfSalt);
    if (!prfOutput) return null;

    return { credentialId, prfOutput };
  } catch {
    return null; // user cancelled / not allowed / policy-blocked
  }
}

/**
 * Run an assertion against `credentialId` to obtain the PRF output for
 * `prfSalt`. Returns null on cancel/error so the caller can fall back.
 */
export async function getPrfOutput(credentialId: string, prfSalt: string): Promise<Uint8Array | null> {
  if (!isWebAuthnSupported()) return null;
  const saltBytes = base64ToBytes(prfSalt);

  try {
    const assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: 'public-key', id: base64ToBytes(credentialId) as BufferSource }],
        userVerification: 'required',
        timeout: 60_000,
        extensions: { prf: { eval: { first: saltBytes as BufferSource } } },
      },
    })) as PublicKeyCredential | null;
    if (!assertion) return null;

    const first = assertion.getClientExtensionResults().prf?.results?.first;
    return first ? new Uint8Array(first) : null;
  } catch {
    return null;
  }
}
