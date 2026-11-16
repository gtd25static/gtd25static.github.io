// Enrol a new device with a QR code (non-Paranoid devices only).
//
// The QR a syncing device shows carries the repository, the PAT, a one-time
// P-256 public key and a one-time 256-bit secret — never the sync password:
// whoever photographs the screen would otherwise hold every key to the data
// until the token is revoked AND the password rotated. The password travels
// afterwards through the repository, end-to-end encrypted, once the user has
// confirmed on the old device that both screens show the same 6-digit code:
//
//   old device (A)                            new device (B)
//   shows QR: repo, PAT, pid, pubA, secret ─► scans it
//                                             creates branch gtd25-enroll-<pid>: one
//                                               orphan commit, gtd25-enroll.json {k: pubB}
//   reads pubB, shows the code                shows the code
//   [codes match] → writes {k, iv, ct}        reads it, decrypts the password,
//     (the password, AES-GCM)                   deletes the branch, joins + pulls
//
// Who can learn what:
// - The code and the AES key come from HKDF(ECDH secret ‖ QR secret). Someone
//   with the QR (repo, PAT, pubA, secret) who posts their own key cannot predict
//   the code B shows (that needs a or b), so A shows a code that does not match.
// - The exchange never touches the default branch: it lives on its own branch —
//   an orphan commit holding only the exchange file, so a branch left behind
//   (a closed tab) keeps nothing else reachable, such as the history a password
//   change squashed away — deleted at the end or on cancel, and any left over
//   swept by the next "Add a device". GitHub still keeps the unreferenced commits
//   until its own garbage collection (no API forces it), findable by a token
//   holder through the events API meanwhile — so what is left must be useless:
//   opening it needs the QR secret, which never reaches the repository, AND one
//   of the ephemeral private keys, which are non-extractable and die with the
//   page. Even a later break of P-256 does not open it without the QR picture.
// - The QR still gives away the PAT: read/write access to ciphertext — the same
//   as the setup codes the sync design allows (see THREAT_MODEL.md).

import {
  getFile, putFile, getRef, createRef, deleteRef, listBranches, createBlobBase64, createTree, createCommit,
} from './github-api';

const QR_PREFIX = 'gtd25-enroll:1:';
/** The exchange file, on the exchange branch. */
const ENROLL_FILE = 'gtd25-enroll.json';
/** How long a QR stays valid, and how long either side waits for the other. */
export const ENROLL_TTL_MS = 5 * 60_000;
export const ENROLL_POLL_MS = 2_500;

export function enrollBranch(pid: string): string {
  return `gtd25-enroll-${pid}`;
}

/** What the QR carries. Everything in it is untrusted on the scanning side. */
export interface EnrollOffer {
  repo: string;
  pat: string;
  /** One-time pairing id (16 random bytes, base64url) — names the exchange branch. */
  pid: string;
  /** A's ephemeral ECDH public key, raw uncompressed point, base64url. */
  pub: string;
  /** 32 random bytes, base64url, mixed into the key: never written to the repository. */
  secret: string;
}

export type EnrollErrorCode =
  | 'expired' // nobody answered in time
  | 'used' // the code was already answered (someone else may have scanned it)
  | 'tampered' // the exchange changed or does not open (someone else may hold the code)
  | 'cancelled'; // the other device gave up

export class EnrollError extends Error {
  code: EnrollErrorCode;
  constructor(code: EnrollErrorCode, message: string) {
    super(message);
    this.name = 'EnrollError';
    this.code = code;
  }
}

