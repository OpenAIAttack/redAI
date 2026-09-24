/**
 * Self-contained Fastify plugin for DNS proofs, scope versions and authorization
 * grants (T12). `registerScope(app, deps)` mounts the owner-only routes under
 * `/api/v1`. The owner-auth guard, the CSRF/Origin check and the trusted DNS resolver
 * are INJECTED, so this plugin imports no server internals and — deliberately — no
 * `@redai/application/scope` (the coordinator wires that subpath). The scope SERVICE is
 * injected too, typed by a local structural interface, exactly like the projects
 * plugin takes `ProjectsService`.
 *
 * Every route is scoped by the authenticated `workspaceId` and the `:projectId` path
 * segment; the use-case layer filters on the composite keys so a foreign id resolves
 * to 404, never a cross-project read (INV-001). Authority lives outside the model: only
 * these owner-authenticated routes create a version/grant (docs/10 §2, INV-011).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isScopeError, sendError, sendScopeError } from './errors.js';
import {
  BodyValidationError,
  isUuid,
  parseAuthorScopeVersion,
  parseCreateGrant,
  parseIssueChallenge,
} from './bodySchemas.js';

export interface OwnerContext {
  workspaceId: string;
  ownerId: string;
}

type AuthorizationBasis = 'owner_attestation' | 'written_authorization' | 'lab_attestation';

// --- structural views of the records the plugin serializes (no application import) ---

export interface DnsProofView {
  id: string;
  workspaceId: string;
  projectId: string;
  rootAscii: string;
  recordName: string;
  expiresAt: Date;
  status: string;
  verifiedAt: Date | null;
  observedTxtSha256: string | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface IssueChallengeView {
  proof: DnsProofView;
  recordName: string;
  challengeValue: string;
  expiresAt: Date;
}
export interface ScopeVersionView {
  id: string;
  workspaceId: string;
  projectId: string;
  version: number;
  policy: unknown;
  policySha256: string;
  createdBy: string;
  createdAt: Date;
}
export interface GrantView {
  id: string;
  workspaceId: string;
  projectId: string;
  scopeVersionId: string;
  dnsProofId: string | null;
  createdBy: string;
  authorizationBasis: string;
  attestation: string;
  status: string;
  policyEpoch: string;
  validUntil: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A trusted DNS resolver (docs/10 §3), injected by the coordinator. */
export interface InjectedDnsResolver {
  resolveTxt(name: string): Promise<string[]>;
  readonly id: string;
}

/** The subset of `ScopeService` the routes call (structural — see index.ts note). */
export interface ScopePluginService {
  issueDnsChallenge(
    workspaceId: string,
    projectId: string,
    input: { root: string },
  ): Promise<IssueChallengeView>;
  listDnsProofs(workspaceId: string, projectId: string): Promise<DnsProofView[]>;
  verifyDnsChallenge(
    workspaceId: string,
    projectId: string,
    proofId: string,
    resolver: InjectedDnsResolver,
  ): Promise<DnsProofView>;
  authorScopeVersion(
    workspaceId: string,
    projectId: string,
    ownerId: string,
    rawScope: unknown,
  ): Promise<ScopeVersionView>;
  createGrant(
    workspaceId: string,
    projectId: string,
    ownerId: string,
    input: {
      scopeVersionId: string;
      authorizationBasis: AuthorizationBasis;
      attestation: string;
      dnsProofId?: string;
      validUntil?: Date;
    },
  ): Promise<GrantView>;
  listGrants(workspaceId: string, projectId: string): Promise<GrantView[]>;
  revokeGrant(workspaceId: string, projectId: string, grantId: string): Promise<GrantView>;
}

export interface ScopePluginDeps {
  service: ScopePluginService;
  authenticate: (req: FastifyRequest) => Promise<OwnerContext | null>;
  authorizeMutation?: (req: FastifyRequest, ctx: OwnerContext) => boolean;
  /** Trusted DNS resolver used to verify a challenge (never the target's HTTP). */
  resolver: InjectedDnsResolver;
}

const ownerContexts = new WeakMap<FastifyRequest, OwnerContext>();

function toProofDto(p: DnsProofView): Record<string, unknown> {
  return {
    id: p.id,
    workspace_id: p.workspaceId,
    project_id: p.projectId,
    root_ascii: p.rootAscii,
    record_name: p.recordName,
    status: p.status,
    expires_at: p.expiresAt.toISOString(),
    verified_at: p.verifiedAt ? p.verifiedAt.toISOString() : null,
    observed_txt_sha256: p.observedTxtSha256,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
  };
}

function toScopeVersionDto(v: ScopeVersionView): Record<string, unknown> {
  return {
    id: v.id,
    workspace_id: v.workspaceId,
    project_id: v.projectId,
    version: v.version,
    policy: v.policy,
    policy_sha256: v.policySha256,
    created_by: v.createdBy,
    created_at: v.createdAt.toISOString(),
  };
}

function toGrantDto(g: GrantView): Record<string, unknown> {
  return {
    id: g.id,
    workspace_id: g.workspaceId,
    project_id: g.projectId,
    scope_version_id: g.scopeVersionId,
    dns_proof_id: g.dnsProofId,
    created_by: g.createdBy,
    authorization_basis: g.authorizationBasis,
    attestation: g.attestation,
    status: g.status,
    policy_epoch: g.policyEpoch,
    valid_until: g.validUntil ? g.validUntil.toISOString() : null,
    revoked_at: g.revokedAt ? g.revokedAt.toISOString() : null,
    created_at: g.createdAt.toISOString(),
    updated_at: g.updatedAt.toISOString(),
  };
}

