/**
 * Provider-neutral model gateway types (docs/11 — Model gateway, context, data
 * modes, usage & budget).
 *
 * These shapes are the ONLY contract between the runtime (T09) and a concrete
 * {@link ModelProvider}. They are storage- and vendor-neutral: the OpenAI-compatible
 * adapter maps its wire format onto them, and the deterministic mock replays them.
 * `@redai/llm` never reads settings or a secret store itself — a resolved API key /
 * endpoint config is handed to a provider at construction (T05 `resolveCredential`
 * is the trusted-executor path that produces that key; this package consumes it).
 */

/** Owner-selected data mode governing what may leave the installation (docs/11 §3). */
export type DataMode = 'local_only' | 'redacted_cloud' | 'cloud_full';

export const DATA_MODES: readonly DataMode[] = ['local_only', 'redacted_cloud', 'cloud_full'];

/** Conversation roles. `tool` carries a tool result keyed by `toolCallId`. */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * One context message. Layer/authoring provenance lives in the runtime's context
 * builder (docs/11 §4); at the gateway seam a message is just a role + text plus,
 * for an assistant turn that called tools, the tool calls it emitted, and for a
 * `tool` message the id/name it answers.
 */
export interface Message {
  role: MessageRole;
  content: string;
  /** Present on an `assistant` message that requested tool calls (round-trip). */
  toolCalls?: ToolCall[];
  /** Present on a `tool` message: the id of the call this result answers. */
  toolCallId?: string;
  /** Present on a `tool` message: the tool name (for adapters that require it). */
  name?: string;
}

/**
 * A tool the model may call. `parameters` is a JSON-Schema object; the runtime owns
 * the canonical schemas (`@redai/contracts` `tool-input.*`) and passes the matching
 * schema here. A provider that cannot do native tool calling must NOT be driven by
 * parsing tool calls out of prose (docs/11 §2) — see {@link ProviderCapabilities}.
 */
export interface ToolDefinition {
  name: string;
  description?: string;
  /** JSON-Schema (draft 2020-12) object describing the tool arguments. */
  parameters: Record<string, unknown>;
}

/**
 * A tool call surfaced by the model. `argumentsRaw` is the exact JSON string the
 * provider produced; `arguments` is that string parsed to JSON. Parsing (and
 * schema validation with `@redai/contracts`) is the caller's gate before dispatch —
 * malformed JSON never silently becomes an empty-args dispatch.
 */
export interface ToolCall {
  /** Stable provider-assigned id (round-tripped back as `toolCallId`). */
  id: string;
  /** Streaming index; also used to detect duplicate/conflicting indices. */
  index: number;
  name: string;
  /** Raw JSON argument string exactly as emitted by the provider. */
  argumentsRaw: string;
  /** `argumentsRaw` parsed to JSON (unknown until schema-validated by the caller). */
  arguments: unknown;
}

/**
 * Token usage. Deliberately a discriminated union so an *omitted* provider usage
 * block is recorded as `unknown` rather than guessed as zero — the reservation
 * ledger must keep `unknown` reserved instead of reducing it (docs/11 §7, §9).
 */
export type Usage =
  | { kind: 'known'; inputTokens: number; outputTokens: number; totalTokens: number }
  | { kind: 'unknown' };

export const UNKNOWN_USAGE: Usage = { kind: 'unknown' };

/** Why generation stopped, normalized across providers. */
export type FinishReason =
  'stop' | 'length' | 'tool_calls' | 'content_filter' | 'canceled' | 'error' | 'unknown';

/** Input to a single generation. `signal` cancels; `stream` selects transport. */
export interface GenerateRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  /** Use the streaming transport under the hood (result is still aggregated). */
  stream?: boolean;
  /** Cancellation — aborts the in-flight request/stream promptly. */
  signal?: AbortSignal;
  /**
   * The data mode this request runs under. A provider records it but the binding
   * decision (may this provider serve this mode?) is made by {@link selectProvider}
   * BEFORE a provider is ever called, so `local_only` never reaches a cloud adapter.
   */
  dataMode?: DataMode;
  /** Optional per-request output cap (adapter forwards as max_tokens). */
  maxOutputTokens?: number;
}

/** Aggregated result of a generation. */
export interface GenerateResult {
  text: string;
  toolCalls?: ToolCall[];
  usage: Usage;
  finishReason: FinishReason;
  /** True when produced by the mock provider (never silently shipped in release). */
  isMock: boolean;
  /** Provider label for provenance / UI ("MOCK — scripted", the endpoint name, …). */
  providerLabel: string;
}

/** Streaming events yielded by {@link ModelProvider.stream}. */
export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; finishReason: FinishReason };

/** Static capabilities of a provider (probed, or declared by the mock). */
export interface ProviderCapabilities {
  text: boolean;
  tools: boolean;
  streaming: boolean;
  structuredOutput: boolean;
  vision: boolean;
}

/** Identity + capability descriptor for a provider instance. */
export interface ProviderInfo {
  /** Adapter family. */
  kind: 'mock' | 'openai_compatible';
  /** Human-facing label; the mock's is clearly marked as mock. */
  label: string;
  isMock: boolean;
  capabilities: ProviderCapabilities;
}

/**
 * The provider seam. `generate` returns an aggregated {@link GenerateResult};
 * `stream` yields incremental {@link StreamEvent}s and cancels on `signal`. A single
 * `generate` performs exactly one provider round-trip (no hidden library retries).
 */
export interface ModelProvider {
  readonly info: ProviderInfo;
  generate(request: GenerateRequest): Promise<GenerateResult>;
  stream(request: GenerateRequest): AsyncIterable<StreamEvent>;
}
