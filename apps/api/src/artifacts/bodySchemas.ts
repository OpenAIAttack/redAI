/**
 * Boundary validation for the artifact request bodies and path/header params. Real
 * JSON-Schema validation with Ajv (AGENTS.md: never a TS cast at the trust boundary).
 * These sub-schemas mirror `ArtifactCreate` / `ArtifactFinalize` in
 * `contracts/schemas/api.schema.json`; this task must not edit `packages/contracts`, so
 * they are compiled locally with the same Ajv the other plugins use.
 */
import { createRequire } from 'node:module';
import type { ValidateFunction } from 'ajv';

const nodeRequire = createRequire(import.meta.url);
const { default: Ajv } = nodeRequire('ajv') as typeof import('ajv');

const CLASSIFICATIONS = ['public', 'internal', 'sensitive', 'restricted'] as const;
/** SPEC_LOCK.defaults.upload_max_bytes. */
const UPLOAD_MAX_BYTES = 26_214_400;
const SHA256 = { type: 'string', pattern: '^[a-f0-9]{64}$' } as const;
const BYTE_SIZE = { type: 'integer', minimum: 0, maximum: UPLOAD_MAX_BYTES } as const;

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

export interface CreateArtifactBody {
  filename: string;
  media_type: string;
  byte_size: number;
  sha256: string;
  classification: (typeof CLASSIFICATIONS)[number];
}
export const parseCreateArtifact = compile<CreateArtifactBody>({
  type: 'object',
  properties: {
    filename: { type: 'string', minLength: 1, maxLength: 255 },
    media_type: { type: 'string', minLength: 1, maxLength: 120 },
    byte_size: BYTE_SIZE,
    sha256: SHA256,
    classification: { type: 'string', enum: [...CLASSIFICATIONS] },
  },
  required: ['filename', 'media_type', 'byte_size', 'sha256', 'classification'],
  additionalProperties: false,
});

export interface FinalizeArtifactBody {
  sha256: string;
  byte_size: number;
}
export const parseFinalizeArtifact = compile<FinalizeArtifactBody>({
  type: 'object',
  properties: {
    sha256: SHA256,
    byte_size: BYTE_SIZE,
  },
  required: ['sha256', 'byte_size'],
  additionalProperties: false,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(value: string | undefined): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export interface PageParams {
  limit?: number;
  cursor?: string;
}
export function parsePageQuery(query: unknown): PageParams {
  const q = (query ?? {}) as Record<string, unknown>;
  const out: PageParams = {};
  if (typeof q['limit'] === 'string' && q['limit'] !== '') {
    const n = Number(q['limit']);
    if (Number.isFinite(n)) out.limit = Math.trunc(n);
  }
  if (typeof q['cursor'] === 'string' && q['cursor'] !== '') out.cursor = q['cursor'];
  return out;
}

/** The contract requires an Idempotency-Key on the mutating artifact routes. */
export function readIdempotencyKey(headers: Record<string, unknown>): string | null {
  const v = headers['idempotency-key'];
  if (typeof v !== 'string' || v.length === 0 || v.length > 200) return null;
  return v;
}

/** Strip any path/quote/control characters so a filename is safe in a header. */
export function sanitizeFilename(name: string): string {
  const base = name
    .replace(/[/\\]/g, '_')
    // eslint-disable-next-line no-control-regex -- deliberately stripping control chars
    .replace(/[\u0000-\u001f"]/g, '')
    .trim();
  return base.length > 0 ? base.slice(0, 255) : 'download';
}
