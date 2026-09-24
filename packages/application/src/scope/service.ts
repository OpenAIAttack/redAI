/**
 * DNS-proof + scope-version + authorization-grant use cases (T12).
 *
 * Authorization is proven, not asserted by the model (docs/16 TH01): a one-time DNS
 * challenge proves control of a root; an owner attestation + a scope version become an
 * authorization grant. Scope versions are IMMUTABLE — broadening authors a NEW version
 * (and a new grant), it never mutates an existing one, so an in-flight Run keeps the
 * scope it snapshotted (docs/10 §2/§3). Revocation bumps the grant's policy epoch and
 * takes effect immediately: a revoked grant retains NO permission, and dispatch
 * re-reads the LIVE grant + epoch on every effect (docs/10 §7).
 *
 * Pure orchestration over injected collaborators (repository, clock, randomness, DNS
 * resolver); it opens no sockets itself and reads no globals, so unit tests drive it
 * with an in-memory fake and a scripted resolver. Owner-only authority (INV-011) is
 * enforced by the API layer's owner guard; this service does not authenticate.
 */
import { createHash } from 'node:crypto';
import { ContractValidationError, parseScope, type Scope } from '@redai/contracts';
import { isPublicSuffix, normalizeHost } from '@redai/policy';
import { cryptoRandom, hashToken, systemClock } from '../auth/crypto.js';
import {
  DnsProofExpiredError,
  DnsProofMismatchError,
  DnsProofNotFoundError,
  DnsProofNotPendingError,
  GrantAlreadyRevokedError,
  GrantNotFoundError,
  GrantProofRequiredError,
  GrantProofScopeMismatchError,
  InvalidRootError,
  InvalidScopeError,
  LabAttestationMisuseError,
  PublicSuffixRootError,
  ScopeVersionNotFoundError,
} from './errors.js';
import type {
  AuthorizationBasis,
  Clock,
  DnsProofRecord,
  DnsResolver,
  GrantRecord,
  LiveGrantStatus,
  RandomSource,
  ScopeRepository,
  ScopeVersionRecord,
} from './ports.js';

/** Challenge token entropy (bytes). 32 bytes = 256 bits (docs/10 §3). */
export const CHALLENGE_TOKEN_BYTES = 32;
/** Challenge TTL: 24 hours (docs/10 §3). */
export const CHALLENGE_TTL_MS = 24 * 60 * 60 * 1000;
/** The challenge record label prefix (docs/10 §3). */
export const CHALLENGE_LABEL = '_redai-challenge';

export interface ScopeServiceDeps {
  repo: ScopeRepository;
  clock?: Clock;
  random?: RandomSource;
}

export interface IssueChallengeResult {
  proof: DnsProofRecord;
  /** The DNS record name the owner must create. */
  recordName: string;
  /**
   * The opaque challenge value to publish as the TXT value. Returned ONCE at issue
   * time and NEVER persisted (only its SHA-256 is stored); it is not a secret but is
   * treated as write-once so it cannot be read back from the DB.
   */
  challengeValue: string;
  expiresAt: Date;
}

export interface CreateGrantInput {
  scopeVersionId: string;
  authorizationBasis: AuthorizationBasis;
  attestation: string;
  dnsProofId?: string | undefined;
  validUntil?: Date | undefined;
}

/** Stable, deterministic JSON serialization for the policy digest (sorted keys). */
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`).join(',')}}`;
}

function policyDigest(policy: Scope): string {
  return createHash('sha256').update(canonicalStringify(policy), 'utf8').digest('hex');
}

/** True when `host` is the root itself or a strict descendant of it. */
function hostCoveredByRoot(host: string, root: string): boolean {
  const h = normalizeHost(host);
  const r = normalizeHost(root);
  if (!h || !r) return false;
  return h === r || h.endsWith(`.${r}`);
}

/** A rule is a lab rule when it declares explicit private-zone IP ranges. */
function isLabRule(rule: Scope['rules'][number]): boolean {
  return Array.isArray(rule.lab_ip_ranges) && rule.lab_ip_ranges.length > 0;
}

export class ScopeService {
  private readonly repo: ScopeRepository;
  private readonly clock: Clock;
  private readonly random: RandomSource;

  public constructor(deps: ScopeServiceDeps) {
    this.repo = deps.repo;
    this.clock = deps.clock ?? systemClock;
    this.random = deps.random ?? cryptoRandom;
  }

  // -------------------------------------------------------------- DNS proof

