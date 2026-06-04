import { vi } from 'vitest';
vi.setConfig({ testTimeout: 20_000 });
import {
  generateDek, exportDekRaw, wrapDek, unwrapDek, importKekFromBytes,
} from '../../db/vault-crypto';
import { deriveKey, generateSalt, createVerifier, checkVerifier } from '../../sync/crypto';

describe('vault-crypto: DEK wrap/unwrap', () => {
  it('wraps with a passphrase KEK and unwraps to the same DEK', async () => {
    const dek = await generateDek();
    const salt = generateSalt();
    const kek = await deriveKey('correct horse', salt);

    const wrapped = await wrapDek(kek, dek);
    const unwrapped = await unwrapDek(kek, wrapped);

    expect(await exportDekRaw(unwrapped)).toBe(await exportDekRaw(dek));
  });

  it('fails to unwrap with the wrong passphrase', async () => {
    const dek = await generateDek();
    const salt = generateSalt();
    const wrapped = await wrapDek(await deriveKey('right', salt), dek);

    const wrongKek = await deriveKey('wrong', salt);
    await expect(unwrapDek(wrongKek, wrapped)).rejects.toBeTruthy();
  });

  it('lets two different KEKs both unwrap the SAME DEK', async () => {
    const dek = await generateDek();
    const rawDek = await exportDekRaw(dek);

    const passKek = await deriveKey('passphrase', generateSalt());
    const prfKek = await importKekFromBytes(crypto.getRandomValues(new Uint8Array(32)));

    const wrappedByPass = await wrapDek(passKek, dek);
    const wrappedByPrf = await wrapDek(prfKek, dek);

    expect(await exportDekRaw(await unwrapDek(passKek, wrappedByPass))).toBe(rawDek);
    expect(await exportDekRaw(await unwrapDek(prfKek, wrappedByPrf))).toBe(rawDek);
  });

  it('verifier round-trips with the DEK and rejects a different key', async () => {
    const dek = await generateDek();
    const other = await generateDek();
    const verifier = await createVerifier(dek);

    expect(await checkVerifier(dek, verifier)).toBe(true);
    expect(await checkVerifier(other, verifier)).toBe(false);
  });
});
