/**
 * The redAI error envelope (docs/06 §6) for the events plugin — the pre-stream error
 * replies (401 unauthenticated, 400 bad/future cursor or filter). Once the response
 * has switched to `text/event-stream`, in-band problems are signalled as SSE
 * `stream.resync` frames instead (see `sse.ts`), never as an HTTP error.
 *
 * Self-contained so this task does not edit another plugin's shared error helper.
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

export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  details?: Record<string, string | number | boolean>,
): FastifyReply {
  const body: ErrorBody = {
    error: {
      code,
      message,
      request_id: randomUUID(),
      retryable: false,
      ...(details ? { details } : {}),
    },
  };
  return reply.code(status).send(body);
}
