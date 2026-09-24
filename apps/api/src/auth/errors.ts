/**
 * The redAI error envelope (docs/06 §6). `details` carries only allowlisted safe
 * keys — never a stack trace, credential, token or raw body. Auth failures use
 * generic messages so they cannot be used to enumerate accounts.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyReply } from 'fastify';

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
