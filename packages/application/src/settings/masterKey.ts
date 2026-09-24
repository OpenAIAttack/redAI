/**
 * Master-key providers for the AEAD secret vault (docs/11 §8, docs/13 §7).
 *
 * The production provider loads a 32-byte AES-256 key from a file whose path comes
 * from `process.env.REDAI_MASTER_KEY_FILE` — a file kept outside the DB and git. The
 * key id is DERIVED from the key content, so:
 *   - a different key produces a different id → old ciphertext (sealed under the old
 *     id) fails to open loudly instead of being silently re-keyed, and
 *   - a MISSING key file is a hard error (the vault is locked) — the provider never
 *     mints a fresh key, so losing the file never destroys the ability to prove that
 *     old data can no longer be read.
 *
 * This module validates its own env var; it does NOT edit `apps/api/src/env.ts`.
 */
import { readFileSync, statSync } from 'node:fs';
import { MasterKeyUnavailableError } from './errors.js';
import { sha256Hex } from './crypto.js';
import type { MasterKeyMaterial, MasterKeyProvider } from './ports.js';

const KEY_BYTES = 32; // AES-256

/** Derive the stable, non-secret key id from key material. */
export function deriveKeyId(key: Buffer): string {
  return `mk_${sha256Hex(key).slice(0, 16)}`;
}

/**
 * Parse raw key-file bytes into a 32-byte key. Accepts (in order) 64-char hex, a
 * base64/base64url encoding of 32 bytes, or exactly 32 raw bytes. Anything else is
 * rejected — we never stretch or hash arbitrary content into a key silently.
 */
export function parseKeyMaterial(raw: Buffer): Buffer {
  const text = raw.toString('utf8').trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) {
    return Buffer.from(text, 'hex');
  }
  if (/^[A-Za-z0-9+/=_-]+$/.test(text)) {
    const decoded = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (decoded.length === KEY_BYTES) return decoded;
  }
  if (raw.length === KEY_BYTES) return Buffer.from(raw);
  throw new MasterKeyUnavailableError(
    'Master key file must contain a 32-byte key (hex, base64, or raw bytes).',
  );
}

export interface FileMasterKeyOptions {
  /** Override the env-var path (tests). Defaults to `process.env.REDAI_MASTER_KEY_FILE`. */
  keyFilePath?: string;
  /** Warn-only mode-check toggle; defaults on. When on, a world/group-readable key is refused. */
  enforceFileMode?: boolean;
}

/**
 * Loads the master key from a file, lazily and once. A missing/invalid file throws
 * {@link MasterKeyUnavailableError} on first use (and on every subsequent use) — it
 * is never swallowed and never replaced by a generated key.
 */
export class FileMasterKeyProvider implements MasterKeyProvider {
  private readonly path: string;
  private readonly enforceMode: boolean;
  private cached: MasterKeyMaterial | null = null;

  public constructor(options: FileMasterKeyOptions = {}) {
    const path = options.keyFilePath ?? process.env['REDAI_MASTER_KEY_FILE'];
    if (typeof path !== 'string' || path.trim() === '') {
      throw new MasterKeyUnavailableError(
        'REDAI_MASTER_KEY_FILE is not set; secret store cannot be unlocked.',
      );
    }
    this.path = path;
    this.enforceMode = options.enforceFileMode ?? true;
  }

  private load(): MasterKeyMaterial {
    if (this.cached) return this.cached;
    let raw: Buffer;
    try {
      if (this.enforceMode) {
        const mode = statSync(this.path).mode & 0o077;
        if (mode !== 0) {
          throw new MasterKeyUnavailableError(
            'Master key file is group/world accessible; refusing to load (expected mode 0600).',
          );
        }
      }
      raw = readFileSync(this.path);
    } catch (err) {
      if (err instanceof MasterKeyUnavailableError) throw err;
      // ENOENT / EACCES / any read failure → locked, NOT a new key.
      throw new MasterKeyUnavailableError(
        'Master key file could not be read; secret store is locked.',
      );
    }
    const key = parseKeyMaterial(raw);
    this.cached = { keyId: deriveKeyId(key), key };
    return this.cached;
  }

  public activeKey(): MasterKeyMaterial {
    return this.load();
  }

  public keyById(keyId: string): Buffer | null {
    const active = this.load();
    return active.keyId === keyId ? active.key : null;
  }
}

/** Convenience factory mirroring the auth package's `createDb*` helpers. */
export function createFileMasterKeyProvider(options: FileMasterKeyOptions = {}): MasterKeyProvider {
  return new FileMasterKeyProvider(options);
}

/**
 * In-memory provider for tests: a fixed key (and optional extra retired keys for
 * rotation tests). Never used in production wiring.
 */
export class StaticMasterKeyProvider implements MasterKeyProvider {
  private readonly active: MasterKeyMaterial;
  private readonly byId = new Map<string, Buffer>();

  public constructor(activeKey: Buffer, retiredKeys: Buffer[] = []) {
    if (activeKey.length !== KEY_BYTES) {
      throw new MasterKeyUnavailableError('Static master key must be exactly 32 bytes.');
    }
    this.active = { keyId: deriveKeyId(activeKey), key: activeKey };
    this.byId.set(this.active.keyId, activeKey);
    for (const k of retiredKeys) this.byId.set(deriveKeyId(k), k);
  }

  public activeKey(): MasterKeyMaterial {
    return this.active;
  }

  public keyById(keyId: string): Buffer | null {
    return this.byId.get(keyId) ?? null;
  }
}
