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

// The PRF result arrives as a BufferSource (ArrayBuffer or a view). Normalize to
// a Uint8Array regardless of which the authenticator/runtime hands back.
function toBytes(src: BufferSource): Uint8Array {
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  return new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
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
  transports?: AuthenticatorTransport[]; // e.g. 'usb' | 'nfc' | 'hybrid' (phone)
}

/** Thrown when the authenticator created a credential but does not support PRF. */
export class PrfUnsupportedError extends Error {
  constructor(message = 'This security key does not support the PRF (hmac-secret) extension required for unlock. Use a FIDO2 key that supports it (e.g. a recent YubiKey), or use your passphrase.') {
    super(message);
    this.name = 'PrfUnsupportedError';
  }
}

/**
 * Enroll a platform credential and obtain its PRF output for `prfSalt`.
 *
 * Throws (rather than returning null) so the caller can show the user *why* it
 * failed: a cancelled prompt (DOMException 'NotAllowedError'), an authenticator
 * without PRF support (PrfUnsupportedError — e.g. some synced passkeys), or an
 * empty PRF result. The DOMException / extension results are also logged.
 */
export async function registerPrfCredential(
  prfSalt: string,
  attachment: AuthenticatorAttachment = 'cross-platform',
): Promise<PrfRegistration> {
  if (!isWebAuthnSupported()) {
    throw new PrfUnsupportedError('WebAuthn is not available in this browser');
  }
  const saltBytes = base64ToBytes(prfSalt);

  let cred: PublicKeyCredential | null;
  try {
    cred = (await navigator.credentials.create({
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
          // 'cross-platform' => an external FIDO2 security key (YubiKey etc.),
          // which exposes hmac-secret/PRF reliably (unlike the macOS platform
          // authenticator). Device-bound, non-discoverable; we always unlock with
          // an explicit allowCredentials list.
          authenticatorAttachment: attachment,
          userVerification: 'required',
          residentKey: 'discouraged',
        },
        timeout: 60_000,
        extensions: { prf: { eval: { first: saltBytes as BufferSource } } },
      },
    })) as PublicKeyCredential | null;
  } catch (err) {
    console.warn('[paranoid] passkey creation failed:', err);
    throw err; // typically NotAllowedError (user cancelled / timed out)
  }
  if (!cred) throw new Error('No credential was created');

  const ext = cred.getClientExtensionResults();
  console.info('[paranoid] passkey created; prf extension result:', ext.prf);

  const credentialId = bytesToBase64(new Uint8Array(cred.rawId));
  // Transports help the browser route the unlock prompt (e.g. 'hybrid' => offer
  // "use a phone"). Not all authenticators/runtimes expose them; degrade to none.
  let transports: AuthenticatorTransport[] | undefined;
  try {
    const resp = cred.response as AuthenticatorAttestationResponse;
    transports = resp.getTransports?.() as AuthenticatorTransport[] | undefined;
  } catch { /* getTransports unavailable */ }

  // If the PRF output came back at creation, use it (no second prompt).
  const onCreate = ext.prf?.results?.first;
  if (onCreate) return { credentialId, prfOutput: toBytes(onCreate), transports };

  // Otherwise obtain it via an assertion. We deliberately DO NOT gate on
  // ext.prf.enabled: macOS/Chrome platform authenticators provision PRF but
  // report enabled=false/undefined at creation, only returning the result on the
  // assertion. The assertion result is the authoritative capability signal —
  // gating on the creation-time `enabled` produces a false "unsupported".
  let prfOutput: Uint8Array | null;
  try {
    prfOutput = await requestPrfAssertion([credentialId], prfSalt);
  } catch (err) {
    console.warn('[paranoid] PRF assertion during enrollment failed:', err);
    throw err; // cancelled / not allowed -> surfaced distinctly from "unsupported"
  }
  if (!prfOutput) throw new PrfUnsupportedError();
  return { credentialId, prfOutput, transports };
}

// Core assertion: prompts the authenticator, allowing ANY of `credentialIds`
// (so the user can unlock with whichever enrolled key is present), and returns
// the responding key's PRF output (or null if no PRF result). Throws on WebAuthn
// errors (cancel / not-allowed) so callers can distinguish "unsupported" from
// "cancelled". `transports` (optional, parallel to credentialIds) hints routing.
async function requestPrfAssertion(
  credentialIds: string[],
  prfSalt: string,
  transports?: (AuthenticatorTransport[] | undefined)[],
): Promise<Uint8Array | null> {
  const saltBytes = base64ToBytes(prfSalt);
  const allowCredentials: PublicKeyCredentialDescriptor[] = credentialIds.map((id, i) => ({
    type: 'public-key',
    id: base64ToBytes(id) as BufferSource,
    ...(transports?.[i]?.length ? { transports: transports[i] } : {}),
  }));
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials,
      userVerification: 'required',
      timeout: 60_000,
      extensions: { prf: { eval: { first: saltBytes as BufferSource } } },
    },
  })) as PublicKeyCredential | null;
  const first = assertion?.getClientExtensionResults().prf?.results?.first;
  return first ? toBytes(first) : null;
}

/**
 * Run an assertion allowing any of `credentialIds` to obtain the PRF output for
 * `prfSalt`. Accepts a single id (back-compat) or a list of enrolled keys.
 * Returns null on cancel/error so the unlock path can fall back to the passphrase.
 */
export async function getPrfOutput(
  credentialIds: string | string[],
  prfSalt: string,
  transports?: (AuthenticatorTransport[] | undefined)[],
): Promise<Uint8Array | null> {
  if (!isWebAuthnSupported()) return null;
  const ids = Array.isArray(credentialIds) ? credentialIds : [credentialIds];
  if (ids.length === 0) return null;
  try {
    return await requestPrfAssertion(ids, prfSalt, transports);
  } catch (err) {
    console.warn('[paranoid] biometric assertion failed:', err);
    return null;
  }
}
