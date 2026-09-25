import { hash, verify } from '@node-rs/argon2';
import type { PasswordHasher } from './ports.js';
import { scryptHasher } from './crypto.js';

/** New credentials follow docs/13: Argon2id, 64 MiB, t=3, p=1.
 * Legacy scrypt is verification-only to preserve owner access after an upgrade.
 * A password change/reset replaces legacy hashes with Argon2id.
 */
export const argon2Hasher: PasswordHasher = {
  hash: (plain) =>
    hash(plain, {
      algorithm: 2 /* Argon2id; upstream exposes an ambient const enum */,
      memoryCost: 65536,
      timeCost: 3,
      parallelism: 1,
      outputLen: 32,
    }),
  async verify(plain, stored) {
    if (stored.startsWith('scrypt$')) return scryptHasher.verify(plain, stored);
    const params = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(stored);
    if (
      !params ||
      Number(params[1]) !== 65536 ||
      Number(params[2]) !== 3 ||
      Number(params[3]) !== 1
    )
      return false;
    try {
      return await verify(stored, plain);
    } catch {
      return false;
    }
  },
};
