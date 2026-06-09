import { describe, it, expect } from 'vitest';
import { checkSecretStrength } from '../../lib/password-strength';

describe('checkSecretStrength (ACR-014)', () => {
  it('rejects secrets that are too short', () => {
    expect(checkSecretStrength('short').ok).toBe(false);
    expect(checkSecretStrength('aB3$x', 8).ok).toBe(false);
  });

  it('rejects common passwords even when long enough', () => {
    expect(checkSecretStrength('password123').ok).toBe(false);
    expect(checkSecretStrength('qwertyuiop').ok).toBe(false);
  });

  it('rejects low-variety secrets', () => {
    expect(checkSecretStrength('aaaaaaaaaaaa').ok).toBe(false); // 1 class, 1 unique char
    expect(checkSecretStrength('1111111111').ok).toBe(false);
  });

  it('accepts a long, varied passphrase', () => {
    expect(checkSecretStrength('correct-horse-battery-staple').ok).toBe(true);
  });

  it('accepts a shorter password with multiple character classes', () => {
    expect(checkSecretStrength('Tr0ub4dor&3').ok).toBe(true);
  });

  it('honors a custom minimum length', () => {
    const r = checkSecretStrength('abcdefghij', 12);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/12 characters/);
  });
});
