// Lightweight, dependency-free secret-strength estimator and gate (ACR-014).
//
// This is NOT a zxcvbn replacement. Strength is an entropy estimate priced against
// the offline attacker model in THREAT_MODEL.md ("Key sizes, KDFs & brute-force
// economics"): a secret passes only when its average offline crack time exceeds
// ONE YEAR against a dedicated ~1,000-GPU professional cracking farm — PBKDF2-600k
// ~1e7 guess/s for the sync password, Argon2id 64 MiB ~1e6 guess/s for the vault
// passphrase. Frontier-cluster (~100k-GPU, the previous calibration) resistance is
// an explicit NON-goal for a personal task vault; users who want it add roughly one
// more diceware word (~+6.6 bits per 100×). There are no composition rules: a long
// lowercase-only passphrase passes on entropy alone.

const COMMON = new Set([
  'password', 'passw0rd', 'password1', 'password123', '123456', '1234567', '12345678',
  '123456789', '1234567890', 'qwerty', 'qwerty123', 'qwertyuiop', '111111', '000000',
  'abc123', 'letmein', 'admin', 'welcome', 'iloveyou', 'monkey', 'dragon', 'sunshine',
  'princess', 'football', 'baseball', 'changeme', 'secret', 'master', 'login', 'starwars',
  'whatever', 'trustno1', 'superman', 'hello123', 'passphrase', 'correcthorse',
]);

/** Which verifier an offline attacker would grind, per THREAT_MODEL.md. */
export type SecretKind = 'sync' | 'vault';

const YEAR_SECONDS = 31_557_600;
const GUESS_RATE: Record<SecretKind, number> = {
  sync: 1e7, // PBKDF2-600k, ~1,000-GPU farm aggregate (~1e4 guess/s per GPU)
  vault: 1e6, // Argon2id 64 MiB, memory-hard (~1e3 guess/s per GPU)
};
// A blacklisted secret is among the attacker's first few thousand guesses.
const COMMON_BITS = 10;

export interface StrengthEstimate {
  ok: boolean;
  bits: number;
  requiredBits: number;
  /** min(bits / requiredBits, 1) — drives the strength bar. */
  fraction: number;
  /** Average offline crack time, 2^(bits-1) / rate. */
  crackSeconds: number;
  /** Actionable suggestion, present only when !ok. */
  hint?: string;
}

// Character classes and sizes (THREAT_MODEL.md: lowercase ≈ 4.7 bits/char,
// alphanumeric ≈ 5.95, full ASCII ≈ 6.55, digit ≈ 3.32).
const CLASSES: Array<{ re: RegExp; size: number }> = [
  { re: /[a-z]/, size: 26 },
  { re: /[A-Z]/, size: 26 },
  { re: /[0-9]/, size: 10 },
  { re: /[^a-zA-Z0-9]/, size: 33 },
];

// length × log2(union of classes present); a character repeating either of the
// two before it is worth 1 bit, so "aaaa…" and "abab…" cannot buy entropy by length.
function charsetBits(s: string): number {
  if (!s) return 0;
  const size = CLASSES.filter((c) => c.re.test(s)).reduce((n, c) => n + c.size, 0);
  const perChar = Math.log2(size);
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const repeat = (i > 0 && s[i] === s[i - 1]) || (i > 1 && s[i] === s[i - 2]);
    bits += repeat ? 1 : perChar;
  }
  return bits;
}

const DICEWARE_BITS = 12.9; // per random word (THREAT_MODEL.md)
const AVG_WORD_LEN = 5.5;

interface WordEstimate { applies: boolean; bits: number; words: number }

// Word-structure estimate for letter-dominated secrets: humans pick words, and a
// word carries ~12.9 bits (the doc's diceware figure) no matter how long it is.
// Letter runs (split on case changes and non-letters) are priced as len/5.5
// implied words; digits add their charset bits; symbols count as free separators
// (the diceware convention — keeps "4 words ≈ 52 bits" matching the doc's table).
// Structural only — there is no dictionary, so an unbroken lowercase mash is
// priced as if it were words (conservative for genuinely random letter strings).
function wordStructureBits(s: string): WordEstimate {
  const letters = (s.match(/[a-zA-Z]/g) ?? []).length;
  if (letters < (2 * s.length) / 3) return { applies: false, bits: 0, words: 0 };
  let bits = 0;
  let words = 0;
  const runs = s.match(/[A-Z]{2,}(?![a-z])|[A-Z]?[a-z]+|[A-Z]/g) ?? [];
  for (const run of runs) {
    const implied = Math.max(1, Math.floor(run.length / AVG_WORD_LEN));
    // a run is never worth more than its own character-level entropy
    bits += Math.min(implied * DICEWARE_BITS, charsetBits(run));
    words += implied;
  }
  bits += charsetBits((s.match(/[0-9]/g) ?? []).join(''));
  return { applies: true, bits, words };
}

// --- Patterns (threat-model review, batch 5) ---------------------------------
// What a cracker's rule sets try first, and the estimate above priced as if
// random: a secret made of one piece repeated ("passwordpassword…", "aaaa…"),
// alphabet or digit runs ("abcdef…", "12345…"), keyboard rows ("qwertyuiop…"), and
// a known password inside a longer one ("correcthorse" + "batterystaple"). Each
// such piece is priced at what it costs to guess; the rest as before.
const KEYBOARD_ROWS = ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const MIN_SEQUENCE = 4;   // "abcd", "1234", "dcba"
const MIN_KEYBOARD = 5;   // "qwert" — shorter rows sit inside ordinary words ("liberty")
const SEQUENCE_BITS = (len: number) => Math.log2(36 * 2) + Math.log2(len); // which start, which way, how long
const KEYBOARD_BITS = (len: number) => Math.log2(KEYBOARD_ROWS.length * 2 * 10) + Math.log2(len);
// A known password found inside a longer secret counts as one word, never more.
const COMMON_PIECES = [...COMMON].filter((w) => w.length >= 6).sort((a, b) => b.length - a.length);