// --- encoding ---

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text: string): Uint8Array {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const utf8 = new TextEncoder();

// The repository goes into API paths and the token into a header: both are
// held to GitHub's own alphabets, so a crafted QR can't point the requests
// anywhere else (no "..", no slashes beyond owner/name, no header injection).
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
const PAT_RE = /^[A-Za-z0-9_]{20,255}$/;
const PID_RE = /^[A-Za-z0-9_-]{22}$/; // 16 bytes
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes
const PUB_RE = /^[A-Za-z0-9_-]{87}$/; // 65 bytes

function isRawP256Point(pub: string): boolean {
  if (!PUB_RE.test(pub)) return false;
  const bytes = fromB64url(pub);
  return bytes.length === 65 && bytes[0] === 0x04;
}

export function encodeEnrollQr(offer: EnrollOffer): string {
  return QR_PREFIX + JSON.stringify({ r: offer.repo, t: offer.pat, i: offer.pid, k: offer.pub, s: offer.secret });
}

/** The offer in a scanned QR, or null when it is not a valid enrolment code. */
export function parseEnrollQr(text: string): EnrollOffer | null {
  if (typeof text !== 'string' || !text.startsWith(QR_PREFIX) || text.length > 1024) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(QR_PREFIX.length));
  } catch {
    return null;
  }
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  const { r, t, i, k, s } = o;
  if (typeof r !== 'string' || !REPO_RE.test(r)) return null;
  if (typeof t !== 'string' || !PAT_RE.test(t)) return null;
  if (typeof i !== 'string' || !PID_RE.test(i)) return null;
  if (typeof k !== 'string' || !isRawP256Point(k)) return null;
  if (typeof s !== 'string' || !SECRET_RE.test(s)) return null;
  return { repo: r, pat: t, pid: i, pub: k, secret: s };
}

// --- crypto ---

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;

async function generateKeyPair(): Promise<CryptoKeyPair> {
  // The private key is not extractable: it lives in this page's memory only.
  return crypto.subtle.generateKey(ECDH, false, ['deriveBits']) as Promise<CryptoKeyPair>;
}

async function exportPub(key: CryptoKey): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.exportKey('raw', key)));
}

interface Session {
  aesKey: CryptoKey;
  /** The 6 digits both screens show, as "123 456". */
  code: string;
}

/**
 * Both sides' shared session: HKDF over the ECDH secret and the QR secret,
 * bound to the pairing id and both public keys. 32 bytes make the AES-GCM key,
 * 4 more the code.
 */
async function deriveSession(priv: CryptoKey, peerPub: string, offer: EnrollOffer, pubB: string): Promise<Session> {
  const peer = await crypto.subtle.importKey('raw', fromB64url(peerPub) as BufferSource, ECDH, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, priv, 256));
  const ikm = new Uint8Array([...shared, ...fromB64url(offer.secret)]);
  const hkdf = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    {
      name: 'HKDF', hash: 'SHA-256', salt: utf8.encode(offer.pid) as BufferSource,
      info: utf8.encode(`gtd25-enroll-v1|${offer.pub}|${pubB}`) as BufferSource,
    },
    hkdf,
    36 * 8,
  ));
  const aesKey = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const n = new DataView(bits.buffer, 32, 4).getUint32(0) % 1_000_000;
  const digits = n.toString().padStart(6, '0');
  return { aesKey, code: `${digits.slice(0, 3)} ${digits.slice(3)}` };
}

function aad(pid: string): BufferSource {
  return utf8.encode(`gtd25-enroll-v1|${pid}`) as BufferSource;
}

// --- the exchange file ---

/** B's request: {k}. A's answer adds {iv, ct}. Anything else is not ours. */
interface EnrollFile { k: string; iv?: string; ct?: string }

function parseEnrollFile(text: string): EnrollFile | null {
  try {
    const o = JSON.parse(text) as Record<string, unknown> | null;
    if (!o || typeof o !== 'object' || typeof o.k !== 'string' || !isRawP256Point(o.k)) return null;
    if (o.iv === undefined && o.ct === undefined) return { k: o.k };
    if (typeof o.iv !== 'string' || typeof o.ct !== 'string' || o.iv.length > 64 || o.ct.length > 4096) return null;
    return { k: o.k, iv: o.iv, ct: o.ct };
  } catch {
    return null;
  }
}

/** The exchange file as it stands, or null while its branch (or the file) does not exist. */
function readEnrollFile(offer: EnrollOffer, signal?: AbortSignal) {
  return getFile(offer.pat, offer.repo, ENROLL_FILE, signal, enrollBranch(offer.pid));
}

// --- polling ---

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Ask `probe` every pollMs until it returns a value or the deadline passes. A
 * failed request (offline for a moment, a 5xx) is retried at the next tick;
 * an EnrollError from the probe ends the wait.
 */
