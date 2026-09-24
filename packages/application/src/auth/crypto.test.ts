import { describe, expect, it } from 'vitest';
import {
  constantTimeEqual,
  cryptoRandom,
  hashRecoveryCode,
  hashToken,
  scryptHasher,
} from './crypto.js';

describe('scryptHasher', () => {
  it('round-trips a password and rejects a wrong one', async () => {
    const stored = await scryptHasher.hash('correct-horse-battery');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(await scryptHasher.verify('correct-horse-battery', stored)).toBe(true);
    expect(await scryptHasher.verify('wrong', stored)).toBe(false);
  });

  it('produces a distinct salt (and therefore hash) each time', async () => {
    const a = await scryptHasher.hash('same-password');
    const b = await scryptHasher.hash('same-password');
    expect(a).not.toBe(b);
    expect(await scryptHasher.verify('same-password', a)).toBe(true);
    expect(await scryptHasher.verify('same-password', b)).toBe(true);
  });

  it('rejects a malformed stored hash without throwing', async () => {
    expect(await scryptHasher.verify('x', 'not-a-hash')).toBe(false);
    expect(await scryptHasher.verify('x', 'scrypt$32768$8$1$$')).toBe(false);
  });
});

describe('token & recovery hashing', () => {
  it('hashToken is deterministic and 32 bytes', () => {
    const h1 = hashToken('opaque-token');
    const h2 = hashToken('opaque-token');
    expect(h1.length).toBe(32);
    expect(constantTimeEqual(h1, h2)).toBe(true);
    expect(constantTimeEqual(h1, hashToken('other'))).toBe(false);
  });

  it('recovery code hashing normalizes separators and case', () => {
    const code = cryptoRandom.recoveryCode();
    const normalized = code.toLowerCase().replace(/-/g, ' ');
    expect(constantTimeEqual(hashRecoveryCode(code), hashRecoveryCode(normalized))).toBe(true);
  });

  it('recovery codes are unique and high-entropy', () => {
    const a = cryptoRandom.recoveryCode();
    const b = cryptoRandom.recoveryCode();
    expect(a).not.toBe(b);
    expect(a.replace(/-/g, '').length).toBeGreaterThanOrEqual(51); // 256 bits in base32
  });
});
