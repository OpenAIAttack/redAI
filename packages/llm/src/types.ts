/** Inputs are built by the trusted context pipeline, never raw API request bodies. */
export type DataMode = 'local_only' | 'redacted_cloud' | 'cloud_full';
export interface ModelRequest {
  messages: readonly { role: 'system' | 'user' | 'assistant'; content: string }[];
  maxOutputTokens: number;
  dataMode: DataMode;
  structuredOutput?: {
    name: string;
    schema: Record<string, unknown>;
    validate: (value: unknown) => boolean;
  };
  tools?: readonly {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    /** Runtime supplies the canonical argument-schema validator. */
    validateArguments: (value: unknown) => boolean;
  }[];
}
export type Usage =
  { state: 'observed'; inputTokens: number; outputTokens: number } | { state: 'unknown' };
export interface ModelResponse {
  text: string;
  refusal: string | null;
  toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter';
  usage: Usage;
}
/** Provisional display only; a failed stream must not become a completed message. */
export interface ModelDelta {
  type: 'text' | 'refusal';
  text: string;
}
export interface ModelAdapter {
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}
export type ProviderErrorCode =
  | 'invalid_request'
  | 'policy_denied'
  | 'unsupported_capability'
  | 'authentication'
  | 'rate_limited'
  | 'provider_error'
  | 'invalid_response'
  | 'response_too_large'
  | 'network_error'
  | 'timeout'
  | 'canceled';

/** Safe to serialize: no URL, credential, raw response, prompt, or nested cause. */
export class ProviderError extends Error {
  readonly usage: Usage = { state: 'unknown' };
  constructor(
    readonly code: ProviderErrorCode,
    readonly requestState: 'not_sent' | 'possibly_sent',
  ) {
    super(`Model request failed: ${code}`);
    this.name = 'ProviderError';
  }
}
