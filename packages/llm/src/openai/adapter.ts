/**
 * OpenAI-compatible Chat Completions adapter over Node 22's global `fetch`. There is
 * deliberately NO vendor SDK, so there are no hidden unbounded retries or background
 * connections: every {@link generate} is exactly one round-trip unless an EXPLICIT,
 * bounded retry policy is configured, and the request timeout is enforced here with
 * an AbortController the caller can see (docs/11 §1; AGENTS "Không dùng retry của
 * thư viện HTTP để chạy lại hiệu ứng không rõ kết quả").
 *
 * It consumes a RESOLVED api key / base url handed in at construction — it never
 * reads settings or a secret store, and never logs the key, an Authorization header
 * or a prompt body (docs/11 §5, §8).
 */
import {
  LlmAuthError,
  LlmBadRequestError,
  LlmCanceledError,
  LlmConfigError,
  LlmNetworkError,
  LlmProtocolError,
  LlmRateLimitedError,
  LlmServerError,
  LlmTimeoutError,
} from '../errors.js';
import { StreamAssembler } from '../assemble.js';
import { buildChatCompletionsBody, chatCompletionToEvents, streamChunkToEvents } from '../wire.js';
import type {
  GenerateRequest,
  GenerateResult,
  ModelProvider,
  ProviderCapabilities,
  ProviderInfo,
  StreamEvent,
} from '../types.js';

/** Minimal `fetch` shape (injectable for tests; defaults to the Node global). */
export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<Response>;

/** Explicit, bounded retry policy. Default: NO retries (attempts = 1). */
export interface RetryPolicy {
  /** Total attempts including the first. `1` means no retry. */
  maxAttempts: number;
  /** Fixed backoff between attempts, in ms. */
  backoffMs: number;
}

export interface OpenAiCompatibleOptions {
  /** Base URL of the compatible endpoint, e.g. `https://host/v1` (owner-configured). */
  baseUrl: string;
  /** RESOLVED api key (from T05 `resolveCredential`); used only for the auth header. */
  apiKey?: string;
  /** Model id sent in the request body. */
  model: string;
  /** Human-facing provider label for provenance. */
  label: string;
  /** Declared capabilities (usually the probe result). */
  capabilities?: Partial<ProviderCapabilities>;
  /** Per-request timeout. Default 60s. */
  timeoutMs?: number;
  /** Explicit retry policy. Default: no retries. */
  retry?: RetryPolicy;
  /** Extra static headers (never used to smuggle secrets into logs). */
  headers?: Record<string, string>;
  /** Injected fetch (defaults to `globalThis.fetch`). */
  fetch?: FetchLike;
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  text: true,
  tools: true,
  streaming: true,
  structuredOutput: true,
  vision: false,
};

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) ? Math.max(0, seconds) * 1000 : undefined;
}

export class OpenAiCompatibleProvider implements ModelProvider {
  public readonly info: ProviderInfo;
  private readonly url: string;
  private readonly apiKey: string | undefined;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly retry: RetryPolicy;
  private readonly extraHeaders: Record<string, string>;
  private readonly fetchImpl: FetchLike;

