/**
 * Boundary validation for the scope plugin request bodies. The authored SCOPE is
 * validated with the canonical `@redai/contracts` `parseScope` (no TS cast at the
 * trust boundary, AGENTS.md); the small envelope bodies (root, grant metadata) are
 * validated with the same local Ajv the projects plugin uses. Untrusted input is
 * never trusted through a cast.
 */
import { createRequire } from 'node:module';
import type { ValidateFunction } from 'ajv';
import { ContractValidationError, type Scope, parseScope } from '@redai/contracts';

const nodeRequire = createRequire(import.meta.url);
const { default: Ajv } = nodeRequire('ajv') as typeof import('ajv');

const ajv = new Ajv({ strict: true, allErrors: true, coerceTypes: false });

export class BodyValidationError extends Error {
  public readonly detail: string;
  public constructor(detail: string) {
    super(`invalid request body: ${detail}`);
    this.name = 'BodyValidationError';
    this.detail = detail;
  }
}

function compile<T>(schema: Record<string, unknown>): (body: unknown) => T {
  const validate: ValidateFunction = ajv.compile(schema);
  return (body: unknown): T => {
    if (validate(body) !== true) {
      const detail = (validate.errors ?? [])
        .map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}`)
        .join('; ');
      throw new BodyValidationError(detail || 'unknown error');
    }
    return body as T;
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(value: string | undefined): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

// A UUID sub-schema by PATTERN (no ajv-formats dependency), matching UUID_RE above.
const UUID_PATTERN = {
  type: 'string',
  pattern:
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$',
} as const;

// --- DNS challenge ---

export interface IssueChallengeBody {
  root: string;
}
export const parseIssueChallenge = compile<IssueChallengeBody>({
  type: 'object',
  properties: { root: { type: 'string', minLength: 1, maxLength: 253 } },
  required: ['root'],
  additionalProperties: false,
});

// --- scope version ---

export interface AuthorScopeVersionBody {
  policy: Scope;
}
/**
 * Validate the scope-version body: the `policy` field must be a schema-valid Scope
 * (validated by the canonical contract validator, not a local copy).
 */
export function parseAuthorScopeVersion(body: unknown): AuthorScopeVersionBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BodyValidationError('(root) must be an object with a policy');
  }
  const keys = Object.keys(body as Record<string, unknown>);
  if (!keys.every((k) => k === 'policy')) {
    throw new BodyValidationError('(root) only { policy } is allowed');
  }
  const policy = (body as { policy?: unknown }).policy;
  try {
    return { policy: parseScope(policy) };
  } catch (err) {
    if (err instanceof ContractValidationError) throw new BodyValidationError(err.message);
    throw err;
  }
}

// --- grant ---

const AUTH_BASES = ['owner_attestation', 'written_authorization', 'lab_attestation'] as const;

export interface CreateGrantBody {
  scope_version_id: string;
  authorization_basis: (typeof AUTH_BASES)[number];
  attestation: string;
  dns_proof_id?: string;
  valid_until?: string;
}
export const parseCreateGrant = compile<CreateGrantBody>({
  type: 'object',
  properties: {
    scope_version_id: UUID_PATTERN,
    authorization_basis: { type: 'string', enum: [...AUTH_BASES] },
    attestation: { type: 'string', minLength: 1, maxLength: 4000 },
    dns_proof_id: UUID_PATTERN,
    valid_until: { type: 'string', minLength: 1, maxLength: 40 },
  },
  required: ['scope_version_id', 'authorization_basis', 'attestation'],
  additionalProperties: false,
});
