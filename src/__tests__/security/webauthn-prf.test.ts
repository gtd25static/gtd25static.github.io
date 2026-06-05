import { vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });
import {
  isWebAuthnSupported, isPlatformAuthenticatorAvailable,
  registerPrfCredential, getPrfOutput, PrfUnsupportedError,
} from '../../sync/webauthn-prf';
import {
  installWebAuthnMock, uninstallWebAuthnMock, setWebAuthnMode, prfOutputFor,
} from '../helpers/webauthn-mock';
import { generateSalt } from '../../sync/crypto';

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

beforeEach(() => installWebAuthnMock());
afterEach(() => uninstallWebAuthnMock());

describe('webauthn-prf', () => {
  it('reports support and platform availability when present', async () => {
    expect(isWebAuthnSupported()).toBe(true);
    expect(await isPlatformAuthenticatorAvailable()).toBe(true);
  });

  it('reports unsupported when WebAuthn is absent', async () => {
    uninstallWebAuthnMock();
    expect(isWebAuthnSupported()).toBe(false);
    expect(await isPlatformAuthenticatorAvailable()).toBe(false);
  });

  it('registers a credential and returns the salt-derived PRF output', async () => {
    const salt = generateSalt();
    const reg = await registerPrfCredential(salt);
    expect(reg.credentialId).toBeTruthy();
    expect(Array.from(reg.prfOutput)).toEqual(Array.from(prfOutputFor(base64ToBytes(salt))));
  });

  it('getPrfOutput reproduces the same bytes register saw (stable KEK)', async () => {
    const salt = generateSalt();
    const reg = await registerPrfCredential(salt);
    const again = await getPrfOutput(reg.credentialId, salt);
    expect(again).not.toBeNull();
    expect(Array.from(again!)).toEqual(Array.from(reg.prfOutput));
  });

  it('throws PrfUnsupportedError when the authenticator lacks PRF support', async () => {
    setWebAuthnMode('no-prf');
    await expect(registerPrfCredential(generateSalt())).rejects.toBeInstanceOf(PrfUnsupportedError);
  });

  it('propagates a cancel as a rejection (register) and null (assertion)', async () => {
    setWebAuthnMode('cancel');
    await expect(registerPrfCredential(generateSalt())).rejects.toBeTruthy();
    expect(await getPrfOutput('Y3JlZA==', generateSalt())).toBeNull();
  });
});
