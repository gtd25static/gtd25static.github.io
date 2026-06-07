// Test double for a WebAuthn platform authenticator with PRF support.
//
// The PRF output is DETERMINISTIC in the eval salt, so a register() and a later
// get() with the same salt reconstruct the same 32-byte secret (hence the same
// KEK) — exactly the property real biometric PRF gives us. `mode` lets a test
// simulate failure paths (no PRF support, user cancel, a different authenticator
// producing different bytes).

type Mode = 'ok' | 'no-prf' | 'cancel' | 'wrong-output';

interface GlobalWithWebAuthn {
  PublicKeyCredential?: unknown;
  navigator?: unknown;
}

let mode: Mode = 'ok';
let savedNavigator: PropertyDescriptor | undefined;
let nextRawId: ArrayBuffer | null = null;

/** Force the NEXT create() to return this base64 credential id (one-shot). */
export function setNextCredentialId(b64: string): void {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  nextRawId = bytes.buffer;
}

function saltOf(publicKey: { extensions?: AuthenticationExtensionsClientInputs } | undefined): Uint8Array {
  const first = publicKey?.extensions?.prf?.eval?.first;
  if (first instanceof Uint8Array) return first;
  if (first instanceof ArrayBuffer) return new Uint8Array(first);
  if (ArrayBuffer.isView(first)) return new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
  return new Uint8Array();
}

/** Stable 32-byte "PRF output" for a salt. `wrong` mimics a different authenticator. */
export function prfOutputFor(salt: Uint8Array, wrong = false): Uint8Array {
  const out = new Uint8Array(32);
  const tweak = wrong ? 0x55 : 0x00;
  for (let i = 0; i < 32; i++) out[i] = (salt[i % (salt.length || 1)] ^ (i * 7 + 1) ^ tweak) & 0xff;
  return out;
}

export function setWebAuthnMode(m: Mode): void { mode = m; }

export function installWebAuthnMock(): void {
  mode = 'ok';
  const g = globalThis as GlobalWithWebAuthn;
  const win = window as unknown as GlobalWithWebAuthn & { location?: { hostname: string } };

  const PKC = { isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true) };
  g.PublicKeyCredential = PKC;
  win.PublicKeyCredential = PKC;
  if (!win.location) win.location = { hostname: 'localhost' };

  const credentials = {
    create: (_options: CredentialCreationOptions) => {
      if (mode === 'cancel') return Promise.reject(new DOMException('cancelled', 'NotAllowedError'));
      const enabled = mode !== 'no-prf';
      const rawId = nextRawId ?? crypto.getRandomValues(new Uint8Array(16)).buffer;
      nextRawId = null;
      // Mimic browsers that don't return PRF results on create() — only signal
      // support, forcing the immediate get() fallback in registerPrfCredential.
      return Promise.resolve({
        rawId,
        response: {},
        getClientExtensionResults: () => ({ prf: { enabled } }),
      } as unknown as PublicKeyCredential);
    },
    get: (options: CredentialRequestOptions) => {
      if (mode === 'cancel') return Promise.reject(new DOMException('cancelled', 'NotAllowedError'));
      if (mode === 'no-prf') {
        // Authenticator returns an assertion but no PRF result -> truly unsupported.
        return Promise.resolve({ getClientExtensionResults: () => ({}) } as unknown as PublicKeyCredential);
      }
      const salt = saltOf(options.publicKey);
      const first = prfOutputFor(salt, mode === 'wrong-output').buffer;
      return Promise.resolve({
        getClientExtensionResults: () => ({ prf: { results: { first } } }),
      } as unknown as PublicKeyCredential);
    },
  };

  savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { credentials } });
}

export function uninstallWebAuthnMock(): void {
  const g = globalThis as GlobalWithWebAuthn;
  delete g.PublicKeyCredential;
  delete (window as unknown as GlobalWithWebAuthn).PublicKeyCredential;
  if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
  else Object.defineProperty(globalThis, 'navigator', { configurable: true, value: undefined });
  savedNavigator = undefined;
}
