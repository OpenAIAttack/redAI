/**
 * Real `node:crypto` implementations of the auth ports plus the deterministic
 * hashing helpers the use cases need. No native dependency: passwords use scrypt
 * (a memory-hard KDF in the Node stdlib) and opaque tokens are hashed with SHA-256.
 *
 * Nothing here logs, and no function returns or embeds a plaintext secret in an
 * error. A password/recovery plaintext exists only as a function argument.
 */
import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import type { Clock, PasswordHasher, RandomSource } from './ports.js';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// scrypt work factor. N is CPU/memory cost (must be a power of two). These give a
// ~ tens-of-ms hash on the control plane and comfortably exceed the interactive
// login KDF floors; maxmem is raised to fit 128*N*r bytes for N=2^15.
const SCRYPT_N = 1 << 15; // 32768
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024; // 64 MiB
const SCRYPT_SALT_BYTES = 16;

/**
 * Encoded as `scrypt$N$r$p$<salt b64>$<hash b64>` so parameters travel with the
 * hash and can be bumped later without a migration. `verify` re-derives with the
 * stored parameters and compares in constant time.
 */
export const scryptHasher: PasswordHasher = {
  async hash(plain: string): Promise<string> {
    const salt = randomBytes(SCRYPT_SALT_BYTES);
    const derived = await scrypt(plain, salt, SCRYPT_KEYLEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    });
    return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
  },

  async verify(plain: string, stored: string): Promise<boolean> {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
    let salt: Buffer;
    let expected: Buffer;
    try {
      salt = Buffer.from(parts[4] ?? '', 'base64');
      expected = Buffer.from(parts[5] ?? '', 'base64');
    } catch {
      return false;
    }
    if (expected.length === 0) return false;
    const derived = await scrypt(plain, salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: Math.max(SCRYPT_MAXMEM, 128 * n * r * 2),
    });
    return constantTimeEqual(derived, expected);
  },
};

/** base64url without padding, from `bytes` random bytes. */
function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Recovery codes use Crockford base32 (no I/L/O/U) so they are easy to read back
// from a screen and unambiguous. 32 bytes → 256 bits of entropy.
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function toCrockford(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

export const cryptoRandom: RandomSource = {
  token(byteLength = 32): string {
    return base64url(randomBytes(byteLength));
  },
  recoveryCode(): string {
    // Group in blocks of 5 for readability: XXXXX-XXXXX-...
    const raw = toCrockford(randomBytes(32));
    return (raw.match(/.{1,5}/g) ?? [raw]).join('-');
  },
  uuid(): string {
    return randomUUID();
  },
};

/** System clock. Tests substitute a mock. */
export const systemClock: Clock = {
  now(): Date {
    return new Date();
  },
};

// --- deterministic hashing helpers (not secret-dependent, so not injected) ---

/** SHA-256 of an opaque token, stored as `bytea`. The raw token never touches the DB. */
export function hashToken(rawToken: string): Buffer {
  return createHash('sha256').update(rawToken, 'utf8').digest();
}

/** Normalize a recovery code (uppercase, drop separators/whitespace) then SHA-256 it. */
export function hashRecoveryCode(code: string): Buffer {
  const normalized = code.toUpperCase().replace(/[^0-9A-Z]/g, '');
  return createHash('sha256').update(normalized, 'utf8').digest();
}

/** Constant-time buffer equality (length-safe). */
export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
