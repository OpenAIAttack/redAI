/**
 * @redai/llm — the vendor-neutral model gateway (docs/11). It exposes a single
 * {@link ModelProvider} seam with two implementations: a deterministic, clearly
 * labelled {@link MockProvider} (the default so CI needs no key or payment) and an
 * {@link OpenAiCompatibleProvider} over Node's global `fetch` (no vendor SDK, so no
 * hidden retries). Data-mode routing keeps `local_only` off any cloud adapter, a
 * synthetic-data capability probe learns what an endpoint can do, and a shared
 * payload-capture hook lets tests assert exactly what would be sent.
 *
 * This package is self-contained: it receives a RESOLVED api key / endpoint config
 * via its inputs (T05 `resolveCredential`) and never imports settings, reads a
 * secret store, or logs a key/prompt. Wiring into the API/runtime is T09.
 */

export const LLM_PACKAGE = '@redai/llm';

// Core types & the provider seam.
export type {
  DataMode,
  MessageRole,
  Message,
  ToolDefinition,
  ToolCall,
  Usage,
  FinishReason,
  GenerateRequest,
  GenerateResult,
  StreamEvent,
  ProviderCapabilities,
  ProviderInfo,
  ModelProvider,
} from './types.js';
export { DATA_MODES, UNKNOWN_USAGE } from './types.js';

// Error taxonomy.
export {
  LlmError,
  isLlmError,
  LlmTimeoutError,
  LlmCanceledError,
  LlmRateLimitedError,
  LlmAuthError,
  LlmBadRequestError,
  LlmServerError,
  LlmNetworkError,
  LlmProtocolError,
  LlmDataModeError,
  LlmNoProviderError,
  LlmCapabilityError,
  LlmConfigError,
} from './errors.js';
export type { LlmErrorCode } from './errors.js';

// Stream assembly.
export { StreamAssembler, assembleStream } from './assemble.js';

// OpenAI-compatible wire mapping (shared by the adapter and the mock canary).
export { buildChatCompletionsBody, chatCompletionToEvents, streamChunkToEvents } from './wire.js';
export type { ChatCompletionsBody } from './wire.js';

// Mock provider + fixtures + payload-capture canary.
export { MockProvider, MOCK_LABEL } from './mock/provider.js';
export type { MockProviderOptions, CapturedPayload } from './mock/provider.js';
export {
  parseFixture,
  loadFixtureDir,
  fixtureUsage,
  fixtureEventToStreamEvent,
} from './mock/fixtures.js';
export type { MockFixture, MockEvent } from './mock/fixtures.js';

// OpenAI-compatible adapter.
export { OpenAiCompatibleProvider } from './openai/adapter.js';
export type { OpenAiCompatibleOptions, RetryPolicy, FetchLike } from './openai/adapter.js';

// Data-mode routing.
export {
  isCandidateEligible,
  assertDataModeAllowed,
  selectProvider,
  generateWithFallback,
  candidateLabel,
} from './routing.js';
export type { ProviderCandidate } from './routing.js';

// Capability probe & agent-capability guard.
export {
  probeProvider,
  ensureAgentCapable,
  SYNTHETIC_PROBE_MESSAGES,
  SYNTHETIC_PROBE_TOOL,
} from './probe.js';
export type { CapabilityProbeResult, ProbeOptions } from './probe.js';

// Tool-input validation against @redai/contracts.
export { validateToolCall, isToolArgsValid } from './toolValidation.js';
export type { ToolValidation } from './toolValidation.js';

// Context manifest + redaction pipeline (T14 — docs/11 §4–§5).
export {
  buildContextManifest,
  estimateTokens,
  Redactor,
  redactText,
  REDACTION_TRANSFORM_ID,
  makeCanary,
  scanForSecret,
  assertNoSecretLeak,
  CANARY_PREFIX,
} from './context/index.js';
export type {
  RedactorOptions,
  EgressSurfaces,
  SourceClassification,
  ContextLayer,
  ContextSource,
  TokenCaps,
  SecretRefInput,
  RedactionOptions,
  InclusionReason,
  ManifestEntry,
  RedactionCounts,
  ContextManifest,
} from './context/index.js';
