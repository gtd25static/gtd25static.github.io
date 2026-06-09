// Lightweight, dependency-free secret-strength gate (ACR-014).
//
// This is NOT a replacement for zxcvbn; it deliberately blocks only the clearly-weak
// inputs that defeat PBKDF2/Argon2id no matter how high the work factor: too short,
// a well-known password, or near-zero variety. A long, varied passphrase passes.
// Used to guard the vault passphrase and the sync password at the points the user
// chooses them.

const COMMON = new Set([
  'password', 'passw0rd', 'password1', 'password123', '123456', '1234567', '12345678',
  '123456789', '1234567890', 'qwerty', 'qwerty123', 'qwertyuiop', '111111', '000000',
  'abc123', 'letmein', 'admin', 'welcome', 'iloveyou', 'monkey', 'dragon', 'sunshine',
  'princess', 'football', 'baseball', 'changeme', 'secret', 'master', 'login', 'starwars',
  'whatever', 'trustno1', 'superman', 'hello123', 'passphrase', 'correcthorse',
]);

export interface StrengthResult { ok: boolean; reason?: string }

/**
 * @param secret    the chosen passphrase / sync password
 * @param minLength minimum acceptable length (default 10)
 */
export function checkSecretStrength(secret: string, minLength = 10): StrengthResult {
  if (secret.length < minLength) {
    return { ok: false, reason: `Use at least ${minLength} characters.` };
  }
  if (COMMON.has(secret.toLowerCase())) {
    return { ok: false, reason: 'That is a commonly used password — choose something unique.' };
  }
  const unique = new Set(secret).size;
  // A long passphrase with enough distinct characters is fine even with one class
  // (e.g. several lowercase words).
  if (secret.length >= 16 && unique >= 8) return { ok: true };
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(secret)).length;
  if (classes < 2 || unique < 5) {
    return { ok: false, reason: 'Too simple — mix multiple words, cases, numbers, or symbols.' };
  }
  return { ok: true };
}