  /**
   * Issue a one-time DNS challenge for `root`. The raw token is returned once and only
   * its SHA-256 is stored; the record name is `_redai-challenge.<root>`.
   */
  async issueDnsChallenge(
    workspaceId: string,
    projectId: string,
    input: { root: string },
  ): Promise<IssueChallengeResult> {
    const root = normalizeHost(input.root);
    if (!root) throw new InvalidRootError();
    if (isPublicSuffix(root)) throw new PublicSuffixRootError();

    const token = this.random.token(CHALLENGE_TOKEN_BYTES);
    const challengeHash = hashToken(token);
    const recordName = `${CHALLENGE_LABEL}.${root}`;
    const expiresAt = new Date(this.clock.now().getTime() + CHALLENGE_TTL_MS);

    const proof = await this.repo.insertDnsProof(workspaceId, projectId, this.random.uuid(), {
      rootAscii: root,
      recordName,
      challengeHash,
      expiresAt,
    });
    return { proof, recordName, challengeValue: token, expiresAt };
  }

  async listDnsProofs(workspaceId: string, projectId: string): Promise<DnsProofRecord[]> {
    return this.repo.listDnsProofs(workspaceId, projectId);
  }

  /**
   * Verify a pending challenge by reading its TXT record from a TRUSTED resolver (never
   * the target's HTTP). Idempotent: a proof already verified is returned unchanged, and
   * a second Chat in the same Project reuses it rather than re-verifying (docs/10 §1).
   */
  async verifyDnsChallenge(
    workspaceId: string,
    projectId: string,
    proofId: string,
    resolver: DnsResolver,
  ): Promise<DnsProofRecord> {
    const proof = await this.repo.getDnsProof(workspaceId, projectId, proofId);
    if (!proof) throw new DnsProofNotFoundError();
    if (proof.status === 'verified') return proof; // idempotent — no re-verify
    if (proof.status !== 'pending') throw new DnsProofNotPendingError();
    if (proof.expiresAt.getTime() <= this.clock.now().getTime()) throw new DnsProofExpiredError();

    const observed = await resolver.resolveTxt(proof.recordName);
    const matched = observed.find((txt) => hashToken(txt).equals(proof.challengeHash));
    if (matched === undefined) throw new DnsProofMismatchError();

    const observedTxtSha256 = createHash('sha256').update(matched, 'utf8').digest('hex');
    const result = await this.repo.markProofVerified(workspaceId, projectId, proofId, {
      verifiedAt: this.clock.now(),
      observedTxtSha256,
      resolverMetadata: {
        resolver: resolver.id,
        queried_name: proof.recordName,
        answers: observed.length,
      },
    });
    if (result === 'not-found') throw new DnsProofNotFoundError();
    if (result === 'not-pending') {
      // A concurrent verify won; return the now-verified record.
      const reread = await this.repo.getDnsProof(workspaceId, projectId, proofId);
      if (reread && reread.status === 'verified') return reread;
      throw new DnsProofNotPendingError();
    }
    return result;
  }

  // ---------------------------------------------------------- scope version

  /**
   * Author an IMMUTABLE scope version. The scope is contract-validated; the next
   * version number is assigned server-side. There is intentionally no update path —
   * broadening authors a new version (see {@link broadenScope}).
   */
  async authorScopeVersion(
    workspaceId: string,
    projectId: string,
    ownerId: string,
    rawScope: unknown,
  ): Promise<ScopeVersionRecord> {
    let policy: Scope;
    try {
      policy = parseScope(rawScope);
    } catch (err) {
      if (err instanceof ContractValidationError) throw new InvalidScopeError(err.message);
      throw err;
    }
    const latest = await this.repo.getLatestScopeVersionNumber(workspaceId, projectId);
    return this.repo.insertScopeVersion(workspaceId, projectId, this.random.uuid(), {
      version: latest + 1,
      policy,
      policySha256: policyDigest(policy),
      createdBy: ownerId,
    });
  }

  /** Broadening is a NEW version + NEW grant, never an in-place edit (docs/10 §2). */
  async broadenScope(
    workspaceId: string,
    projectId: string,
    ownerId: string,
    rawScope: unknown,
    grant: Omit<CreateGrantInput, 'scopeVersionId'>,
  ): Promise<{ scopeVersion: ScopeVersionRecord; grant: GrantRecord }> {
    const scopeVersion = await this.authorScopeVersion(workspaceId, projectId, ownerId, rawScope);
    const created = await this.createGrant(workspaceId, projectId, ownerId, {
      ...grant,
      scopeVersionId: scopeVersion.id,
    });
    return { scopeVersion, grant: created };
  }

  async getScopeVersion(
    workspaceId: string,
    projectId: string,
    versionId: string,
  ): Promise<ScopeVersionRecord> {
    const row = await this.repo.getScopeVersion(workspaceId, projectId, versionId);
    if (!row) throw new ScopeVersionNotFoundError();
    return row;
  }

  // ------------------------------------------------------------------ grant

