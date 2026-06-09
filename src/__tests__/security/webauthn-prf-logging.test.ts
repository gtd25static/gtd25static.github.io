// @vitest-environment jsdom
//
// ACR-003 regression: security-key enrollment must never write PRF output (the raw
// bytes used as the vault KEK) or the PRF salt to the console, where devtools/console
// capture could harvest it.
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { registerPrfCredential } from '../../sync/webauthn-prf';

const PRF_SECRET = new Uint8Array(32).fill(0xab); // distinctive KEK material
const PRF_SALT = new Uint8Array(32).fill(0x07);

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
const SECRET_B64 = toB64(PRF_SECRET);
const SALT_B64 = toB64(PRF_SALT);

// Serialize a console argument to a string that surfaces any embedded binary as
// base64, so a leaked ArrayBuffer/typed array (e.g. logging the whole `ext.prf`)
// would show up as the secret's base64.
function serializeArg(a: unknown): string {
  if (a instanceof ArrayBuffer) return toB64(new Uint8Array(a));
  if (ArrayBuffer.isView(a)) return toB64(new Uint8Array((a as ArrayBufferView).buffer));
  if (a && typeof a === 'object') {
    try {
      return JSON.stringify(a, (_k, v) => {
        if (v instanceof ArrayBuffer) return toB64(new Uint8Array(v));
        if (ArrayBuffer.isView(v)) return toB64(new Uint8Array((v as ArrayBufferView).buffer));
        return v;
      });
    } catch { return String(a); }
  }
  return String(a);
}

let logged: string[];

beforeEach(() => {
  logged = [];
  for (const m of ['log', 'info', 'debug', 'warn', 'error'] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(serializeArg).join(' '));
    });
  }
  (window as unknown as { PublicKeyCredential: unknown }).PublicKeyCredential = function () {};
  const cred = {
    rawId: new Uint8Array([1, 2, 3, 4]).buffer,
    // PRF output already present at creation -> no second assertion prompt needed.
    getClientExtensionResults: () => ({ prf: { enabled: true, results: { first: PRF_SECRET.buffer.slice(0) } } }),
    response: { getTransports: () => ['usb'] },
  };
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    value: { create: vi.fn().mockResolvedValue(cred) },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { PublicKeyCredential?: unknown }).PublicKeyCredential;
});

describe('webauthn-prf enrollment logging (ACR-003)', () => {
  it('returns the PRF output but never logs the secret bytes or salt', async () => {
    const reg = await registerPrfCredential(SALT_B64);
    expect(reg.prfOutput).toEqual(PRF_SECRET); // sanity: we really handled the secret

    const all = logged.join('\n');
    expect(all).not.toContain(SECRET_B64);
    expect(all).not.toContain(SALT_B64);
  });
});