async function pollUntil<T>(
  probe: () => Promise<T | null>,
  deadline: number,
  opts: { signal?: AbortSignal; pollMs?: number },
): Promise<T> {
  for (;;) {
    opts.signal?.throwIfAborted();
    try {
      const value = await probe();
      if (value !== null) return value;
    } catch (err) {
      if (err instanceof EnrollError) throw err;
    }
    if (Date.now() >= deadline) throw new EnrollError('expired', 'The code expired before the other device answered.');
    await sleep(opts.pollMs ?? ENROLL_POLL_MS, opts.signal);
  }
}

/** Delete the exchange branch. Best effort: nothing on it opens without the QR and the discarded keys. */
export async function discardEnrollment(offer: EnrollOffer): Promise<void> {
  try {
    await deleteRef(offer.pat, offer.repo, enrollBranch(offer.pid));
  } catch { /* left behind until the next sweep (sweepEnrollments) */ }
}

/**
 * Delete every exchange branch but the current one: those a closed tab or a
 * lost connection left behind. An exchange two other devices are running at
 * this very moment would be cancelled too — rare, and they can start again.
 * Best effort.
 */
export async function sweepEnrollments(pat: string, repo: string, keepPid: string): Promise<void> {
  try {
    const stale = (await listBranches(pat, repo, enrollBranch(''))).filter((b) => b !== enrollBranch(keepPid));
    await Promise.all(stale.map((branch) => deleteRef(pat, repo, branch).catch(() => undefined)));
  } catch { /* the next sweep */ }
}

// --- old device (A): offer, wait, send ---

export interface EnrollHost {
  offer: EnrollOffer;
  qrText: string;
  expiresAt: number;
  privateKey: CryptoKey;
}

export async function createEnrollOffer(pat: string, repo: string, now = Date.now()): Promise<EnrollHost> {
  const keys = await generateKeyPair();
  const offer: EnrollOffer = {
    repo,
    pat,
    pid: b64url(crypto.getRandomValues(new Uint8Array(16))),
    pub: await exportPub(keys.publicKey),
    secret: b64url(crypto.getRandomValues(new Uint8Array(32))),
  };
  return { offer, qrText: encodeEnrollQr(offer), expiresAt: now + ENROLL_TTL_MS, privateKey: keys.privateKey };
}

export interface EnrollRequest {
  /** The code to compare with the new device's screen. */
  code: string;
  /** The request exactly as read: the answer is written over THIS version only. */
  sha: string;
  peerPub: string;
  aesKey: CryptoKey;
}

/** Wait for the new device's request (until the QR expires). */
export async function waitForEnrollRequest(
  host: EnrollHost,
  opts: { signal?: AbortSignal; pollMs?: number } = {},
): Promise<EnrollRequest> {
  return pollUntil(async () => {
    const file = await readEnrollFile(host.offer, opts.signal);
    if (!file) return null;
    const request = parseEnrollFile(file.data);
    // Answered already, or not a request at all: not from the device we wait for.
    if (!request || request.ct) throw new EnrollError('tampered', 'Someone else answered this code.');
    // A well-formed key that is not on the curve is refused by WebCrypto: tampered, not "try again".
    const session = await deriveSession(host.privateKey, request.k, host.offer, request.k).catch(() => {
      throw new EnrollError('tampered', 'Someone else answered this code.');
    });
    return { code: session.code, sha: file.sha, peerPub: request.k, aesKey: session.aesKey };
  }, host.expiresAt, opts);
}

/**
 * The user confirmed the codes match: send the sync password, encrypted to the
 * request we showed the code for. Written against that request's sha, so a
 * request swapped after the code was shown is refused, not answered.
 */
