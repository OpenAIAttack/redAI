/**
 * Request parsing/validation for the runs plugin. Bodies are validated against the
 * canonical `@redai/contracts` schemas (runtime Ajv, no TypeScript casts): the
 * create-run body is `api.RunCreate`. A structural `BodyValidationError` is mapped to
 * a 422 envelope by the plugin. Query parsing (pagination) mirrors the projects
 * plugin's approach.
 */
import { parseRunCreate, ContractValidationError } from '@redai/contracts';
import type { RunCreate } from '@redai/contracts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export class BodyValidationError extends Error {
  public constructor(public readonly detail: string) {
    super(detail);
    this.name = 'BodyValidationError';
  }
}

/** Validate the create-run body against `api.RunCreate`. */
export function parseCreateRun(body: unknown): RunCreate {
  try {
    return parseRunCreate(body);
  } catch (err) {
    if (err instanceof ContractValidationError) throw new BodyValidationError(err.message);
    throw err;
  }
}

export interface PageParams {
  limit?: number;
  cursor?: string;
}

/** Parse `?limit=&cursor=` from the query, ignoring malformed values (defaults apply). */
export function parsePageQuery(query: unknown): PageParams {
  const out: PageParams = {};
  if (typeof query !== 'object' || query === null) return out;
  const q = query as Record<string, unknown>;
  const limitRaw = q['limit'];
  if (typeof limitRaw === 'string' && /^[0-9]+$/.test(limitRaw)) {
    const n = Number.parseInt(limitRaw, 10);
    if (n > 0) out.limit = n;
  } else if (typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0) {
    out.limit = Math.floor(limitRaw);
  }
  const cursorRaw = q['cursor'];
  if (typeof cursorRaw === 'string' && cursorRaw !== '') out.cursor = cursorRaw;
  return out;
}
