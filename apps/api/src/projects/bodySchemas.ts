/**
 * Boundary validation for the projects/chats/notes/bindings request bodies and
 * query/params. Real JSON-Schema validation with Ajv (AGENTS.md: never a TS cast at
 * the trust boundary). These sub-schemas mirror the resource shapes in
 * `contracts/schemas/api.schema.json`; this task must not edit `packages/contracts`,
 * so they are compiled locally here with the same Ajv the auth plugin uses.
 */
import { createRequire } from 'node:module';
import type { ValidateFunction } from 'ajv';

const nodeRequire = createRequire(import.meta.url);
const { default: Ajv } = nodeRequire('ajv') as typeof import('ajv');

const APPROVAL_MODES = ['automatic', 'always_ask', 'ask_high_risk', 'reject'] as const;
const DATA_MODES = ['local_only', 'redacted_cloud', 'cloud_full'] as const;

/** A bigint revision transmitted as a positive integer (docs/05: bounded, safe < 2^53). */
const REVISION = { type: 'integer', minimum: 1 } as const;

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

// --- projects ---

export interface CreateProjectBody {
  name: string;
  description?: string;
  approval_mode?: (typeof APPROVAL_MODES)[number];
  data_mode?: (typeof DATA_MODES)[number];
}
export const parseCreateProject = compile<CreateProjectBody>({
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', maxLength: 4000 },
    approval_mode: { type: 'string', enum: [...APPROVAL_MODES] },
    data_mode: { type: 'string', enum: [...DATA_MODES] },
  },
  required: ['name'],
  additionalProperties: false,
});

export interface UpdateProjectBody {
  expected_revision: number;
  name?: string;
  description?: string;
  approval_mode?: (typeof APPROVAL_MODES)[number];
  data_mode?: (typeof DATA_MODES)[number];
}
export const parseUpdateProject = compile<UpdateProjectBody>({
  type: 'object',
  properties: {
    expected_revision: REVISION,
    name: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', maxLength: 4000 },
    approval_mode: { type: 'string', enum: [...APPROVAL_MODES] },
    data_mode: { type: 'string', enum: [...DATA_MODES] },
  },
  required: ['expected_revision'],
  additionalProperties: false,
});

export interface DeleteProjectBody {
  confirm_name: string;
}
export const parseDeleteProject = compile<DeleteProjectBody>({
  type: 'object',
  properties: { confirm_name: { type: 'string', minLength: 1, maxLength: 120 } },
  required: ['confirm_name'],
  additionalProperties: false,
});

// --- chats ---

export interface CreateChatBody {
  title?: string;
  pinned?: boolean;
}
export const parseCreateChat = compile<CreateChatBody>({
  type: 'object',
  properties: {
    title: { type: 'string', maxLength: 200 },
    pinned: { type: 'boolean' },
  },
  required: [],
  additionalProperties: false,
});

export interface UpdateChatBody {
  expected_revision: number;
  title?: string;
  pinned?: boolean;
}
export const parseUpdateChat = compile<UpdateChatBody>({
  type: 'object',
  properties: {
    expected_revision: REVISION,
    title: { type: 'string', maxLength: 200 },
    pinned: { type: 'boolean' },
  },
  required: ['expected_revision'],
  additionalProperties: false,
});

// --- notes ---

export interface CreateNoteBody {
  title: string;
  content: string;
  selected_for_context?: boolean;
}
export const parseCreateNote = compile<CreateNoteBody>({
  type: 'object',
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 200 },
    content: { type: 'string', maxLength: 100000 },
    selected_for_context: { type: 'boolean' },
  },
  required: ['title', 'content'],
  additionalProperties: false,
});

export interface UpdateNoteBody {
  expected_revision: number;
  title?: string;
  content?: string;
  selected_for_context?: boolean;
}
export const parseUpdateNote = compile<UpdateNoteBody>({
  type: 'object',
  properties: {
    expected_revision: REVISION,
    title: { type: 'string', minLength: 1, maxLength: 200 },
    content: { type: 'string', maxLength: 100000 },
    selected_for_context: { type: 'boolean' },
  },
  required: ['expected_revision'],
  additionalProperties: false,
});

// --- bindings ---

export interface UpsertBindingBody {
  zone: string;
  enabled?: boolean;
}
export const parseUpsertBinding = compile<UpsertBindingBody>({
  type: 'object',
  properties: {
    zone: { type: 'string', minLength: 1, maxLength: 200 },
    enabled: { type: 'boolean' },
  },
  required: ['zone'],
  additionalProperties: false,
});

// --- query + path params ---

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A path id must be a syntactically valid UUID; anything else cannot name a row. */
export function isUuid(value: string | undefined): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export interface PageParams {
  limit?: number;
  cursor?: string;
}

/** Parse `?limit=&cursor=` defensively; malformed values fall back to defaults. */
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

/** Parse `?selected=true` for the notes list (context-only view). */
export function parseSelectedOnly(query: unknown): boolean {
  const q = (query ?? {}) as Record<string, unknown>;
  return q['selected'] === 'true' || q['selected'] === '1';
}