export async function sendEnrollSecret(host: EnrollHost, request: EnrollRequest, syncPassword: string): Promise<void> {
  const { repo, pat, pid } = host.offer;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(pid) }, request.aesKey, utf8.encode(JSON.stringify({ p: syncPassword })) as BufferSource,
  ));
  const answer: EnrollFile = { k: request.peerPub, iv: b64url(iv), ct: b64url(ct) };
  try {
    await putFile(pat, repo, ENROLL_FILE, JSON.stringify(answer), request.sha, undefined, { branch: enrollBranch(pid) });
  } catch (err) {
    if (err instanceof Error && err.message === 'CONFLICT') {
      throw new EnrollError('tampered', 'The request changed after the code was shown. Nothing was sent.');
    }
    throw err;
  }
}

/** After sending: resolves once the new device has taken the answer (it deletes the branch). */
export async function waitForEnrollConsumed(
  host: EnrollHost,
  deadline: number,
  opts: { signal?: AbortSignal; pollMs?: number } = {},
): Promise<void> {
  await pollUntil(async () => ((await readEnrollFile(host.offer, opts.signal)) ? null : true), deadline, opts);
}

// --- new device (B): request, wait, receive ---

export interface EnrollJoin {
  offer: EnrollOffer;
  /** The code to show; the user compares it with the old device's. */
  code: string;
  myPub: string;
  aesKey: CryptoKey;
}

/** Open the exchange for the scanned offer. Refuses an offer someone already answered. */
export async function requestEnrollment(offer: EnrollOffer, signal?: AbortSignal): Promise<EnrollJoin> {
  const { repo, pat, pid } = offer;
  const branch = enrollBranch(pid);
  const used = () => new EnrollError('used', 'This code was already used.');
  // Checked first, and again by GitHub: creating a branch that exists is refused.
  if (await getRef(pat, repo, branch, signal)) throw used();
  const keys = await generateKeyPair();
  const myPub = await exportPub(keys.publicKey);
  const session = await deriveSession(keys.privateKey, offer.pub, offer, myPub);
  // The branch and its file appear at once: an orphan commit holding only the request.
  const blob = await createBlobBase64(pat, repo, btoa(JSON.stringify({ k: myPub })), signal);
  const tree = await createTree(pat, repo, [{ path: ENROLL_FILE, mode: '100644', type: 'blob', sha: blob }], signal);
  const commit = await createCommit(pat, repo, { message: 'gtd25 enroll', tree, parents: [] }, signal);
  try {
    await createRef(pat, repo, branch, commit, signal);
  } catch (err) {
    // Someone created it meanwhile; any other refusal (a ruleset, an outage) is not a leak.
    if (await getRef(pat, repo, branch, signal).catch(() => null)) throw used();
    throw err;
  }
  return { offer, code: session.code, myPub, aesKey: session.aesKey };
}

/** Wait for the old device's answer and open it: the sync password. Deletes the exchange branch. */
export async function receiveEnrollSecret(
  join: EnrollJoin,
  opts: { signal?: AbortSignal; pollMs?: number; deadline?: number } = {},
): Promise<string> {
  // Gone after it was seen = the old device cancelled. Not seen yet may be a read
  // that does not reflect the create a moment ago: keep waiting.
  let seen = false;
  const answer = await pollUntil(async () => {
    const file = await readEnrollFile(join.offer, opts.signal);
    if (!file) {
      if (seen) throw new EnrollError('cancelled', 'The other device cancelled.');
      return null;
    }
    seen = true;
    const parsed = parseEnrollFile(file.data);
    if (!parsed || parsed.k !== join.myPub) {
      throw new EnrollError('tampered', 'This device\'s request was replaced in the repository.');
    }
    return parsed.ct && parsed.iv ? { iv: parsed.iv, ct: parsed.ct } : null;
  }, opts.deadline ?? Date.now() + ENROLL_TTL_MS, opts);

  // Whatever happens next, the exchange is over: take its branch down.
  await discardEnrollment(join.offer);
  let password: unknown;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64url(answer.iv) as BufferSource, additionalData: aad(join.offer.pid) },
      join.aesKey,
      fromB64url(answer.ct) as BufferSource,
    );
    password = (JSON.parse(new TextDecoder().decode(plain)) as { p?: unknown }).p;
  } catch {
    password = undefined;
  }
  if (typeof password !== 'string' || !password) {
    throw new EnrollError('tampered', 'The answer does not open with this device\'s key.');
  }
  return password;
}
