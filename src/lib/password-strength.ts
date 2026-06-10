// Lightweight, dependency-free secret-strength estimator and gate (ACR-014).
//
// This is NOT a zxcvbn replacement. Strength is an entropy estimate priced against
// the offline attacker model in THREAT_MODEL.md ("Key sizes, KDFs & brute-force
// economics"): a secret passes only when its average offline crack time exceeds
// ONE YEAR at the doc's aggregate guess rates — PBKDF2-600k ~1e9 guess/s for the
// sync password, Argon2id 64 MiB ~1e8 guess/s for the vault passphrase. There are
// no composition rules: a long lowercase-only passphrase passes on entropy alone.

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
  sync: 1e9, // PBKDF2-600k, ~100k-GPU aggregate
  vault: 1e8, // Argon2id 64 MiB, memory-hard
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
    if (bits < requiredBits) {
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
