/**
 * The redAI error envelope (docs/06 §6) for the projects plugin. Kept self-contained
 * (this task must not edit the shared auth error helper). `details` carries only
 * allowlisted safe scalars — never a stack trace, token or raw body.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyReply } from 'fastify';
// Type-only import from the application projects source. The coordinator re-exports
// these through the `@redai/application` barrel; this task must not edit that barrel,
// and `import type` is erased at runtime so nothing here depends on the wiring order.
import type {
  ProjectsError,
  ProjectsErrorCode,
} from '../../../../packages/application/src/projects/index.js';

/**
 * The full set of use-case error codes. Used to structurally recognise a thrown
 * {@link ProjectsError} without importing its class at runtime (the class lives
 * behind the not-yet-wired package barrel; `import type` alone is erased).
 */
const PROJECTS_ERROR_CODES: ReadonlySet<ProjectsErrorCode> = new Set<ProjectsErrorCode>([
  'PROJECT_NOT_FOUND',
  'CHAT_NOT_FOUND',
  'NOTE_NOT_FOUND',
  'WORKER_NOT_FOUND',
  'BINDING_NOT_FOUND',
  'REVISION_CONFLICT',
  'INBOX_PROTECTED',
  'INBOX_EXISTS',
  'PROJECT_NOT_ACTIVE',
  'PROJECT_HAS_ACTIVE_RUN',
  'CHAT_HAS_ACTIVE_RUN',
  'NAME_CONFIRMATION_MISMATCH',
  'INVALID_STATE_TRANSITION',
]);

/** Structural guard for a use-case {@link ProjectsError} (no runtime class import). */
export function isProjectsError(err: unknown): err is ProjectsError {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; httpStatus?: unknown; message?: unknown };
  return (
    typeof e.code === 'string' &&
    typeof e.httpStatus === 'number' &&
    typeof e.message === 'string' &&
    PROJECTS_ERROR_CODES.has(e.code as ProjectsErrorCode)
  );
}

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    request_id: string;
    retryable: boolean;
    details?: Record<string, string | number | boolean>;
  };
}

export interface SendErrorOptions {
  retryable?: boolean;
  details?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
}

export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  opts: SendErrorOptions = {},
): FastifyReply {
  const body: ErrorBody = {
    error: {
      code,
      message,
      request_id: randomUUID(),
      retryable: opts.retryable ?? false,
      ...(opts.details ? { details: opts.details } : {}),
    },
  };
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) reply.header(k, v);
  }
  return reply.code(status).send(body);
}

/**
 * Map a typed {@link ProjectsError} from the use-case layer onto the envelope,
 * preserving its stable `code` and HTTP status. A REVISION_CONFLICT additionally
 * surfaces the expected/current revisions so the client can re-read and retry.
 */
export function sendProjectsError(reply: FastifyReply, err: ProjectsError): FastifyReply {
  const details: Record<string, string | number | boolean> = {};
  if (err.code === 'REVISION_CONFLICT') {
    const conflict = err as ProjectsError & { expected?: string; current?: string };
    if (typeof conflict.expected === 'string') details['expected_revision'] = conflict.expected;
    if (typeof conflict.current === 'string') details['current_revision'] = conflict.current;
  }
  return sendError(reply, err.httpStatus, err.code, err.message, {
    retryable: err.code === 'REVISION_CONFLICT',
    ...(Object.keys(details).length > 0 ? { details } : {}),
  });
}
