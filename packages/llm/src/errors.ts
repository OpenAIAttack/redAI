/**
 * Typed model-gateway failures. Every error carries a stable `code` (mapped to the
 * HTTP/UI error envelope by the runtime), a `retryable` hint, and NEVER embeds an
 * API key, credential, Authorization header or prompt payload in its message —
 * messages are safe to log (docs/11 §5, §8; AGENTS "no secret in log").
 *
 * Mapping to the taxonomy is explicit here (no vendor SDK), so there are no hidden
 * unbounded retries: the caller/adapter decides what to do with each `code`.
 */

export type LlmErrorCode =
  | 'LLM_TIMEOUT'
  | 'LLM_CANCELED'
  | 'LLM_RATE_LIMITED'
  | 'LLM_AUTH'
  | 'LLM_BAD_REQUEST'
  | 'LLM_SERVER'
  | 'LLM_NETWORK'
  | 'LLM_PROTOCOL'
  | 'LLM_DATA_MODE'
  | 'LLM_NO_PROVIDER'
  | 'LLM_CAPABILITY'
  | 'LLM_CONFIG';

export class LlmError extends Error {
  /** Marker for cross-package detection without importing the class. */
  public readonly isLlmError = true as const;
  public readonly code: LlmErrorCode;
  /** True when a *bounded, explicit* retry could succeed (429, 5xx, network). */
  public readonly retryable: boolean;
  /** Upstream HTTP status when the failure came from a provider response. */
  public readonly status?: number;

  public constructor(
    code: LlmErrorCode,
    message: string,
    options: { retryable?: boolean; status?: number } = {},
  ) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.status !== undefined) this.status = options.status;
  }
}

/** Type guard usable across package boundaries. */
export function isLlmError(err: unknown): err is LlmError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { isLlmError?: unknown }).isLlmError === true &&
    typeof (err as { code?: unknown }).code === 'string'
  );
}

/** The request-level timeout fired before a response completed. Retryable. */
export class LlmTimeoutError extends LlmError {
  public constructor(message = 'Model request timed out.') {
    super('LLM_TIMEOUT', message, { retryable: true });
    this.name = 'LlmTimeoutError';
  }
}

/** The caller's AbortSignal aborted the request/stream. NOT retryable (user intent). */
export class LlmCanceledError extends LlmError {
  public constructor(message = 'Model request was canceled.') {
    super('LLM_CANCELED', message, { retryable: false });
    this.name = 'LlmCanceledError';
  }
}

/** Provider returned 429. Retryable; `retryAfterMs` echoes Retry-After when present. */
export class LlmRateLimitedError extends LlmError {
  public readonly retryAfterMs?: number;
  public constructor(retryAfterMs?: number, message = 'Model provider rate limited the request.') {
    super('LLM_RATE_LIMITED', message, { retryable: true, status: 429 });
    this.name = 'LlmRateLimitedError';
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

/** Provider rejected credentials (401/403). Not retryable without owner action. */
export class LlmAuthError extends LlmError {
  public constructor(status: number, message = 'Model provider rejected the credentials.') {
    super('LLM_AUTH', message, { retryable: false, status });
    this.name = 'LlmAuthError';
  }
}

/** Provider rejected the request shape (400/422). Not retryable as-is. */
export class LlmBadRequestError extends LlmError {
  public constructor(status: number, message = 'Model provider rejected the request.') {
    super('LLM_BAD_REQUEST', message, { retryable: false, status });
    this.name = 'LlmBadRequestError';
  }
}

/** Provider 5xx. Retryable with an explicit, bounded policy. */
export class LlmServerError extends LlmError {
  public constructor(status: number, message = 'Model provider returned a server error.') {
    super('LLM_SERVER', message, { retryable: true, status });
    this.name = 'LlmServerError';
  }
}

/** Transport failure before/around a response (DNS, connection reset). Retryable. */
export class LlmNetworkError extends LlmError {
  public constructor(message = 'Model provider is unreachable.') {
    super('LLM_NETWORK', message, { retryable: true });
    this.name = 'LlmNetworkError';
  }
}

/**
 * The response could not be understood: malformed JSON body, malformed tool-call
 * arguments, a stream that ended mid-frame, or a duplicate/conflicting tool-call
 * index. Not retryable (the same bytes will fail again).
 */
export class LlmProtocolError extends LlmError {
  public constructor(message = 'Model provider returned a malformed response.') {
    super('LLM_PROTOCOL', message, { retryable: false });
    this.name = 'LlmProtocolError';
  }
}

/**
 * A `local_only` (or otherwise mismatched) request would have to leave the
 * installation via a cloud adapter. Fail closed — there is NO cloud fallback in
 * `local_only` (docs/11 §3, §9). Never retryable.
 */
export class LlmDataModeError extends LlmError {
  public constructor(message = 'Request data mode is not permitted for this provider.') {
    super('LLM_DATA_MODE', message, { retryable: false });
    this.name = 'LlmDataModeError';
  }
}

/** No provider (primary or fallback) is eligible for the requested data mode. */
export class LlmNoProviderError extends LlmError {
  public constructor(message = 'No eligible model provider for this data mode.') {
    super('LLM_NO_PROVIDER', message, { retryable: false });
    this.name = 'LlmNoProviderError';
  }
}

/**
 * An Agent run requires tool calling but the provider does not support it. The
 * system must NOT fall back to parsing tools out of prose (docs/11 §2) — reject.
 */
export class LlmCapabilityError extends LlmError {
  public constructor(message = 'Provider lacks a capability required for this run.') {
    super('LLM_CAPABILITY', message, { retryable: false });
    this.name = 'LlmCapabilityError';
  }
}

/** Provider was constructed with an invalid/unsafe config (e.g. non-http base URL). */
export class LlmConfigError extends LlmError {
  public constructor(message: string) {
    super('LLM_CONFIG', message, { retryable: false });
    this.name = 'LlmConfigError';
  }
}
