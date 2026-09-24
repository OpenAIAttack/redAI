/**
 * The redAI error envelope (docs/06 §6) for the runs plugin. Self-contained (this
 * task must not edit the shared auth error helper). Typed use-case errors from
 * `@redai/application/messages` are recognised STRUCTURALLY (no runtime class import,
 * which would depend on the not-yet-wired package barrel) and mapped onto the envelope
 * preserving their stable `code` + HTTP status.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type { MessagesError, MessagesErrorCode } from '@redai/application/messages';

const MESSAGES_ERROR_CODES: ReadonlySet<MessagesErrorCode> = new Set<MessagesErrorCode>([
  'PROJECT_NOT_FOUND',
  'CHAT_NOT_FOUND',
  'RUN_NOT_FOUND',
  'PROVIDER_CONFIG_NOT_FOUND',
  'CHAT_HAS_ACTIVE_RUN',
  'IDEMPOTENCY_CONFLICT',
  'REQUEST_IN_PROGRESS',
  'INVALID_BODY',
]);

export function isMessagesError(err: unknown): err is MessagesError {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; httpStatus?: unknown; message?: unknown };
  return (
    typeof e.code === 'string' &&
    typeof e.httpStatus === 'number' &&
    typeof e.message === 'string' &&
    MESSAGES_ERROR_CODES.has(e.code as MessagesErrorCode)
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

export function sendMessagesError(reply: FastifyReply, err: MessagesError): FastifyReply {
  const retryable = err.code === 'REQUEST_IN_PROGRESS';
  return sendError(reply, err.httpStatus, err.code, err.message, { retryable });
}
