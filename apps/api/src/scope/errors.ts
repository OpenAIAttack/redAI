/**
 * The redAI error envelope for the scope plugin. Self-contained (this task must not
 * edit shared helpers). A thrown scope use-case error is recognised STRUCTURALLY by
 * its `code`/`httpStatus` so the plugin needs no runtime import of the not-yet-wired
 * `@redai/application/scope` barrel. `details` carries only safe scalars — never a
 * token, TXT value or stack trace.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyReply } from 'fastify';

/** The scope use-case error codes (mirrors `@redai/application/scope` ScopeErrorCode). */
const SCOPE_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  'INVALID_ROOT',
  'PUBLIC_SUFFIX_ROOT',
  'DNS_PROOF_NOT_FOUND',
  'DNS_PROOF_EXPIRED',
  'DNS_PROOF_NOT_PENDING',
  'DNS_PROOF_MISMATCH',
  'INVALID_SCOPE',
  'SCOPE_VERSION_NOT_FOUND',
  'GRANT_NOT_FOUND',
  'GRANT_PROOF_REQUIRED',
  'GRANT_PROOF_SCOPE_MISMATCH',
  'LAB_ATTESTATION_MISUSE',
  'GRANT_ALREADY_REVOKED',
]);

export interface ScopeErrorShape {
  code: string;
  httpStatus: number;
  message: string;
}

export function isScopeError(err: unknown): err is ScopeErrorShape {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; httpStatus?: unknown; message?: unknown };
  return (
    typeof e.code === 'string' &&
    typeof e.httpStatus === 'number' &&
    typeof e.message === 'string' &&
    SCOPE_ERROR_CODES.has(e.code)
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
  return reply.code(status).send(body);
}

export function sendScopeError(reply: FastifyReply, err: ScopeErrorShape): FastifyReply {
  return sendError(reply, err.httpStatus, err.code, err.message);
}
