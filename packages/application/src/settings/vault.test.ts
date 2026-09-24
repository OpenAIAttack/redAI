import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretVault, canonicalAad, VAULT_NONCE_BYTES } from './vault.js';
import { StaticMasterKeyProvider } from './masterKey.js';
import { MasterKeyUnavailableError, SecretDecryptError } from './errors.js';
import { nodeRandomSource } from './crypto.js';
import type { RandomSource, SecretIdentity } from './index.js';

const KEY_A = Buffer.alloc(32, 1);
const KEY_B = Buffer.alloc(32, 2);

const identity: SecretIdentity = {
  workspaceId: '11111111-1111-4111-8111-111111111111',
  kind: 'model_api_key',
  name: 'openai',
  version: 1,
};

function vaultWith(key: Buffer, random: RandomSource = nodeRandomSource): SecretVault {
  return new SecretVault(new StaticMasterKeyProvider(key), random);
}

describe('SecretVault AES-256-GCM', () => {
  it('round-trips encrypt → decrypt', () => {
    const vault = vaultWith(KEY_A);
    const secret = 'sk-super-secret-value';
    const material = vault.encrypt(identity, Buffer.from(secret, 'utf8'));
    const opened = vault.decrypt(identity, material);
    expect(opened.toString('utf8')).toBe(secret);
  });

  it('never stores plaintext (ciphertext !== plaintext bytes)', () => {
    const vault = vaultWith(KEY_A);
    const plain = Buffer.from('plaintext-bytes-here', 'utf8');
    const material = vault.encrypt(identity, plain);
    expect(material.ciphertext.includes(plain)).toBe(false);
    expect(material.ciphertext.equals(plain)).toBe(false);
    // Sealed form is longer than plaintext (adds the 16-byte tag).
    expect(material.ciphertext.length).toBeGreaterThan(plain.length);
  });

  it('produces a 12-byte nonce', () => {
    const vault = vaultWith(KEY_A);
    const material = vault.encrypt(identity, Buffer.from('x'));
    expect(material.nonce.length).toBe(VAULT_NONCE_BYTES);
    expect(VAULT_NONCE_BYTES).toBe(12);
  });

  it('uses a fresh nonce each time → different ciphertext for the same plaintext', () => {
    const vault = vaultWith(KEY_A);
    const a = vault.encrypt(identity, Buffer.from('same'));
    const b = vault.encrypt(identity, Buffer.from('same'));
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('binds key_id and aad_sha256 to the identity', () => {
    const vault = vaultWith(KEY_A);
    const material = vault.encrypt(identity, Buffer.from('x'));
    expect(material.keyId).toMatch(/^mk_[0-9a-f]{16}$/);
    expect(material.aadSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(material.aadSha256).toBe(
      createHash('sha256').update(canonicalAad(identity)).digest('hex'),
    );
  });

  it('rejects decrypt under the WRONG KEY', () => {
    const material = vaultWith(KEY_A).encrypt(identity, Buffer.from('secret'));
    const otherVault = vaultWith(KEY_B);
    // The wrong key file has a different derived key_id → provider cannot supply it.
    expect(() => otherVault.decrypt(identity, material)).toThrow(MasterKeyUnavailableError);
  });

  it('rejects decrypt when the KEY_ID matches but the key bytes differ (tamper)', () => {
    const vault = vaultWith(KEY_A);
    const material = vault.encrypt(identity, Buffer.from('secret'));
    // Same declared key_id, but the provider holds a DIFFERENT key for that id.
    const forgedProvider = {
      activeKey: () => ({ keyId: material.keyId, key: KEY_A }),
      keyById: (_id: string) => KEY_B, // wrong bytes
    };
    const forged = new SecretVault(forgedProvider, nodeRandomSource);
    expect(() => forged.decrypt(identity, material)).toThrow(SecretDecryptError);
  });

  it('rejects decrypt with the WRONG AAD (moved / relabelled secret)', () => {
    const vault = vaultWith(KEY_A);
    const material = vault.encrypt(identity, Buffer.from('secret'));
    const movedIdentity: SecretIdentity = { ...identity, version: 2 };
    expect(() => vault.decrypt(movedIdentity, material)).toThrow(SecretDecryptError);

    const otherWorkspace: SecretIdentity = {
      ...identity,
      workspaceId: '22222222-2222-4222-8222-222222222222',
    };
    expect(() => vault.decrypt(otherWorkspace, material)).toThrow(SecretDecryptError);
  });

  it('rejects a tampered ciphertext byte', () => {
    const vault = vaultWith(KEY_A);
    const material = vault.encrypt(identity, Buffer.from('secret'));
    const tampered = Buffer.from(material.ciphertext);
    tampered[0] = tampered[0]! ^ 0xff;
    expect(() => vault.decrypt(identity, { ...material, ciphertext: tampered })).toThrow(
      SecretDecryptError,
    );
  });

  it('rejects a tampered stored aad_sha256', () => {
    const vault = vaultWith(KEY_A);
    const material = vault.encrypt(identity, Buffer.from('secret'));
    const badDigest = 'f'.repeat(64);
    expect(() => vault.decrypt(identity, { ...material, aadSha256: badDigest })).toThrow(
      SecretDecryptError,
    );
  });

  it('rejects a non-12-byte nonce on decrypt', () => {
    const vault = vaultWith(KEY_A);
    const material = vault.encrypt(identity, Buffer.from('secret'));
    expect(() => vault.decrypt(identity, { ...material, nonce: randomBytes(16) })).toThrow(
      SecretDecryptError,
    );
  });
});
