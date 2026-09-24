/**
 * Installation signing key (coordinator wiring).
 *
 * The worker enrollment response must echo at least one trusted installation
 * signing key (contract: >=1) so a worker can later verify signed task payloads.
 * Full persistent key management (rotation, retirement, the private-key signer)
 * belongs to the payload-signing task; for M1 this generates one Ed25519 key at
 * process start and exposes its PUBLIC half as the trusted key. It is stable for
 * the lifetime of the process, which is sufficient before any long-lived worker
 * exists (decision D07). The private key never leaves this module.
 */
import { generateKeyPairSync, createHash, type KeyObject } from 'node:crypto';

export interface TrustedSigningKey {
  key_id: string;
  algorithm: 'EdDSA';
  public_key_base64url: string;
}

export interface InstallationSigningKey {
  trusted: TrustedSigningKey;
  privateKey: KeyObject;
}

export function generateInstallationSigningKey(): InstallationSigningKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  // JWK `x` is the base64url-encoded raw 32-byte Ed25519 public key.
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  const publicKeyB64Url = jwk.x ?? '';
  const keyId = 'isk_' + createHash('sha256').update(publicKeyB64Url).digest('hex').slice(0, 16);
  return {
    trusted: { key_id: keyId, algorithm: 'EdDSA', public_key_base64url: publicKeyB64Url },
    privateKey,
  };
}
