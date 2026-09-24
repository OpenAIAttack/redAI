import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileMasterKeyProvider, deriveKeyId, parseKeyMaterial } from './masterKey.js';
import { MasterKeyUnavailableError } from './errors.js';

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'redai-mk-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

const HEX_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

describe('parseKeyMaterial', () => {
  it('accepts a 64-char hex key', () => {
    expect(parseKeyMaterial(Buffer.from(HEX_KEY, 'utf8')).length).toBe(32);
  });

  it('accepts a base64 key of 32 bytes', () => {
    const b64 = Buffer.alloc(32, 7).toString('base64');
    expect(parseKeyMaterial(Buffer.from(b64, 'utf8')).equals(Buffer.alloc(32, 7))).toBe(true);
  });

  it('accepts 32 raw bytes', () => {
    const raw = Buffer.alloc(32, 9);
    expect(parseKeyMaterial(raw).equals(raw)).toBe(true);
  });

  it('rejects material that is not a 32-byte key', () => {
    expect(() => parseKeyMaterial(Buffer.from('too-short', 'utf8'))).toThrow(
      MasterKeyUnavailableError,
    );
  });
});

describe('deriveKeyId', () => {
  it('is deterministic and changes with the key', () => {
    const a = deriveKeyId(Buffer.alloc(32, 1));
    const b = deriveKeyId(Buffer.alloc(32, 1));
    const c = deriveKeyId(Buffer.alloc(32, 2));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^mk_[0-9a-f]{16}$/);
  });
});

describe('FileMasterKeyProvider', () => {
  it('loads a key from a 0600 file and derives its id', () => {
    const dir = tmpDir();
    const path = join(dir, 'master.key');
    writeFileSync(path, HEX_KEY, { mode: 0o600 });
    chmodSync(path, 0o600);
    const provider = new FileMasterKeyProvider({ keyFilePath: path });
    const active = provider.activeKey();
    expect(active.key.length).toBe(32);
    expect(provider.keyById(active.keyId)?.equals(active.key)).toBe(true);
    expect(provider.keyById('mk_deadbeefdeadbeef')).toBeNull();
  });

  it('is a HARD ERROR when the key file is missing — never mints a new key', () => {
    const dir = tmpDir();
    const provider = new FileMasterKeyProvider({ keyFilePath: join(dir, 'does-not-exist.key') });
    // Restart-after-loss simulation: a fresh provider over a missing file must throw,
    // not silently generate a usable key.
    expect(() => provider.activeKey()).toThrow(MasterKeyUnavailableError);
    expect(() => provider.keyById('mk_0000000000000000')).toThrow(MasterKeyUnavailableError);
  });

  it('is a HARD ERROR when the env var is unset and no path is given', () => {
    const prev = process.env['REDAI_MASTER_KEY_FILE'];
    delete process.env['REDAI_MASTER_KEY_FILE'];
    try {
      expect(() => new FileMasterKeyProvider()).toThrow(MasterKeyUnavailableError);
    } finally {
      if (prev !== undefined) process.env['REDAI_MASTER_KEY_FILE'] = prev;
    }
  });

  it('refuses a group/world-readable key file', () => {
    const dir = tmpDir();
    const path = join(dir, 'loose.key');
    writeFileSync(path, HEX_KEY);
    chmodSync(path, 0o644);
    const provider = new FileMasterKeyProvider({ keyFilePath: path });
    expect(() => provider.activeKey()).toThrow(MasterKeyUnavailableError);
  });

  it('a re-created provider over the SAME file yields the SAME key id (no re-keying)', () => {
    const dir = tmpDir();
    const path = join(dir, 'master.key');
    writeFileSync(path, HEX_KEY, { mode: 0o600 });
    chmodSync(path, 0o600);
    const id1 = new FileMasterKeyProvider({ keyFilePath: path }).activeKey().keyId;
    const id2 = new FileMasterKeyProvider({ keyFilePath: path }).activeKey().keyId;
    expect(id1).toBe(id2);
  });
});
