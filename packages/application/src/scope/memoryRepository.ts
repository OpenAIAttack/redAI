/**
 * In-memory {@link ScopeRepository} for the service unit tests. It mirrors the DB
 * adapter's SEMANTICS — project-scoped filtering on the composite key, one-time verify
 * (pending → verified guard), immutable scope versions, the revoke epoch bump, and the
 * "most recent active unexpired grant" selection — without a database. The DB
 * adapter's own live-PG test proves the SQL matches these semantics.
 */
import {
  type DnsProofRecord,
  type GrantRecord,
  type InsertDnsProofFields,
  type InsertGrantFields,
  type InsertScopeVersionFields,
  type MarkProofVerifiedFields,
  type ScopeRepository,
  type ScopeVersionRecord,
} from './ports.js';

interface Clocklike {
  now(): Date;
}

export class InMemoryScopeRepository implements ScopeRepository {
  private proofs = new Map<string, DnsProofRecord>();
  private versions = new Map<string, ScopeVersionRecord>();
  private grants = new Map<string, GrantRecord>();
  private seq = 0;

  public constructor(private readonly clock: Clocklike) {}

  private tick(): Date {
    this.seq += 1;
    return new Date(this.clock.now().getTime() + this.seq);
  }

  private static key(workspaceId: string, projectId: string, id: string): string {
    return `${workspaceId}:${projectId}:${id}`;
  }

  // --- DNS proofs ---

  async insertDnsProof(
    workspaceId: string,
    projectId: string,
    id: string,
    fields: InsertDnsProofFields,
  ): Promise<DnsProofRecord> {
    const now = this.tick();
    const rec: DnsProofRecord = {
      id,
      workspaceId,
      projectId,
      rootAscii: fields.rootAscii,
      recordName: fields.recordName,
      challengeHash: Buffer.from(fields.challengeHash),
      expiresAt: fields.expiresAt,
      status: 'pending',
      verifiedAt: null,
      observedTxtSha256: null,
      resolverMetadata: null,
      createdAt: now,
      updatedAt: now,
    };
    this.proofs.set(InMemoryScopeRepository.key(workspaceId, projectId, id), { ...rec });
    return { ...rec, challengeHash: Buffer.from(rec.challengeHash) };
  }

  async getDnsProof(
    workspaceId: string,
    projectId: string,
    proofId: string,
  ): Promise<DnsProofRecord | null> {
    const rec = this.proofs.get(InMemoryScopeRepository.key(workspaceId, projectId, proofId));
    return rec ? { ...rec, challengeHash: Buffer.from(rec.challengeHash) } : null;
  }

