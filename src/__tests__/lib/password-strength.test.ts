import { describe, it, expect } from 'vitest';
import {
  checkSecretStrength,
  estimateSecretStrength,
  formatCrackTime,
} from '../../lib/password-strength';

// Thresholds derive from THREAT_MODEL.md's attacker rates: >1 year average crack
// time at ~1e9 guess/s (sync, PBKDF2) ≈ 55.8 bits; ~1e8 guess/s (vault, Argon2id)
// ≈ 52.5 bits. Diceware word ≈ 12.9 bits → 4 words fail vault, 5 pass both.

describe('estimateSecretStrength (ACR-014 v2)', () => {
  it('requires more entropy for the sync password than the vault passphrase', () => {
    const sync = estimateSecretStrength('x', 'sync');
    const vault = estimateSecretStrength('x', 'vault');
    expect(sync.requiredBits).toBeGreaterThan(vault.requiredBits);
    expect(vault.requiredBits).toBeGreaterThan(52);
    expect(sync.requiredBits).toBeLessThan(56);
  });

  it('accepts a long all-lowercase passphrase — no composition policy', () => {
    expect(estimateSecretStrength('thequickbrownfoxjumpsoverthelazydog', 'sync').ok).toBe(true);
    expect(estimateSecretStrength('thequickbrownfoxjumpsoverthelazydog', 'vault').ok).toBe(true);
  });

  it('accepts 5 separated words for both kinds', () => {
    const phrase = 'alpha rhino cactus velvet moon';
    expect(estimateSecretStrength(phrase, 'vault').ok).toBe(true);
    expect(estimateSecretStrength(phrase, 'sync').ok).toBe(true);
  });

  it('rejects ~4 separated words (≈52 bits — under a year of compute)', () => {
    const est = estimateSecretStrength('alpha rhino cactus velvet', 'vault');
    expect(est.ok).toBe(false);
    expect(est.fraction).toBeGreaterThan(0.9); // close, but not over the line
  });

  it('rejects one or two dictionary-style words with the word hint', () => {
    for (const secret of ['dolphin', 'sunshinedolphin', 'sunshine dolphin']) {
      const est = estimateSecretStrength(secret, 'vault');
      expect(est.ok).toBe(false);
      expect(est.hint).toMatch(/One or two words/);
    }
  });

  it('rejects word + digit/symbol suffix patterns like "Password1!"', () => {
    const est = estimateSecretStrength('Password1!', 'vault');
    expect(est.ok).toBe(false);
  });

  it('prices digit-only secrets at ~3.3 bits/digit', () => {
    expect(estimateSecretStrength('516294387051629438', 'sync').ok).toBe(true); // 18 digits ≈ 60 bits
    expect(estimateSecretStrength('516294387051628', 'sync').ok).toBe(false); // 15 digits ≈ 50 bits
  });

  it('discounts repeated characters — length alone cannot buy entropy', () => {
    expect(estimateSecretStrength('a'.repeat(40), 'vault').ok).toBe(false);
    expect(estimateSecretStrength('ababababababababababababababab', 'vault').ok).toBe(false);
  });

  it('rejects common passwords regardless of casing, with the common hint', () => {
    for (const secret of ['password123', 'CORRECTHORSE', 'Passphrase']) {
      const est = estimateSecretStrength(secret, 'vault');
      expect(est.ok).toBe(false);
      expect(est.hint).toMatch(/commonly used/);
      expect(est.fraction).toBeLessThan(0.5);
    }
  });

  it('does not let the word model penalize random non-letter-dominated secrets', () => {
    // 50% letters → charset model only: 12 chars full-ASCII ≈ 79 bits
    expect(estimateSecretStrength('k7#mP2$vQ9!x', 'sync').ok).toBe(true);
  });

  it('returns sane fraction and crackSeconds', () => {
    const weak = estimateSecretStrength('abc', 'vault');
    expect(weak.fraction).toBeGreaterThan(0);
    expect(weak.fraction).toBeLessThan(0.5);
    expect(weak.crackSeconds).toBeLessThan(1);
    const strong = estimateSecretStrength('alpha rhino cactus velvet moon', 'vault');
    expect(strong.fraction).toBe(1);
    expect(strong.crackSeconds).toBeGreaterThan(31_557_600);
    const empty = estimateSecretStrength('', 'vault');
    expect(empty.ok).toBe(false);
    expect(empty.bits).toBe(0);
    expect(empty.fraction).toBe(0);
  });
});

describe('checkSecretStrength gate wrapper', () => {
  it('mirrors the estimate and carries the hint as reason', () => {
    expect(checkSecretStrength('alpha rhino cactus velvet moon', 'vault')).toEqual({ ok: true });
    const fail = checkSecretStrength('sunshine dolphin', 'vault');
    expect(fail.ok).toBe(false);
    expect(fail.reason).toMatch(/One or two words/);
  });
});

describe('formatCrackTime', () => {
  it('formats across magnitudes', () => {
    expect(formatCrackTime(0.001)).toBe('instantly');
    expect(formatCrackTime(59)).toBe('instantly');
    expect(formatCrackTime(180)).toBe('in ~3 minutes');
    expect(formatCrackTime(3 * 86_400)).toBe('in ~3 days');
    expect(formatCrackTime(7 * 2_629_800)).toBe('in ~7 months');
    expect(formatCrackTime(80 * 31_557_600)).toBe('in ~80 years');
    expect(formatCrackTime(1e15)).toBe('in centuries');
  });
});
