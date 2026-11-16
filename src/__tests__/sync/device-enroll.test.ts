// QR enrolment protocol (sync/device-enroll.ts): two devices — and an attacker
// who photographed the QR — against an in-memory GitHub.
vi.mock('../../sync/github-api', async () => (await import('../helpers/fake-repo')).fakeGitHubApi);

import { encode } from 'uqr';
import { fakeRepo } from '../helpers/fake-repo';
import {
  createEnrollOffer, parseEnrollQr, encodeEnrollQr, requestEnrollment, waitForEnrollRequest, sendEnrollSecret,
  receiveEnrollSecret, waitForEnrollConsumed, discardEnrollment, sweepEnrollments, enrollBranch, EnrollError,
  ENROLL_TTL_MS, type EnrollOffer,
} from '../../sync/device-enroll';

const PAT = 'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd';
const REPO = 'someone/gtd25-data';
const PASSWORD = 'correct horse battery staple';
const FILE = 'gtd25-enroll.json';
const FAST = { pollMs: 2 };

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function freshPub(): Promise<string> {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  return b64url(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
}

async function expectEnrollError(promise: Promise<unknown>, code: EnrollError['code']) {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(EnrollError);
  expect((err as EnrollError).code).toBe(code);
}

function everyStoredText(): string {
  const decoder = new TextDecoder();
  return [...fakeRepo.objects.values()]
    .map((o) => (o.kind === 'blob' ? decoder.decode(o.bytes) : ''))
    .join('\n');
}

beforeEach(() => {
  fakeRepo.reset();
  fakeRepo.writeText('gtd25-snapshot.json', '{"the":"snapshot"}');
});

describe('QR payload', () => {
  it('round-trips, and carries no password', async () => {
    const host = await createEnrollOffer(PAT, REPO);
    expect(parseEnrollQr(host.qrText)).toEqual(host.offer);
    expect(host.qrText).not.toContain(PASSWORD);
  });

  it('fits a QR code a phone reads off a screen', async () => {
    const host = await createEnrollOffer(PAT, 'a-rather-long-owner-name/a-rather-long-repository-name');
    expect(encode(host.qrText, { ecc: 'M' }).version).toBeLessThanOrEqual(15);
  });

  it('refuses anything that is not a well-formed enrolment code', async () => {
    const { offer } = await createEnrollOffer(PAT, REPO);
    const tamper = (patch: Partial<Record<keyof EnrollOffer, unknown>>) =>
      encodeEnrollQr({ ...offer, ...patch } as EnrollOffer);
    expect(parseEnrollQr('https://example.com')).toBeNull();
    expect(parseEnrollQr('gtd25-enroll:1:not json')).toBeNull();
    expect(parseEnrollQr(`gtd25-enroll:2:${JSON.stringify({})}`)).toBeNull();
    expect(parseEnrollQr(tamper({}) + ' '.repeat(1024))).toBeNull();
    // The repository ends up in API paths: nothing that could leave owner/name.
    for (const repo of ['owner/..', 'owner/.', '../x', 'owner/name/contents', 'owner', 'own er/x', 'owner/x?ref=y', 1]) {
      expect(parseEnrollQr(tamper({ repo }))).toBeNull();
    }
    // The token ends up in a header.
    for (const pat of ['ghp_short', 'ghp_abcdefghijklmnopqrstuvwxyz\r\nX-Evil: 1', 'ghp abcdefghijklmnopqrstuvwxyz']) {
      expect(parseEnrollQr(tamper({ pat }))).toBeNull();
    }
    expect(parseEnrollQr(tamper({ pid: 'short' }))).toBeNull();
    expect(parseEnrollQr(tamper({ pid: 'abc/def/ghi/jkl/mno/pq' }))).toBeNull();
    expect(parseEnrollQr(tamper({ secret: undefined }))).toBeNull();
    expect(parseEnrollQr(tamper({ secret: 'A'.repeat(42) }))).toBeNull();
    // Not an uncompressed P-256 point (0x04 prefix, 65 bytes).
    expect(parseEnrollQr(tamper({ pub: 'A' + offer.pub.slice(1) }))).toBeNull();
    expect(parseEnrollQr(tamper({ pub: offer.pub.slice(1) }))).toBeNull();
  });
});

describe('enrolment handshake', () => {
  it('delivers the password, both screens show the same code, and the default branch never sees it', async () => {
    const mainHead = fakeRepo.refs.get('main');
    const host = await createEnrollOffer(PAT, REPO);
    const scanned = parseEnrollQr(host.qrText)!;

    const join = await requestEnrollment(scanned);
    expect(fakeRepo.refs.has(enrollBranch(scanned.pid))).toBe(true);
    const request = await waitForEnrollRequest(host, FAST);
    expect(request.code).toMatch(/^\d{3} \d{3}$/);
    expect(request.code).toBe(join.code);

    await sendEnrollSecret(host, request, PASSWORD);
    const consumed = waitForEnrollConsumed(host, Date.now() + 5_000, FAST);
    expect(await receiveEnrollSecret(join, FAST)).toBe(PASSWORD);
    await consumed;

    // The exchange branch is gone and main was never written.
    expect(fakeRepo.refs.has(enrollBranch(scanned.pid))).toBe(false);
    expect(fakeRepo.refs.get('main')).toBe(mainHead);
    expect(fakeRepo.listPaths()).toEqual(['gtd25-snapshot.json']);
    // What GitHub may keep of the deleted branch holds neither the password nor
    // the QR secret that, with a private key, would open it.
    const stored = everyStoredText();
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain(scanned.secret);
    expect(stored).not.toContain(PAT);
  });

  it('a QR read with a different secret yields another code and cannot open the answer', async () => {
    const host = await createEnrollOffer(PAT, REPO);
    const altered = { ...host.offer, secret: b64url(crypto.getRandomValues(new Uint8Array(32))) };
    const join = await requestEnrollment(altered);
    const request = await waitForEnrollRequest(host, FAST);
    expect(request.code).not.toBe(join.code);
    await sendEnrollSecret(host, request, PASSWORD);
    await expectEnrollError(receiveEnrollSecret(join, FAST), 'tampered');
  });

  it('someone who photographed the QR and answers first locks the real device out, and gets a code that is not its', async () => {
    const host = await createEnrollOffer(PAT, REPO);
    const attacker = await requestEnrollment(parseEnrollQr(host.qrText)!);
    await expectEnrollError(requestEnrollment(parseEnrollQr(host.qrText)!), 'used');
    // The code the old device shows is the attacker's: the real device shows no
    // code at all, so the user has nothing that matches and does not send.
    expect((await waitForEnrollRequest(host, FAST)).code).toBe(attacker.code);
  });

  it('a request replaced in the repository shows a different code, and the real device stops', async () => {
    const host = await createEnrollOffer(PAT, REPO);
    const join = await requestEnrollment(host.offer);
    const branch = enrollBranch(host.offer.pid);
    fakeRepo.writeText(FILE, JSON.stringify({ k: await freshPub() }), branch);

    const request = await waitForEnrollRequest(host, FAST);
    expect(request.code).not.toBe(join.code);
    await expectEnrollError(receiveEnrollSecret(join, FAST), 'tampered');
  });

  it('nothing is sent when the request changes after its code was shown', async () => {
    const host = await createEnrollOffer(PAT, REPO);
    await requestEnrollment(host.offer);
    const request = await waitForEnrollRequest(host, FAST);
    fakeRepo.writeText(FILE, JSON.stringify({ k: await freshPub() }), enrollBranch(host.offer.pid));

    await expectEnrollError(sendEnrollSecret(host, request, PASSWORD), 'tampered');
    expect(everyStoredText()).not.toContain('"ct"');
  });

  it('the old device refuses an exchange file that is not a fresh request', async () => {
    const host = await createEnrollOffer(PAT, REPO);
    const branch = enrollBranch(host.offer.pid);
    fakeRepo.refs.set(branch, fakeRepo.refs.get('main')!);
    fakeRepo.writeText(FILE, '{"k":"not a key"}', branch);
    await expectEnrollError(waitForEnrollRequest(host, FAST), 'tampered');
  });

  it('the exchange branch is one orphan commit holding only the request: it keeps no history reachable', async () => {
    const host = await createEnrollOffer(PAT, REPO);
    await requestEnrollment(host.offer);
    const head = fakeRepo.objects.get(fakeRepo.refs.get(enrollBranch(host.offer.pid))!);
    expect(head?.kind === 'commit' && head.parents).toEqual([]);
    expect(fakeRepo.listPaths(enrollBranch(host.offer.pid))).toEqual([FILE]);
  });

  it('two devices racing on one code: one gets it, the other is told it was used', async () => {
    const host = await createEnrollOffer(PAT, REPO);
    const results = await Promise.allSettled([requestEnrollment(host.offer), requestEnrollment(host.offer)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(EnrollError);
    expect((rejected.reason as EnrollError).code).toBe('used');
  });

  it('a request whose key is not on the curve is refused as tampered, not waited out', async () => {
    const host = await createEnrollOffer(PAT, REPO);
    const branch = enrollBranch(host.offer.pid);
    fakeRepo.refs.set(branch, fakeRepo.refs.get('main')!);
    const offCurve = b64url(new Uint8Array([0x04, ...new Array(64).fill(0xff)]));
    fakeRepo.writeText(FILE, JSON.stringify({ k: offCurve }), branch);
    await expectEnrollError(waitForEnrollRequest(host, FAST), 'tampered');
  });

  it('an answer to an exchange the new device already withdrew goes nowhere', async () => {
    const host = await createEnrollOffer(PAT, REPO);
    await requestEnrollment(host.offer);
    const request = await waitForEnrollRequest(host, FAST);
    await discardEnrollment(host.offer);
    await expect(sendEnrollSecret(host, request, PASSWORD)).rejects.toThrow();
    expect(fakeRepo.refs.has(enrollBranch(host.offer.pid))).toBe(false);
  });

  it('a new code sweeps exchange branches left behind, and nothing else', async () => {
    const left = await createEnrollOffer(PAT, REPO);
    await requestEnrollment(left.offer); // its devices closed without cleaning up
    fakeRepo.writeText('blob.bin', 'x', 'gtd25-blobs');
    const current = await createEnrollOffer(PAT, REPO);
    await requestEnrollment(current.offer);

    await sweepEnrollments(PAT, REPO, current.offer.pid);
    expect([...fakeRepo.refs.keys()].sort()).toEqual(['gtd25-blobs', enrollBranch(current.offer.pid), 'main'].sort());
  });

  it('a code nobody answers expires', async () => {
    const host = await createEnrollOffer(PAT, REPO, Date.now() - ENROLL_TTL_MS);
    await expectEnrollError(waitForEnrollRequest(host, FAST), 'expired');
  });

  it('the new device hears that the old one cancelled', async () => {
    const host = await createEnrollOffer(PAT, REPO);
    const join = await requestEnrollment(host.offer);
    const receiving = receiveEnrollSecret(join, { pollMs: 5 });
    setTimeout(() => void discardEnrollment(host.offer), 30);
    await expectEnrollError(receiving, 'cancelled');
  });

  it('the polling stops when the dialog closes', async () => {
    const host = await createEnrollOffer(PAT, REPO);
    const ac = new AbortController();
    const waiting = waitForEnrollRequest(host, { signal: ac.signal, pollMs: 5 });
    ac.abort();
    await expect(waiting).rejects.toBeDefined();
  });
});