  public constructor(options: OpenAiCompatibleOptions) {
    let parsed: URL;
    try {
      parsed = new URL(options.baseUrl);
    } catch {
      throw new LlmConfigError('provider base URL is not a valid URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new LlmConfigError('provider base URL must be http(s)');
    }
    this.url = joinUrl(options.baseUrl, 'chat/completions');
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.retry = options.retry ?? { maxAttempts: 1, backoffMs: 0 };
    this.extraHeaders = options.headers ?? {};
    const injected = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!injected) throw new LlmConfigError('no fetch implementation available');
    this.fetchImpl = injected;
    this.info = {
      kind: 'openai_compatible',
      label: options.label,
      isMock: false,
      capabilities: { ...DEFAULT_CAPABILITIES, ...options.capabilities },
    };
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      ...this.extraHeaders,
    };
    if (this.apiKey !== undefined) headers['authorization'] = `Bearer ${this.apiKey}`;
    return headers;
  }

  /**
   * Perform one HTTP round-trip with a combined timeout + caller-cancel signal.
   * Distinguishes caller cancellation (LLM_CANCELED) from a fired timeout
   * (LLM_TIMEOUT) from a transport failure (LLM_NETWORK).
   */
  private async fetchOnce(body: string, callerSignal: AbortSignal | undefined): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    try {
      return await this.fetchImpl(this.url, {
        method: 'POST',
        headers: this.headers(),
        body,
        signal,
      });
    } catch (err) {
      if (callerSignal?.aborted) throw new LlmCanceledError();
      if (timeout.aborted) throw new LlmTimeoutError();
      throw new LlmNetworkError(err instanceof Error ? `transport error: ${err.name}` : undefined);
    }
  }

  /** Map a non-2xx response to a typed error. Body text is read but never key data. */
  private async errorForStatus(res: Response): Promise<never> {
    // Drain the body so the socket can be reused; ignore its content for the message.
    await res.text().catch(() => undefined);
    const status = res.status;
    if (status === 429)
      throw new LlmRateLimitedError(parseRetryAfter(res.headers.get('retry-after')));
    if (status === 401 || status === 403) throw new LlmAuthError(status);
    if (status >= 500) throw new LlmServerError(status);
    throw new LlmBadRequestError(status);
  }

  private async attempt<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let i = 0; i < this.retry.maxAttempts; i += 1) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const retryable =
          typeof err === 'object' &&
          err !== null &&
          (err as { retryable?: unknown }).retryable === true;
        if (!retryable || i === this.retry.maxAttempts - 1) throw err;
        if (this.retry.backoffMs > 0) await new Promise((r) => setTimeout(r, this.retry.backoffMs));
      }
    }
    throw lastError;
  }

  public async generate(request: GenerateRequest): Promise<GenerateResult> {
    if (request.stream) {
      return this.assembleFromStream(request);
    }
    return this.attempt(async () => {
      const body = JSON.stringify(
        buildChatCompletionsBody(request, { model: this.model, stream: false }),
      );
      const res = await this.fetchOnce(body, request.signal);
      if (!res.ok) await this.errorForStatus(res);
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new LlmProtocolError('response body was not valid JSON');
      }
      const assembler = new StreamAssembler();
      for (const event of chatCompletionToEvents(json)) assembler.push(event);
      return assembler.finalize({ isMock: false, providerLabel: this.info.label });
    });
  }

  private async assembleFromStream(request: GenerateRequest): Promise<GenerateResult> {
    const assembler = new StreamAssembler();
    for await (const event of this.stream(request)) assembler.push(event);
    return assembler.finalize({ isMock: false, providerLabel: this.info.label });
  }

  public async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    // Streaming does not go through the explicit-retry wrapper: a partially consumed
    // SSE response cannot be safely replayed, so a stream failure is surfaced as-is.
    const body = JSON.stringify(
      buildChatCompletionsBody(request, { model: this.model, stream: true }),
    );
    const res = await this.fetchOnce(body, request.signal);
    if (!res.ok) await this.errorForStatus(res);
    if (!res.body) throw new LlmProtocolError('streaming response had no body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;

    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (request.signal?.aborted) throw new LlmCanceledError();
          throw new LlmNetworkError(
            err instanceof Error ? `stream read error: ${err.name}` : undefined,
          );
        }
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });

        let newline: number;
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          if (line === '' || line.startsWith(':')) continue;
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            done = true;
            continue;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            throw new LlmProtocolError('malformed SSE data frame');
          }
          for (const event of streamChunkToEvents(parsed)) yield event;
        }
        if (request.signal?.aborted) throw new LlmCanceledError();
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    // A non-empty leftover buffer means the connection closed mid-frame.
    if (!done && buffer.trim() !== '') {
      throw new LlmProtocolError('stream ended mid-frame');
    }
  }
}
