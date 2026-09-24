/**
 * The redAI error envelope (docs/06 §6) for the artifacts plugin. Self-contained (this
 * task must not edit shared error helpers). `details` carries only allowlisted safe
 * scalars — never a stack trace, token, host path or raw body.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type { ArtifactsError, ArtifactsErrorCode } from '@redai/application/artifacts';

const ARTIFACTS_ERROR_CODES: ReadonlySet<ArtifactsErrorCode> = new Set<ArtifactsErrorCode>([
  'ARTIFACT_NOT_FOUND',
  'PROJECT_NOT_FOUND',
  'PROJECT_NOT_ACTIVE',
  'ARTIFACT_NOT_PENDING',
  'UPLOAD_NOT_STAGED',
  'HASH_MISMATCH',
  'SIZE_EXCEEDED',
  'CONTENT_NOT_READY',
  'MEDIA_TYPE_MISMATCH',
  'PREVIEW_UNSUPPORTED',
  'STORAGE_IO',
]);

/** Structural guard for a use-case {@link ArtifactsError} (no runtime class import). */
export function isArtifactsError(err: unknown): err is ArtifactsError {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; httpStatus?: unknown; message?: unknown };
  return (
    typeof e.code === 'string' &&
    typeof e.httpStatus === 'number' &&
    typeof e.message === 'string' &&
    ARTIFACTS_ERROR_CODES.has(e.code as ArtifactsErrorCode)
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

export function sendArtifactsError(reply: FastifyReply, err: ArtifactsError): FastifyReply {
  return sendError(reply, err.httpStatus, err.code, err.message, {
    retryable: err.code === 'STORAGE_IO',
  });
}
