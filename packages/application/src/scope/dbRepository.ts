/**
 * DB-backed {@link ScopeRepository} over `@redai/db` — the production adapter (the
 * service unit tests use the in-memory fake instead). It owns its SQL: every statement
 * carries an explicit `workspace_id` predicate and every project-level statement also
 * carries `project_id`, so a request scoped to project A can never read or write
 * project B (INV-001), backed by the composite `(id, project_id, workspace_id)` keys.
 *
 * One-time verify (docs/10 §1) and revoke (docs/10 §7) are single guarded statements:
 * `markProofVerified` flips only a still-`pending` row, and `revokeGrant` bumps the
 * `policy_epoch` in the same UPDATE that sets `revoked_at`, so a concurrent verify or a
 * double revoke is a no-op, not a lost update.
 */
import type { Scope } from '@redai/contracts';
import type { Executor, Pool } from '@redai/db';
import type {
  AuthorizationBasis,
  DnsProofRecord,
  DnsProofStatus,
  GrantRecord,
  GrantStatus,
  InsertDnsProofFields,
  InsertGrantFields,
  InsertScopeVersionFields,
  MarkProofVerifiedFields,
  ScopeRepository,
  ScopeVersionRecord,
} from './ports.js';

interface DnsProofDbRow {
  id: string;
  workspace_id: string;
  project_id: string;
  root_ascii: string;
  record_name: string;
  challenge_hash: Buffer;
  expires_at: Date;
  status: DnsProofStatus;
  verified_at: Date | null;
  observed_txt_sha256: string | null;
  resolver_metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

interface ScopeVersionDbRow {
  id: string;
  workspace_id: string;
  project_id: string;
  version: number;
  policy: Scope;
  policy_sha256: string;
  created_by: string;
  created_at: Date;
}

interface GrantDbRow {
  id: string;
  workspace_id: string;
  project_id: string;
  scope_version_id: string;
  dns_proof_id: string | null;
  created_by: string;
  authorization_basis: AuthorizationBasis;
  attestation: string;
  status: GrantStatus;
  policy_epoch: string;
  valid_until: Date | null;
  revoked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toProof(r: DnsProofDbRow): DnsProofRecord {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    rootAscii: r.root_ascii,
    recordName: r.record_name,
    challengeHash: r.challenge_hash,
    expiresAt: r.expires_at,
    status: r.status,
    verifiedAt: r.verified_at,
    observedTxtSha256: r.observed_txt_sha256,
    resolverMetadata: r.resolver_metadata,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toVersion(r: ScopeVersionDbRow): ScopeVersionRecord {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    version: r.version,
    policy: r.policy,
    policySha256: r.policy_sha256,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

function toGrant(r: GrantDbRow): GrantRecord {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    scopeVersionId: r.scope_version_id,
    dnsProofId: r.dns_proof_id,
    createdBy: r.created_by,
    authorizationBasis: r.authorization_basis,
    attestation: r.attestation,
    status: r.status,
    policyEpoch: r.policy_epoch,
    validUntil: r.valid_until,
    revokedAt: r.revoked_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const PROOF_COLS =
  'id, workspace_id, project_id, root_ascii, record_name, challenge_hash, expires_at, status, verified_at, observed_txt_sha256, resolver_metadata, created_at, updated_at';
const GRANT_COLS =
  'id, workspace_id, project_id, scope_version_id, dns_proof_id, created_by, authorization_basis, attestation, status, policy_epoch::text AS policy_epoch, valid_until, revoked_at, created_at, updated_at';

export function createDbScopeRepository(pool: Pool): ScopeRepository {
  const exec: Executor = pool;

  return {
    // --- DNS proofs ---

    async insertDnsProof(workspaceId, projectId, id, fields: InsertDnsProofFields) {
      const res = await exec.query<DnsProofDbRow>(
        `INSERT INTO dns_proofs (id, workspace_id, project_id, root_ascii, challenge_hash, record_name, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${PROOF_COLS}`,
        [
          id,
          workspaceId,
          projectId,
          fields.rootAscii,
          fields.challengeHash,
          fields.recordName,
          fields.expiresAt,
        ],
      );
      return toProof(res.rows[0]!);
    },

    async getDnsProof(workspaceId, projectId, proofId) {
      const res = await exec.query<DnsProofDbRow>(
        `SELECT ${PROOF_COLS} FROM dns_proofs WHERE id = $1 AND project_id = $2 AND workspace_id = $3`,
        [proofId, projectId, workspaceId],
      );
      return res.rows[0] ? toProof(res.rows[0]) : null;
    },

    async listDnsProofs(workspaceId, projectId) {
      const res = await exec.query<DnsProofDbRow>(
        `SELECT ${PROOF_COLS} FROM dns_proofs
         WHERE workspace_id = $1 AND project_id = $2
         ORDER BY created_at DESC, id DESC`,
        [workspaceId, projectId],
      );
      return res.rows.map(toProof);
    },

    async findVerifiedProofForRoot(workspaceId, projectId, rootAscii) {
      const res = await exec.query<DnsProofDbRow>(
        `SELECT ${PROOF_COLS} FROM dns_proofs
         WHERE workspace_id = $1 AND project_id = $2 AND root_ascii = $3
           AND status = 'verified' AND expires_at > now()
         ORDER BY verified_at DESC NULLS LAST, id DESC LIMIT 1`,
        [workspaceId, projectId, rootAscii],
      );
      return res.rows[0] ? toProof(res.rows[0]) : null;
    },

    async markProofVerified(workspaceId, projectId, proofId, fields: MarkProofVerifiedFields) {
      const res = await exec.query<DnsProofDbRow>(
        `UPDATE dns_proofs
         SET status = 'verified', verified_at = $4, observed_txt_sha256 = $5,
             resolver_metadata = $6::jsonb, updated_at = now()
         WHERE id = $1 AND project_id = $2 AND workspace_id = $3 AND status = 'pending'
         RETURNING ${PROOF_COLS}`,
        [
          proofId,
          projectId,
          workspaceId,
          fields.verifiedAt,
          fields.observedTxtSha256,
          JSON.stringify(fields.resolverMetadata),
        ],
      );
      if (res.rows[0]) return toProof(res.rows[0]);
      const exists = await exec.query(
        'SELECT 1 FROM dns_proofs WHERE id = $1 AND project_id = $2 AND workspace_id = $3',
        [proofId, projectId, workspaceId],
      );
      return (exists.rowCount ?? 0) > 0 ? 'not-pending' : 'not-found';
    },

    // --- scope versions ---

    async insertScopeVersion(workspaceId, projectId, id, fields: InsertScopeVersionFields) {
      const res = await exec.query<ScopeVersionDbRow>(
        `INSERT INTO scope_versions (id, workspace_id, project_id, version, policy, policy_sha256, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
         RETURNING id, workspace_id, project_id, version, policy, policy_sha256, created_by, created_at`,
        [
          id,
          workspaceId,
          projectId,
          fields.version,
          JSON.stringify(fields.policy),
          fields.policySha256,
          fields.createdBy,
        ],
      );
      return toVersion(res.rows[0]!);
    },

    async getScopeVersion(workspaceId, projectId, versionId) {
      const res = await exec.query<ScopeVersionDbRow>(
        `SELECT id, workspace_id, project_id, version, policy, policy_sha256, created_by, created_at
         FROM scope_versions WHERE id = $1 AND project_id = $2 AND workspace_id = $3`,
        [versionId, projectId, workspaceId],
      );
      return res.rows[0] ? toVersion(res.rows[0]) : null;
    },

    async getLatestScopeVersionNumber(workspaceId, projectId) {
      const res = await exec.query<{ max: number }>(
        `SELECT COALESCE(MAX(version), 0)::int AS max FROM scope_versions
         WHERE workspace_id = $1 AND project_id = $2`,
        [workspaceId, projectId],
      );
      return res.rows[0]?.max ?? 0;
    },

    // --- grants ---

    async insertGrant(workspaceId, projectId, id, fields: InsertGrantFields) {
      const res = await exec.query<GrantDbRow>(
        `INSERT INTO authorization_grants
           (id, workspace_id, project_id, scope_version_id, dns_proof_id, created_by, authorization_basis, attestation, valid_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${GRANT_COLS}`,
        [
          id,
          workspaceId,
          projectId,
          fields.scopeVersionId,
          fields.dnsProofId,
          fields.createdBy,
          fields.authorizationBasis,
          fields.attestation,
          fields.validUntil,
        ],
      );
      return toGrant(res.rows[0]!);
    },

    async getGrant(workspaceId, projectId, grantId) {
      const res = await exec.query<GrantDbRow>(
        `SELECT ${GRANT_COLS} FROM authorization_grants
         WHERE id = $1 AND project_id = $2 AND workspace_id = $3`,
        [grantId, projectId, workspaceId],
      );
      return res.rows[0] ? toGrant(res.rows[0]) : null;
    },

    async listGrants(workspaceId, projectId) {
      const res = await exec.query<GrantDbRow>(
        `SELECT ${GRANT_COLS} FROM authorization_grants
         WHERE workspace_id = $1 AND project_id = $2
         ORDER BY created_at DESC, id DESC`,
        [workspaceId, projectId],
      );
      return res.rows.map(toGrant);
    },

    async revokeGrant(workspaceId, projectId, grantId, revokedAt) {
      const res = await exec.query<GrantDbRow>(
        `UPDATE authorization_grants
         SET status = 'revoked', revoked_at = $4, policy_epoch = policy_epoch + 1, updated_at = now()
         WHERE id = $1 AND project_id = $2 AND workspace_id = $3 AND status <> 'revoked'
         RETURNING ${GRANT_COLS}`,
        [grantId, projectId, workspaceId, revokedAt],
      );
      if (res.rows[0]) return toGrant(res.rows[0]);
      const exists = await exec.query(
        'SELECT 1 FROM authorization_grants WHERE id = $1 AND project_id = $2 AND workspace_id = $3',
        [grantId, projectId, workspaceId],
      );
      return (exists.rowCount ?? 0) > 0 ? 'already-revoked' : 'not-found';
    },

    async getActiveGrantForProject(workspaceId, projectId, now) {
      const res = await exec.query<GrantDbRow>(
        `SELECT ${GRANT_COLS} FROM authorization_grants
         WHERE workspace_id = $1 AND project_id = $2 AND status = 'active'
           AND (valid_until IS NULL OR valid_until > $3)
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [workspaceId, projectId, now],
      );
      return res.rows[0] ? toGrant(res.rows[0]) : null;
    },
  };
}
