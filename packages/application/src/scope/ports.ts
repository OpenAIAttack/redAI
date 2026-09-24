/**
 * Ports for the DNS-proof + scope-version + authorization-grant use cases (T12).
 *
 * Records are DB-shape-neutral (camelCase); no `pg` / `@redai/db` type leaks across
 * this boundary. Time and randomness sit behind tiny interfaces so unit tests drive a
 * deterministic clock and scripted tokens/UUIDs. Every read and write is scoped by
 * `workspaceId` + `projectId` — a request scoped to project A must never touch
 * project B (INV-001), enforced by the composite `(id, project_id, workspace_id)` keys.
 */
import type { Scope } from '@redai/contracts';

export interface Clock {
  now(): Date;
}

/** Cryptographic randomness: a UUID for primary keys and an opaque high-entropy token. */
export interface RandomSource {
  uuid(): string;
  /** A URL-safe random token; `byteLength` defaults to 32 (256 bits, docs/10 §3). */
  token(byteLength?: number): string;
}

/**
 * A TRUSTED DNS resolver. The proof MUST come from DNS, never from the target's own
 * HTTP response (docs/10 §3). Production injects a resolver backed by a trusted
 * recursive resolver with bounded timeouts/retries; tests inject a scripted fake.
 */
export interface DnsResolver {
  /** Resolve TXT records for `name`, returning each record's concatenated value. */
  resolveTxt(name: string): Promise<string[]>;
  /** A stable, secret-free identifier of the resolver, stored in proof metadata. */
  readonly id: string;
}

export type DnsProofStatus = 'pending' | 'verified' | 'expired' | 'revoked';
export type GrantStatus = 'active' | 'revoked' | 'expired';
export type AuthorizationBasis = 'owner_attestation' | 'written_authorization' | 'lab_attestation';

export interface DnsProofRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  rootAscii: string;
  recordName: string;
  /** SHA-256 of the challenge token (stored as `bytea`; never the raw token). */
  challengeHash: Buffer;
  expiresAt: Date;
  status: DnsProofStatus;
  verifiedAt: Date | null;
  observedTxtSha256: string | null;
  resolverMetadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScopeVersionRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  version: number;
  policy: Scope;
  policySha256: string;
  createdBy: string;
  createdAt: Date;
}

export interface GrantRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  scopeVersionId: string;
  dnsProofId: string | null;
  createdBy: string;
  authorizationBasis: AuthorizationBasis;
  attestation: string;
  status: GrantStatus;
  /** bigint transmitted as a decimal string; bumped on revoke (docs/10 §7). */
  policyEpoch: string;
  validUntil: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A LIVE grant status read performed at dispatch time (docs/10 §4/§7): the dispatcher
 * re-reads the grant and its epoch on every effect, so a revoked/expired grant retains
 * no permission even if a run snapshotted it while active.
 */
export interface LiveGrantStatus {
  grantId: string;
  /** The effective status after applying revoke and `valid_until` against `now`. */
  effectiveStatus: GrantStatus;
  policyEpoch: string;
  scopeVersionId: string;
  validUntil: Date | null;
}

export interface InsertDnsProofFields {
  rootAscii: string;
  recordName: string;
  challengeHash: Buffer;
  expiresAt: Date;
}

export interface MarkProofVerifiedFields {
  verifiedAt: Date;
  observedTxtSha256: string;
  resolverMetadata: Record<string, unknown>;
}

export interface InsertScopeVersionFields {
  version: number;
  policy: Scope;
  policySha256: string;
  createdBy: string;
}

export interface InsertGrantFields {
  scopeVersionId: string;
  dnsProofId: string | null;
  createdBy: string;
  authorizationBasis: AuthorizationBasis;
  attestation: string;
  validUntil: Date | null;
}

export interface ScopeRepository {
  // --- DNS proofs ---
  insertDnsProof(
    workspaceId: string,
    projectId: string,
    id: string,
    fields: InsertDnsProofFields,
  ): Promise<DnsProofRecord>;
  getDnsProof(
    workspaceId: string,
    projectId: string,
    proofId: string,
  ): Promise<DnsProofRecord | null>;
  listDnsProofs(workspaceId: string, projectId: string): Promise<DnsProofRecord[]>;
  /**
   * The newest VERIFIED, unexpired proof for a root — the reason a second Chat in the
   * same Project does NOT re-verify (docs/10 §1: one grant is inherited).
   */
  findVerifiedProofForRoot(
    workspaceId: string,
    projectId: string,
    rootAscii: string,
  ): Promise<DnsProofRecord | null>;
  /**
   * Atomically flip a proof pending → verified. Returns `'not-pending'` when a
   * concurrent verify already won, so the caller never double-verifies.
   */
  markProofVerified(
    workspaceId: string,
    projectId: string,
    proofId: string,
    fields: MarkProofVerifiedFields,
  ): Promise<DnsProofRecord | 'not-found' | 'not-pending'>;

  // --- scope versions (immutable) ---
  insertScopeVersion(
    workspaceId: string,
    projectId: string,
    id: string,
    fields: InsertScopeVersionFields,
  ): Promise<ScopeVersionRecord>;
  getScopeVersion(
    workspaceId: string,
    projectId: string,
    versionId: string,
  ): Promise<ScopeVersionRecord | null>;
  getLatestScopeVersionNumber(workspaceId: string, projectId: string): Promise<number>;

  // --- grants ---
  insertGrant(
    workspaceId: string,
    projectId: string,
    id: string,
    fields: InsertGrantFields,
  ): Promise<GrantRecord>;
  getGrant(workspaceId: string, projectId: string, grantId: string): Promise<GrantRecord | null>;
  listGrants(workspaceId: string, projectId: string): Promise<GrantRecord[]>;
  /** Revoke + epoch bump in one statement. `'already-revoked'` is idempotent success. */
  revokeGrant(
    workspaceId: string,
    projectId: string,
    grantId: string,
    revokedAt: Date,
  ): Promise<GrantRecord | 'not-found' | 'already-revoked'>;
  /** The most recent grant that is active AND unexpired at `now`, or null. */
  getActiveGrantForProject(
    workspaceId: string,
    projectId: string,
    now: Date,
  ): Promise<GrantRecord | null>;
}
