/**
 * AEAD secret vault (docs/11 §8): AES-256-GCM from the Node stdlib, a fresh 12-byte
 * nonce per ciphertext, and a 16-byte auth tag. Each ciphertext is bound to its
 * logical identity through the GCM Additional Authenticated Data (AAD), which is a
 * canonical encoding of `workspace_id | kind | name | version`. Because the AAD is
 * authenticated, a ciphertext row physically moved to another workspace/project or
 * relabelled will fail to open — it cannot be decrypted in the wrong context.
 *
 * Only ciphertext + nonce + key_id + aad_sha256 are stored; the plaintext exists
 * solely as a method argument / return value and is never logged.
 */
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { constantTimeEqual, sha256Hex } from './crypto.js';
import { MasterKeyUnavailableError, SecretDecryptError } from './errors.js';
import type { MasterKeyProvider, RandomSource, SecretCipherMaterial, SecretKind } from './ports.js';

const NONCE_BYTES = 12; // GCM standard IV length; matches the schema CHECK octet_length(nonce)=12
const TAG_BYTES = 16;

export interface SecretIdentity {
  workspaceId: string;
  kind: SecretKind;
  name: string;
  version: number;
}

/**
 * Canonical AAD encoding. JSON array (length-delimited) so a `|` inside `name` can
 * never be confused with a field separator. Stable across encrypt and decrypt.
 */
export function canonicalAad(identity: SecretIdentity): Buffer {
  return Buffer.from(
    JSON.stringify([identity.workspaceId, identity.kind, identity.name, identity.version]),
    'utf8',
  );
}

export class SecretVault {
  public constructor(
    private readonly keys: MasterKeyProvider,
    private readonly random: RandomSource,
  ) {}

  /** Seal `plaintext` for `identity`. Returns the at-rest material (no plaintext). */
  public encrypt(identity: SecretIdentity, plaintext: Buffer): SecretCipherMaterial {
    const { keyId, key } = this.keys.activeKey();
    const nonce = this.random.bytes(NONCE_BYTES);
    if (nonce.length !== NONCE_BYTES) {
      // A misbehaving RandomSource must never weaken the nonce.
      throw new SecretDecryptError('Nonce generation produced the wrong length.');
    }
    const aad = canonicalAad(identity);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad);
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      // Store enc||tag so the tag travels with the ciphertext (schema has no tag column).
      ciphertext: Buffer.concat([enc, tag]),
      nonce,
      keyId,
      aadSha256: sha256Hex(aad),
    };
  }

  /**
   * Open a sealed secret. Throws {@link SecretDecryptError} on the wrong key, the
   * wrong AAD (moved/relabelled row) or a tampered ciphertext/tag, and
   * {@link MasterKeyUnavailableError} when the store is locked. Returns plaintext.
   */
  public decrypt(identity: SecretIdentity, material: SecretCipherMaterial): Buffer {
    if (material.nonce.length !== NONCE_BYTES) {
      throw new SecretDecryptError('Stored nonce has the wrong length.');
    }
    if (material.ciphertext.length < TAG_BYTES) {
      throw new SecretDecryptError('Stored ciphertext is too short to contain an auth tag.');
    }

    const key = this.keys.keyById(material.keyId);
    if (key === null) {
      // No key that matches the id this ciphertext was sealed under: locked / wrong key.
      throw new MasterKeyUnavailableError(
        'No master key matches the id this secret was sealed under.',
      );
    }

    const aad = canonicalAad(identity);
    // Cheap fail-fast + integrity check on the stored AAD digest before the AEAD open.
    if (
      !constantTimeEqual(Buffer.from(sha256Hex(aad), 'hex'), Buffer.from(material.aadSha256, 'hex'))
    ) {
      throw new SecretDecryptError('AAD does not match the stored binding.');
    }

    const enc = material.ciphertext.subarray(0, material.ciphertext.length - TAG_BYTES);
    const tag = material.ciphertext.subarray(material.ciphertext.length - TAG_BYTES);
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, material.nonce, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]);
    } catch {
      // GCM authentication failure (wrong key / tampered data). Never leak details.
      throw new SecretDecryptError();
    }
  }
}

export { NONCE_BYTES as VAULT_NONCE_BYTES, TAG_BYTES as VAULT_TAG_BYTES };
