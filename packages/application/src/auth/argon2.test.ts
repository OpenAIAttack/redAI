import { describe, expect, it } from 'vitest';
import { argon2Hasher } from './argon2.js';
import { scryptHasher } from './crypto.js';
describe('Argon2id password floor', () => {
  it('uses the spec parameters and verifies correct/wrong passwords', async () => {
    const hashed = await argon2Hasher.hash('synthetic-test-password');
    expect(hashed).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(await argon2Hasher.verify('synthetic-test-password', hashed)).toBe(true);
    expect(await argon2Hasher.verify('wrong', hashed)).toBe(false);
  });
  it('preserves legacy login without allowing attacker-chosen KDF costs', async () => {
    const legacy = await scryptHasher.hash('legacy-password');
    expect(await argon2Hasher.verify('legacy-password', legacy)).toBe(true);
    expect(
      await argon2Hasher.verify('legacy-password', legacy.replace('$32768$', '$1073741824$')),
    ).toBe(false);
    expect(await argon2Hasher.verify('x', '$argon2id$v=19$m=999999999,t=3,p=1$bad$bad')).toBe(
      false,
    );
  });
});
