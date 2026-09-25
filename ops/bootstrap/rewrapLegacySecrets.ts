/** Offline maintenance only. Stop API/runtime and verify row ownership from a
 * trusted backup before running: legacy AAD cannot prove project/row identity.
 * This is deliberately NOT an automatic decrypt fallback in the running service.
 */
import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import {
  SecretVault,
  createFileMasterKeyProvider,
  nodeRandomSource,
} from '../../packages/application/src/settings/index.js';
import { createPool, withTransaction, type Pool } from '../../packages/db/src/index.js';

import { pathToFileURL } from 'node:url';
export async function rewrapLegacySecrets(
  pool: Pool,
  keys: ReturnType<typeof createFileMasterKeyProvider>,
): Promise<number> {
  const vault = new SecretVault(keys, nodeRandomSource);
  return withTransaction(pool, async (tx) => {
    const rows = await tx.query<{
      id: string;
      workspace_id: string;
      project_id: string | null;
      name: string;
      kind: 'model_api_key' | 'target_credential';
      version: number;
      ciphertext: Buffer;
      nonce: Buffer;
      key_id: string;
      aad_sha256: string;
    }>('SELECT * FROM secrets FOR UPDATE');
    let changed = 0;
    for (const row of rows.rows) {
      const identity = {
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        secretId: row.id,
        name: row.name,
        kind: row.kind,
        version: Number(row.version),
      };
      const material = {
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        keyId: row.key_id,
        aadSha256: row.aad_sha256,
      };
      const aad = Buffer.from(
        JSON.stringify([row.workspace_id, row.kind, row.name, Number(row.version)]),
      );
      if (createHash('sha256').update(aad).digest('hex') !== row.aad_sha256) {
        vault.decrypt(identity, material).fill(0); // verify existing v2; abort on corruption
        continue;
      }
      const key = keys.keyById(row.key_id);
      if (!key) throw new Error('Required master key is unavailable.');
      const decipher = createDecipheriv('aes-256-gcm', key, row.nonce);
      decipher.setAAD(aad);
      decipher.setAuthTag(row.ciphertext.subarray(-16));
      const plaintext = Buffer.concat([
        decipher.update(row.ciphertext.subarray(0, -16)),
        decipher.final(),
      ]);
      try {
        const sealed = vault.encrypt(identity, plaintext);
        const verification = vault.decrypt(identity, sealed);
        try {
          if (!timingSafeEqual(verification, plaintext))
            throw new Error('Rewrap verification failed.');
        } finally {
          verification.fill(0);
        }
        await tx.query(
          'UPDATE secrets SET ciphertext=$2, nonce=$3, key_id=$4, aad_sha256=$5, updated_at=now() WHERE id=$1',
          [row.id, sealed.ciphertext, sealed.nonce, sealed.keyId, sealed.aadSha256],
        );
        changed++;
      } finally {
        plaintext.fill(0);
      }
    }
    return changed;
  });
}

async function main() {
  if (!process.argv.includes('--verified-row-ownership') || !process.env.DATABASE_URL)
    throw new Error(
      'Stop services, back up DB/key, verify ownership, then supply --verified-row-ownership and DATABASE_URL.',
    );
  const pool = createPool({ connectionString: process.env.DATABASE_URL });
  const keys = createFileMasterKeyProvider();
  try {
    const count = await rewrapLegacySecrets(pool, keys);
    console.log(`Rewrapped ${count} legacy secret rows; transaction committed.`);
  } finally {
    await pool.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error(
      'Secret rewrap failed; transaction rolled back. Verify backup, ownership and key configuration.',
    );
    process.exitCode = 1;
  });
