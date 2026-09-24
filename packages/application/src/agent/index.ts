/**
 * @redai/application agent barrel — the durable Agent loop use cases (T13). Exposed as
 * the `@redai/application/agent` subpath export. The runtime driver imports the service
 * + repository/ports + transports; the DB adapter reaches into `@redai/db`; the provider
 * resolver reaches into `@redai/llm`. The API layer imports only `createAgentRun` on the
 * repository to QUEUE a run — the loop runs solely in apps/runtime.
 */
export {
  AgentService,
  canonicalJson,
  DEFAULT_MAX_STEPS,
  ABSOLUTE_TIMEOUT_SECONDS,
} from './service.js';
export type { AgentServiceDeps, AgentStepResult, AgentStopReason } from './service.js';

export { assembleAgentContext, AGENT_SYSTEM_PROMPT } from './context.js';
export { DEFAULT_TOOL_REGISTRY } from './registry.js';
export { toCheckpointJson } from './checkpoint.js';

export {
  notImplementedTransport,
  MockToolTransport,
  allowAllAuthorizer,
  denyAllAuthorizer,
  mapAuthorizer,
} from './transports.js';
export type { MockToolScript } from './transports.js';

export { InMemoryAgentRunRepository } from './memoryRepository.js';
export { createDbAgentRunRepository } from './dbRepository.js';

// Re-exported model-gateway surface so the runtime driver + its tests need not depend
// on @redai/llm directly (the loop already speaks only these neutral shapes).
export { MockProvider } from '@redai/llm';
export type { ModelProvider, GenerateResult, MockFixture, Message } from '@redai/llm';

export { ToolDispatchUnavailableError } from './ports.js';
export type {
  EffectClass,
  AgentClaimedRun,
  AgentCheckpoint,
  PendingToolCall,
  ToolResultRecord,
  CreateAgentRunInput,
  CreateAgentRunOutcome,
  CommitCheckpointInput,
  FinalizeAgentRunInput,
  TerminateAgentRunInput,
  AgentRunRepository,
  ToolTransport,
  ToolDispatchRequest,
  ToolRegistry,
  ToolRegistryEntry,
  ToolAuthorizer,
  AgentContextBuilder,
  AgentContextInputs,
  ProviderResolver,
  RunRecord,
  MessageRecord,
  FenceResult,
  Page,
  PageQuery,
  Clock,
  RandomSource,
} from './ports.js';
