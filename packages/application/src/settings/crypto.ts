/**
 * Real `node:crypto` implementations of the settings ports (clock + randomness) and
 * the small deterministic hashing helpers the vault needs. No native dependency and
 * no custom crypto: AEAD is the stdlib AES-256-GCM (see `vault.ts`). Nothing here
 * logs or embeds a plaintext secret in a return value or error.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Clock, RandomSource } from './ports.js';

/** System clock. Tests substitute a mock. */
export const systemClock: Clock = {
  now(): Date {
    return new Date();
  },
};

/** node:crypto randomness. Tests substitute a scripted source. */
export const nodeRandomSource: RandomSource = {
  bytes(n: number): Buffer {
    return randomBytes(n);
  },
  uuid(): string {
    return randomUUID();
  },
};

/** Lowercase-hex SHA-256 of a buffer or utf8 string. */
export function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Constant-time buffer equality (length-safe). */
export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
