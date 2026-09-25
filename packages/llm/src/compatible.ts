import { CompletionStream } from './stream.js';
import { parseResponse } from './response.js';
import {
  ProviderError,
  type DataMode,
  type ModelAdapter,
  type ModelRequest,
  type ModelResponse,
  type ModelDelta,
} from './types.js';

/** Construct from an authenticated owner config snapshot, never model or target content.
 * local_only additionally requires deployment-level DNS/egress enforcement;
 * approvedLocalBaseUrls is an exact owner allowlist, not an SSRF classifier.
 */
export interface CompatibleConfig {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
  allowedDataModes: readonly DataMode[];
  approvedLocalBaseUrls: readonly string[];
  toolsVerified: boolean;
  maxOutputTokens: number;
  timeoutMs: number;
  maxResponseBytes: number;
}

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
function normalizeBase(input: string): string {
  try {
    const url = new URL(input);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.href.replace(/\/+$/, '');
  } catch {
    throw new ProviderError('invalid_request', 'not_sent');
  }
}

export class CompatibleAdapter implements ModelAdapter {
  readonly #config: CompatibleConfig;
  readonly #base: string;
  readonly #local: boolean;
  readonly #fetch: typeof fetch;

  constructor(config: CompatibleConfig, transport: typeof fetch = fetch) {
    this.#base = normalizeBase(config.baseUrl);
    this.#local = config.approvedLocalBaseUrls.some((base) => normalizeBase(base) === this.#base);
    if (
      !config.modelId.trim() ||
      !positive(config.timeoutMs) ||
      config.timeoutMs > 2_147_483_647 ||
      !positive(config.maxResponseBytes) ||
      !positive(config.maxOutputTokens)
    ) {
      throw new ProviderError('invalid_request', 'not_sent');
    }
    if (new URL(this.#base).protocol !== 'https:' && !this.#local) {
      throw new ProviderError('policy_denied', 'not_sent');
    }
    this.#config = {
      ...config,
      allowedDataModes: [...config.allowedDataModes],
      approvedLocalBaseUrls: [...config.approvedLocalBaseUrls],
    };
    this.#fetch = transport;
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    return this.#perform(request, signal);
  }

  /** Deltas are provisional display data; only the resolved result contains validated tools. */
  async stream(
    request: ModelRequest,
    onDelta: (delta: ModelDelta) => void,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    return this.#perform(request, signal, onDelta);
  }

  async #perform(
    request: ModelRequest,
    signal?: AbortSignal,
    onDelta?: (delta: ModelDelta) => void,
  ): Promise<ModelResponse> {
    // Freeze declarations for this request while the provider is in flight.
    request = {
      ...request,
      ...(request.structuredOutput ? { structuredOutput: { ...request.structuredOutput } } : {}),
      ...(request.tools ? { tools: request.tools.map((tool) => ({ ...tool })) } : {}),
    };
    const config = this.#config;
    if (signal?.aborted) throw new ProviderError('canceled', 'not_sent');
    if (
      !config.allowedDataModes.includes(request.dataMode) ||
      (request.dataMode === 'local_only' && !this.#local)
    ) {
      throw new ProviderError('policy_denied', 'not_sent');
    }
    if (request.tools?.length && !config.toolsVerified)
      throw new ProviderError('unsupported_capability', 'not_sent');
    if (
      !positive(request.maxOutputTokens) ||
      request.maxOutputTokens > config.maxOutputTokens ||
      request.messages.length === 0
    )
      throw new ProviderError('invalid_request', 'not_sent');
    const names = new Set<string>();
    for (const tool of request.tools ?? []) {
      if (
        !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) ||
        names.has(tool.name) ||
        typeof tool.validateArguments !== 'function'
      )
        throw new ProviderError('invalid_request', 'not_sent');
      names.add(tool.name);
    }
    // Explicit projection excludes runtime metadata and credential references.
    let body: string;
    try {
      body = JSON.stringify({
        model: config.modelId,
        messages: request.messages.map(({ role, content }) => {
          if (!['system', 'user', 'assistant'].includes(role) || typeof content !== 'string')
            throw new Error();
          return { role, content };
        }),
        max_tokens: request.maxOutputTokens,
        ...(request.structuredOutput
          ? {
              response_format: {
                type: 'json_schema',
                json_schema: {
                  name: request.structuredOutput.name,
                  strict: true,
                  schema: request.structuredOutput.schema,
                },
              },
            }
          : {}),
        stream: onDelta !== undefined,
        ...(onDelta ? { stream_options: { include_usage: true } } : {}),
        ...(request.tools?.length
          ? {
              tools: request.tools.map((tool) => ({
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              })),
            }
          : {}),
      });
    } catch {
      throw new ProviderError('invalid_request', 'not_sent');
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.timeoutMs);
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      // Exactly one request; redirects cannot forward credentials to a new endpoint.
      const response = await this.#fetch(`${this.#base}/chat/completions`, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProviderError(
          response.status === 429
            ? 'rate_limited'
            : response.status === 401 || response.status === 403
              ? 'authentication'
              : 'provider_error',
          'possibly_sent',
        );
      }
      if (!response.body) throw new ProviderError('invalid_response', 'possibly_sent');
      if (
        onDelta &&
        response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
          'text/event-stream'
      ) {
        await response.body.cancel();
        throw new ProviderError('invalid_response', 'possibly_sent');
      }
      const stream = onDelta ? new CompletionStream(request, onDelta) : undefined;
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const reader = response.body.getReader();
      const abortReader = () => {
        void reader.cancel().catch(() => undefined);
      };
      controller.signal.addEventListener('abort', abortReader, { once: true });
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          if (controller.signal.aborted) break;
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > config.maxResponseBytes)
            throw new ProviderError('response_too_large', 'possibly_sent');
          if (stream) {
            let text: string;
            try {
              text = decoder.decode(chunk.value, { stream: true });
            } catch {
              throw new ProviderError('invalid_response', 'possibly_sent');
            }
            stream.feed(text);
            if (stream.done) break;
          } else chunks.push(chunk.value);
        }
      } finally {
        controller.signal.removeEventListener('abort', abortReader);
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (controller.signal.aborted)
        throw new ProviderError(timedOut ? 'timeout' : 'canceled', 'possibly_sent');
      if (stream) {
        try {
          stream.feed(decoder.decode());
        } catch (error) {
          if (error instanceof ProviderError) throw error;
          throw new ProviderError('invalid_response', 'possibly_sent');
        }
        return stream.result();
      }
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      } catch {
        throw new ProviderError('invalid_response', 'possibly_sent');
      }
      return parseResponse(value, request);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        timedOut ? 'timeout' : signal?.aborted ? 'canceled' : 'network_error',
        'possibly_sent',
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }
}