function plainBits(s: string): number {
  const w = wordStructureBits(s);
  return w.applies ? Math.min(charsetBits(s), w.bits) : charsetBits(s);
}

/** A secret made of one unit repeated k ≥ 2 times: the unit, or null. */
function repeatedUnit(s: string): { unit: string; times: number } | null {
  for (let u = 1; u <= s.length / 2; u++) {
    if (s.length % u !== 0) continue;
    const unit = s.slice(0, u);
    if (unit.repeat(s.length / u) === s) return { unit, times: s.length / u };
  }
  return null;
}

function sequenceAt(s: string, i: number): number {
  const isAlnum = (c: string) => /[a-z0-9]/.test(c);
  if (!isAlnum(s[i]) || i + 1 >= s.length || !isAlnum(s[i + 1])) return 0;
  const step = s.charCodeAt(i + 1) - s.charCodeAt(i);
  if (step !== 1 && step !== -1) return 0;
  let j = i + 1;
  while (j + 1 < s.length && isAlnum(s[j + 1]) && s.charCodeAt(j + 1) - s.charCodeAt(j) === step) j++;
  return j - i + 1;
}

function keyboardAt(s: string, i: number): number {
  let best = 0;
  for (const row of KEYBOARD_ROWS) {
    for (const line of [row, [...row].reverse().join('')]) {
      const start = line.indexOf(s[i]);
      if (start < 0) continue;
      let n = 0;
      while (i + n < s.length && start + n < line.length && s[i + n] === line[start + n]) n++;
      best = Math.max(best, n);
    }
  }
  return best;
}

/** The pattern-aware estimate, or null when the secret holds no pattern. */
function patternBits(secret: string): number | null {
  const s = secret.toLowerCase();
  const rep = repeatedUnit(s);
  if (rep) return (COMMON.has(rep.unit) ? COMMON_BITS : patternBits(rep.unit) ?? plainBits(rep.unit)) + Math.log2(rep.times);
  let bits = 0;
  let rest = '';
  let found = false;
  for (let i = 0; i < s.length;) {
    const common = COMMON_PIECES.find((w) => s.startsWith(w, i));
    const seq = sequenceAt(s, i);
    const keys = keyboardAt(s, i);
    if (common && common.length >= Math.max(seq, keys)) {
      bits += DICEWARE_BITS; i += common.length; found = true;
    } else if (seq >= MIN_SEQUENCE && seq >= keys) {
      bits += SEQUENCE_BITS(seq); i += seq; found = true;
    } else if (keys >= MIN_KEYBOARD) {
      bits += KEYBOARD_BITS(keys); i += keys; found = true;
    } else {
      rest += secret[i]; i += 1;
    }
  }
  return found ? bits + (rest ? plainBits(rest) : 0) : null;
}

export function estimateSecretStrength(secret: string, kind: SecretKind): StrengthEstimate {
  const rate = GUESS_RATE[kind];
  const requiredBits = Math.log2(rate * YEAR_SECONDS) + 1;
  let bits = 0;
  let hint: string | undefined;
  if (secret && COMMON.has(secret.toLowerCase())) {
    bits = COMMON_BITS;
    hint = 'That is a commonly used password — choose something unique.';
  } else if (secret) {
    const w = wordStructureBits(secret);
    bits = w.applies ? Math.min(charsetBits(secret), w.bits) : charsetBits(secret);
    const patterned = patternBits(secret);
    if (patterned !== null && patterned < bits) {
      bits = patterned;
      if (bits < requiredBits) hint = 'Avoid repeated text, sequences like abcd or 1234, keyboard rows and well-known passwords.';
    }
    if (bits < requiredBits && !hint) {
      hint = w.applies && w.words <= 2
        ? 'One or two words are easy to guess — use 4–5 unrelated words or a longer phrase.'
        : 'Make it longer — add more words or characters.';
    }
  } else {
    hint = 'Make it longer — add more words or characters.';
  }
  return {
    ok: bits >= requiredBits && !hint,
    bits,
    requiredBits,
    fraction: Math.min(bits / requiredBits, 1),
    crackSeconds: Math.pow(2, bits - 1) / rate,
    hint,
  };
}

/** Human-readable average crack time, e.g. "instantly", "in ~3 days", "in centuries". */
export function formatCrackTime(seconds: number): string {
  if (seconds < 60) return 'instantly';
  if (seconds >= 200 * YEAR_SECONDS) return 'in centuries';
  const units: Array<[string, number]> = [
    ['year', YEAR_SECONDS],
    ['month', 2_629_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [name, len] of units) {
    if (seconds >= len) {
      const n = Math.round(seconds / len);
      return `in ~${n} ${name}${n === 1 ? '' : 's'}`;
    }
  }
  return 'instantly';
}

export interface StrengthResult { ok: boolean; reason?: string }

/**
 * Submit gate: same threshold the live strength bar shows, so they never disagree.
 * @param secret the chosen passphrase / sync password
 * @param kind   'sync' (PBKDF2 verifier) or 'vault' (Argon2id verifier)
 */
export function checkSecretStrength(secret: string, kind: SecretKind): StrengthResult {
  const { ok, hint } = estimateSecretStrength(secret, kind);
  return ok ? { ok } : { ok, reason: hint };
}
