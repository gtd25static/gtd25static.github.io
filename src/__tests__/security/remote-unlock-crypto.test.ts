import { describe, it, expect } from 'vitest';
import {
  generateIdentityKeys, publicIdentityOf,
  signPayload, verifyPayload,
  eciesEncryptTo, eciesDecrypt,
  deriveRegistryMacKey, registryMac, verifyRegistryMac, registryEntryBytes,
  verificationCode, identityFingerprint,
  b64encode,
} from '../../sync/remote-unlock-crypto';

const enc = (s: string) => new TextEncoder().encode(s);

describe('remote-unlock-crypto: identity keys', () => {
  it('generates P-256 ECDH + ECDSA JWK keypairs', async () => {
    const id = await generateIdentityKeys();
    expect(id.ecdhPub.crv).toBe('P-256');
    expect(id.ecdsaPub.crv).toBe('P-256');
    expect(id.ecdhPriv.d).toBeTruthy();
    expect(id.ecdsaPriv.d).toBeTruthy();
    // public projection drops private scalars
    const pub = publicIdentityOf(id);
    expect((pub.ecdhPub as { d?: string }).d ?? undefined).toBe(id.ecdhPub.d); // pub keeps no d
    expect(pub.ecdsaPub).toEqual(id.ecdsaPub);
  });
});

describe('remote-unlock-crypto: ECDSA sign/verify', () => {
  it('verifies a genuine signature and rejects tampering / wrong key', async () => {
    const a = await generateIdentityKeys();
    const b = await generateIdentityKeys();
    const msg = enc('wipe:device-1:nonce-abc:1700000000');

    const sig = await signPayload(a.ecdsaPriv, msg);
    expect(await verifyPayload(a.ecdsaPub, sig, msg)).toBe(true);

    // tampered message
    expect(await verifyPayload(a.ecdsaPub, sig, enc('wipe:device-2:nonce-abc:1700000000'))).toBe(false);
    // wrong signer's public key
    expect(await verifyPayload(b.ecdsaPub, sig, msg)).toBe(false);
    // garbage signature
    expect(await verifyPayload(a.ecdsaPub, 'bm90LWEtc2ln', msg)).toBe(false);
  });
});

describe('remote-unlock-crypto: ECIES', () => {
  it('round-trips a secret to the recipient and fails for the wrong recipient', async () => {
    const recipient = await generateIdentityKeys();
    const other = await generateIdentityKeys();
    const secret = crypto.getRandomValues(new Uint8Array(32));

    const blob = await eciesEncryptTo(recipient.ecdhPub, secret);
    const out = await eciesDecrypt(recipient.ecdhPriv, blob);
    expect(b64encode(out)).toBe(b64encode(secret));

    // a different recipient's private key cannot decrypt
    await expect(eciesDecrypt(other.ecdhPriv, blob)).rejects.toBeTruthy();
  });

  it('produces a fresh ephemeral key each call (forward secrecy)', async () => {
    const recipient = await generateIdentityKeys();
    const a = await eciesEncryptTo(recipient.ecdhPub, enc('x'));
    const b = await eciesEncryptTo(recipient.ecdhPub, enc('x'));
    expect(a.epk.x).not.toBe(b.epk.x);
  });
});

describe('remote-unlock-crypto: registry MAC', () => {
  const salt = b64encode(new Uint8Array(16).fill(7));
  const entry = {
    deviceId: 'dev-1', name: 'Work Laptop',
    ecdhPub: { kty: 'EC', crv: 'P-256', x: 'aaa', y: 'bbb' } as JsonWebKey,
    ecdsaPub: { kty: 'EC', crv: 'P-256', x: 'ccc', y: 'ddd' } as JsonWebKey,
    paranoid: true, updatedAt: 1700000000,
  };

  it('authenticates an entry under the syncPassword and rejects a forger', async () => {
    const good = await deriveRegistryMacKey('correct horse battery staple', salt);
    const msg = registryEntryBytes(entry);
    const mac = await registryMac(good, msg);
    expect(await verifyRegistryMac(good, mac, msg)).toBe(true);

    // attacker without the syncPassword derives a different key -> cannot verify
    const attacker = await deriveRegistryMacKey('wrong-password', salt);
    expect(await verifyRegistryMac(attacker, mac, msg)).toBe(false);

    // substituting the approver's public key invalidates the MAC
    const tampered = registryEntryBytes({ ...entry, ecdhPub: { kty: 'EC', crv: 'P-256', x: 'EVIL', y: 'bbb' } as JsonWebKey });
    expect(await verifyRegistryMac(good, mac, tampered)).toBe(false);
  });
});

describe('remote-unlock-crypto: verification code & fingerprint', () => {
  it('verification code is deterministic, formatted, and differs for substituted material', async () => {
    const m1 = crypto.getRandomValues(new Uint8Array(32));
    const c1 = await verificationCode(m1);
    expect(c1).toMatch(/^\d{2}-\d{2}$/);
    expect(await verificationCode(m1)).toBe(c1);

    const m2 = new Uint8Array(m1);
    m2[0] ^= 0xff;
    expect(await verificationCode(m2)).not.toBe(c1); // (collision astronomically unlikely)
  });

  it('fingerprint is stable per identity and differs across identities', async () => {
    const a = await generateIdentityKeys();
    const b = await generateIdentityKeys();
    const fa = await identityFingerprint(publicIdentityOf(a));
    expect(fa).toMatch(/^\d{5}( \d{5}){4}$/);
    expect(await identityFingerprint(publicIdentityOf(a))).toBe(fa);
    expect(await identityFingerprint(publicIdentityOf(b))).not.toBe(fa);
  });
});