export function registerScope(app: FastifyInstance, deps: ScopePluginDeps): void {
  const { service, resolver } = deps;
  const authorizeMutation = deps.authorizeMutation ?? (() => true);

  const requireOwner = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const ctx = await deps.authenticate(req);
    if (!ctx) {
      await sendError(reply, 401, 'UNAUTHENTICATED', 'No valid owner session.');
      return;
    }
    ownerContexts.set(req, ctx);
  };

  const requireOwnerMutation = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const ctx = await deps.authenticate(req);
    if (!ctx) {
      await sendError(reply, 401, 'UNAUTHENTICATED', 'No valid owner session.');
      return;
    }
    if (!authorizeMutation(req, ctx)) {
      await sendError(reply, 403, 'CSRF_INVALID', 'Missing or invalid CSRF/Origin.');
      return;
    }
    ownerContexts.set(req, ctx);
  };

  const owner = (req: FastifyRequest): OwnerContext => {
    const ctx = ownerContexts.get(req);
    if (!ctx) throw new Error('owner context missing after guard');
    return ctx;
  };

  const handle = async (
    reply: FastifyReply,
    fn: () => Promise<FastifyReply>,
  ): Promise<FastifyReply> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof BodyValidationError) {
        return sendError(reply, 422, 'INVALID_BODY', 'Invalid request body.', {
          details: { reason: err.detail },
        });
      }
      if (isScopeError(err)) return sendScopeError(reply, err);
      throw err;
    }
  };

  const readGuard = { preHandler: requireOwner };
  const writeGuard = { preHandler: requireOwnerMutation };

  // ------------------------------------------------------------ DNS proofs

  app.post('/api/v1/projects/:projectId/dns-challenges', writeGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const { projectId } = req.params as { projectId: string };
      if (!isUuid(projectId))
        return sendError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found.');
      const body = parseIssueChallenge(req.body);
      const out = await service.issueDnsChallenge(workspaceId, projectId, { root: body.root });
      // The challenge value is returned ONCE for the owner to publish as TXT.
      return reply.code(201).send({
        ...toProofDto(out.proof),
        record_name: out.recordName,
        challenge_value: out.challengeValue,
        expires_at: out.expiresAt.toISOString(),
      });
    }),
  );

  app.get('/api/v1/projects/:projectId/dns-challenges', readGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const { projectId } = req.params as { projectId: string };
      if (!isUuid(projectId))
        return sendError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found.');
      const proofs = await service.listDnsProofs(workspaceId, projectId);
      return reply.code(200).send({ items: proofs.map(toProofDto) });
    }),
  );

  app.post(
    '/api/v1/projects/:projectId/dns-challenges/:proofId/verify',
    writeGuard,
    async (req, reply) =>
      handle(reply, async () => {
        const { workspaceId } = owner(req);
        const { projectId, proofId } = req.params as { projectId: string; proofId: string };
        if (!isUuid(projectId) || !isUuid(proofId))
          return sendError(reply, 404, 'DNS_PROOF_NOT_FOUND', 'DNS challenge not found.');
        const proof = await service.verifyDnsChallenge(workspaceId, projectId, proofId, resolver);
        return reply.code(200).send(toProofDto(proof));
      }),
  );

  // --------------------------------------------------------- scope versions

  app.post('/api/v1/projects/:projectId/scope-versions', writeGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId, ownerId } = owner(req);
      const { projectId } = req.params as { projectId: string };
      if (!isUuid(projectId))
        return sendError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found.');
      const body = parseAuthorScopeVersion(req.body);
      const version = await service.authorScopeVersion(
        workspaceId,
        projectId,
        ownerId,
        body.policy,
      );
      return reply.code(201).send(toScopeVersionDto(version));
    }),
  );

  // ----------------------------------------------------------------- grants

  app.post('/api/v1/projects/:projectId/grants', writeGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId, ownerId } = owner(req);
      const { projectId } = req.params as { projectId: string };
      if (!isUuid(projectId))
        return sendError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found.');
      const body = parseCreateGrant(req.body);
      let validUntil: Date | undefined;
      if (body.valid_until !== undefined) {
        const d = new Date(body.valid_until);
        if (Number.isNaN(d.getTime()))
          return sendError(reply, 422, 'INVALID_BODY', 'Invalid request body.', {
            details: { reason: 'valid_until is not a valid timestamp' },
          });
        validUntil = d;
      }
      const grant = await service.createGrant(workspaceId, projectId, ownerId, {
        scopeVersionId: body.scope_version_id,
        authorizationBasis: body.authorization_basis,
        attestation: body.attestation,
        ...(body.dns_proof_id !== undefined ? { dnsProofId: body.dns_proof_id } : {}),
        ...(validUntil !== undefined ? { validUntil } : {}),
      });
      return reply.code(201).send(toGrantDto(grant));
    }),
  );

  app.get('/api/v1/projects/:projectId/grants', readGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const { projectId } = req.params as { projectId: string };
      if (!isUuid(projectId))
        return sendError(reply, 404, 'PROJECT_NOT_FOUND', 'Project not found.');
      const grants = await service.listGrants(workspaceId, projectId);
      return reply.code(200).send({ items: grants.map(toGrantDto) });
    }),
  );

  app.post('/api/v1/projects/:projectId/grants/:grantId/revoke', writeGuard, async (req, reply) =>
    handle(reply, async () => {
      const { workspaceId } = owner(req);
      const { projectId, grantId } = req.params as { projectId: string; grantId: string };
      if (!isUuid(projectId) || !isUuid(grantId))
        return sendError(reply, 404, 'GRANT_NOT_FOUND', 'Authorization grant not found.');
      const grant = await service.revokeGrant(workspaceId, projectId, grantId);
      return reply.code(200).send(toGrantDto(grant));
    }),
  );
}