  async listDnsProofs(workspaceId: string, projectId: string): Promise<DnsProofRecord[]> {
    return [...this.proofs.values()]
      .filter((p) => p.workspaceId === workspaceId && p.projectId === projectId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((p) => ({ ...p, challengeHash: Buffer.from(p.challengeHash) }));
  }

  async findVerifiedProofForRoot(
    workspaceId: string,
    projectId: string,
    rootAscii: string,
  ): Promise<DnsProofRecord | null> {
    const now = this.clock.now().getTime();
    const found = [...this.proofs.values()]
      .filter(
        (p) =>
          p.workspaceId === workspaceId &&
          p.projectId === projectId &&
          p.rootAscii === rootAscii &&
          p.status === 'verified' &&
          p.expiresAt.getTime() > now,
      )
      .sort((a, b) => (b.verifiedAt?.getTime() ?? 0) - (a.verifiedAt?.getTime() ?? 0))[0];
    return found ? { ...found, challengeHash: Buffer.from(found.challengeHash) } : null;
  }

  async markProofVerified(
    workspaceId: string,
    projectId: string,
    proofId: string,
    fields: MarkProofVerifiedFields,
  ): Promise<DnsProofRecord | 'not-found' | 'not-pending'> {
    const k = InMemoryScopeRepository.key(workspaceId, projectId, proofId);
    const rec = this.proofs.get(k);
    if (!rec) return 'not-found';
    if (rec.status !== 'pending') return 'not-pending';
    const updated: DnsProofRecord = {
      ...rec,
      status: 'verified',
      verifiedAt: fields.verifiedAt,
      observedTxtSha256: fields.observedTxtSha256,
      resolverMetadata: fields.resolverMetadata,
      updatedAt: this.tick(),
    };
    this.proofs.set(k, updated);
    return { ...updated, challengeHash: Buffer.from(updated.challengeHash) };
  }

  // --- scope versions ---

  async insertScopeVersion(
    workspaceId: string,
    projectId: string,
    id: string,
    fields: InsertScopeVersionFields,
  ): Promise<ScopeVersionRecord> {
    const rec: ScopeVersionRecord = {
      id,
      workspaceId,
      projectId,
      version: fields.version,
      policy: fields.policy,
      policySha256: fields.policySha256,
      createdBy: fields.createdBy,
      createdAt: this.tick(),
    };
    this.versions.set(InMemoryScopeRepository.key(workspaceId, projectId, id), rec);
    return rec;
  }

  async getScopeVersion(
    workspaceId: string,
    projectId: string,
    versionId: string,
  ): Promise<ScopeVersionRecord | null> {
    return (
      this.versions.get(InMemoryScopeRepository.key(workspaceId, projectId, versionId)) ?? null
    );
  }

  async getLatestScopeVersionNumber(workspaceId: string, projectId: string): Promise<number> {
    return [...this.versions.values()]
      .filter((v) => v.workspaceId === workspaceId && v.projectId === projectId)
      .reduce((max, v) => Math.max(max, v.version), 0);
  }

  // --- grants ---

  async insertGrant(
    workspaceId: string,
    projectId: string,
    id: string,
    fields: InsertGrantFields,
  ): Promise<GrantRecord> {
    const now = this.tick();
    const rec: GrantRecord = {
      id,
      workspaceId,
      projectId,
      scopeVersionId: fields.scopeVersionId,
      dnsProofId: fields.dnsProofId,
      createdBy: fields.createdBy,
      authorizationBasis: fields.authorizationBasis,
      attestation: fields.attestation,
      status: 'active',
      policyEpoch: '1',
      validUntil: fields.validUntil,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.grants.set(InMemoryScopeRepository.key(workspaceId, projectId, id), rec);
    return { ...rec };
  }

  async getGrant(
    workspaceId: string,
    projectId: string,
    grantId: string,
  ): Promise<GrantRecord | null> {
    const rec = this.grants.get(InMemoryScopeRepository.key(workspaceId, projectId, grantId));
    return rec ? { ...rec } : null;
  }

  async listGrants(workspaceId: string, projectId: string): Promise<GrantRecord[]> {
    return [...this.grants.values()]
      .filter((g) => g.workspaceId === workspaceId && g.projectId === projectId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((g) => ({ ...g }));
  }

  async revokeGrant(
    workspaceId: string,
    projectId: string,
    grantId: string,
    revokedAt: Date,
  ): Promise<GrantRecord | 'not-found' | 'already-revoked'> {
    const k = InMemoryScopeRepository.key(workspaceId, projectId, grantId);
    const rec = this.grants.get(k);
    if (!rec) return 'not-found';
    if (rec.status === 'revoked') return 'already-revoked';
    const updated: GrantRecord = {
      ...rec,
      status: 'revoked',
      revokedAt,
      policyEpoch: (BigInt(rec.policyEpoch) + 1n).toString(),
      updatedAt: this.tick(),
    };
    this.grants.set(k, updated);
    return { ...updated };
  }

  async getActiveGrantForProject(
    workspaceId: string,
    projectId: string,
    now: Date,
  ): Promise<GrantRecord | null> {
    const t = now.getTime();
    const found = [...this.grants.values()]
      .filter(
        (g) =>
          g.workspaceId === workspaceId &&
          g.projectId === projectId &&
          g.status === 'active' &&
          (g.validUntil === null || g.validUntil.getTime() > t),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return found ? { ...found } : null;
  }
}

/** A scripted {@link DnsResolver} for unit tests: maps record names to TXT values. */
export class StaticDnsResolver {
  public readonly id: string;
  private readonly records: Map<string, string[]>;
  public constructor(records: Record<string, string[]> = {}, id = 'static-test-resolver') {
    this.id = id;
    this.records = new Map(Object.entries(records));
  }
  set(name: string, values: string[]): void {
    this.records.set(name, values);
  }
  async resolveTxt(name: string): Promise<string[]> {
    return this.records.get(name) ?? [];
  }
}