  /**
   * Create an authorization grant over an immutable scope version. Enforces the
   * authorization basis (docs/10 §3): `lab_attestation` is for explicit private-zone
   * lab rules only (no DNS proof, no public hosts); a public-host grant requires a
   * VERIFIED DNS proof whose root covers every authored public host.
   */
  async createGrant(
    workspaceId: string,
    projectId: string,
    ownerId: string,
    input: CreateGrantInput,
  ): Promise<GrantRecord> {
    const version = await this.repo.getScopeVersion(workspaceId, projectId, input.scopeVersionId);
    if (!version) throw new ScopeVersionNotFoundError();

    const rules = version.policy.rules;
    const publicRules = rules.filter((r) => !isLabRule(r));

    let dnsProofIdToStore: string | null = null;

    if (input.authorizationBasis === 'lab_attestation') {
      if (input.dnsProofId) {
        throw new LabAttestationMisuseError('lab_attestation must not carry a DNS proof.');
      }
      if (publicRules.length > 0) {
        throw new LabAttestationMisuseError('lab_attestation cannot authorize public hosts.');
      }
    } else {
      // owner_attestation | written_authorization
      if (publicRules.length > 0) {
        if (!input.dnsProofId) throw new GrantProofRequiredError();
        const proof = await this.repo.getDnsProof(workspaceId, projectId, input.dnsProofId);
        if (!proof || proof.status !== 'verified') throw new GrantProofRequiredError();
        for (const rule of publicRules) {
          if (!hostCoveredByRoot(rule.host, proof.rootAscii)) {
            throw new GrantProofScopeMismatchError();
          }
        }
        dnsProofIdToStore = proof.id;
      } else if (input.dnsProofId) {
        // Lab-only scope may still reference a verified proof; validate it exists.
        const proof = await this.repo.getDnsProof(workspaceId, projectId, input.dnsProofId);
        if (!proof || proof.status !== 'verified') throw new GrantProofRequiredError();
        dnsProofIdToStore = proof.id;
      }
    }

    return this.repo.insertGrant(workspaceId, projectId, this.random.uuid(), {
      scopeVersionId: input.scopeVersionId,
      dnsProofId: dnsProofIdToStore,
      createdBy: ownerId,
      authorizationBasis: input.authorizationBasis,
      attestation: input.attestation,
      validUntil: input.validUntil ?? null,
    });
  }

  async getGrant(workspaceId: string, projectId: string, grantId: string): Promise<GrantRecord> {
    const row = await this.repo.getGrant(workspaceId, projectId, grantId);
    if (!row) throw new GrantNotFoundError();
    return row;
  }

  async listGrants(workspaceId: string, projectId: string): Promise<GrantRecord[]> {
    return this.repo.listGrants(workspaceId, projectId);
  }

  /**
   * Revoke a grant: bump its policy epoch and set `revoked_at` (docs/10 §7). Takes
   * effect immediately — a revoked grant retains no permission. Idempotent.
   */
  async revokeGrant(workspaceId: string, projectId: string, grantId: string): Promise<GrantRecord> {
    const result = await this.repo.revokeGrant(workspaceId, projectId, grantId, this.clock.now());
    if (result === 'not-found') throw new GrantNotFoundError();
    if (result === 'already-revoked') {
      const current = await this.repo.getGrant(workspaceId, projectId, grantId);
      if (current) return current;
      throw new GrantAlreadyRevokedError();
    }
    return result;
  }

  /**
   * The LIVE grant status read the dispatcher performs on every effect (docs/10 §4/§7):
   * applies revoke and `valid_until` against the current clock, so a run that
   * snapshotted an active grant cannot keep acting once it is revoked or expired.
   */
  async resolveGrantStatusForDispatch(
    workspaceId: string,
    projectId: string,
    grantId: string,
  ): Promise<LiveGrantStatus> {
    const grant = await this.repo.getGrant(workspaceId, projectId, grantId);
    if (!grant) throw new GrantNotFoundError();
    const now = this.clock.now();
    let effectiveStatus = grant.status;
    if (
      grant.status === 'active' &&
      grant.validUntil &&
      grant.validUntil.getTime() <= now.getTime()
    ) {
      effectiveStatus = 'expired';
    }
    return {
      grantId: grant.id,
      effectiveStatus,
      policyEpoch: grant.policyEpoch,
      scopeVersionId: grant.scopeVersionId,
      validUntil: grant.validUntil,
    };
  }

  /**
   * The active authorization for a Project (grant + its scope version), or null. A
   * second Chat in the same Project reads THIS rather than issuing a new DNS proof
   * (docs/10 §1) — the grant is inherited.
   */
  async getProjectAuthorization(
    workspaceId: string,
    projectId: string,
  ): Promise<{ grant: GrantRecord; scopeVersion: ScopeVersionRecord } | null> {
    const grant = await this.repo.getActiveGrantForProject(
      workspaceId,
      projectId,
      this.clock.now(),
    );
    if (!grant) return null;
    const scopeVersion = await this.repo.getScopeVersion(
      workspaceId,
      projectId,
      grant.scopeVersionId,
    );
    if (!scopeVersion) return null;
    return { grant, scopeVersion };
  }
}
