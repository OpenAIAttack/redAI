/**
 * Browser API client for the redAI control-plane.
 *
 * Design:
 *  - Same-origin by default (`NEXT_PUBLIC_API_BASE_URL` may override for a split
 *    dev origin). Requests always send credentials so the `__Host-`/session cookie
 *    rides along; the cookie is HttpOnly and never read here.
 *  - CSRF double-submit: the API returns a `csrf_token` in the session profile and
 *    also sets a readable CSRF cookie. For every state-changing request we send the
 *    token back in the `x-csrf-token` header. We read it from the cookie (set by the
 *    API) and fall back to a value cached in memory from the last session fetch.
 *  - No secret is ever persisted to localStorage (docs/AGENTS product rules).
 *  - Errors surface as a typed `ApiError` carrying the envelope `code` so screens
 *    can render precise states (invalid credentials, rate limited, conflict, ...).
 */
import type { ApiErrorBody } from './types';

const BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? '';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    opts: {
      retryable?: boolean;
      details?: Record<string, unknown>;
      retryAfterSeconds?: number;
    } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

/** In-memory CSRF token, refreshed by every session fetch (never persisted). */
let csrfTokenMemory: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfTokenMemory = token;
}

function readCsrfCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const cookies = document.cookie ? document.cookie.split('; ') : [];
  for (const entry of cookies) {
    const eq = entry.indexOf('=');
    if (eq === -1) continue;
    const name = entry.slice(0, eq);
    // The API names the CSRF cookie `csrf_token` (or `__Host-csrf_token` on HTTPS).
    if (name === 'csrf_token' || name === '__Host-csrf_token') {
      return decodeURIComponent(entry.slice(eq + 1));
    }
  }
  return null;
}

function currentCsrf(): string | null {
  return readCsrfCookie() ?? csrfTokenMemory;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions {
  method?: Method;
  body?: unknown;
  /** Raw bytes for octet-stream uploads (artifacts). */
  rawBody?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

async function parseError(res: Response): Promise<ApiError> {
  let code = `HTTP_${res.status}`;
  let message = res.statusText || 'Request failed';
  let retryable = false;
  let details: Record<string, unknown> | undefined;
  try {
    const body = (await res.json()) as ApiErrorBody;
    if (body.error) {
      if (body.error.code) code = body.error.code;
      if (body.error.message) message = body.error.message;
      retryable = body.error.retryable ?? false;
      details = body.error.details;
    }
  } catch {
    // Non-JSON error body; keep defaults.
  }
  const retryAfter = res.headers.get('retry-after');
  return new ApiError(res.status, code, message, {
    retryable,
    ...(details ? { details } : {}),
    ...(retryAfter ? { retryAfterSeconds: Number(retryAfter) } : {}),
  });
}

export async function apiRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { ...opts.headers };
  const isMutation = method !== 'GET';

  let body: BodyInit | undefined;
  if (opts.rawBody !== undefined) {
    body = opts.rawBody;
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }

  if (isMutation) {
    const token = currentCsrf();
    if (token) headers['x-csrf-token'] = token;
  }

  const init: RequestInit = {
    method,
    credentials: 'include',
    headers,
  };
  if (body !== undefined) init.body = body;
  if (opts.signal) init.signal = opts.signal;

  const res = await fetch(`${BASE}${path}`, init);

  if (!res.ok) throw await parseError(res);

  if (res.status === 204) return undefined as T;
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return (await res.json()) as T;
  }
  return undefined as T;
}
