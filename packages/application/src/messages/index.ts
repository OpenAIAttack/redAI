/**
 * @redai/application messages barrel — durable Ask & chat-persistence use cases (T09).
 *
 * Exposed as the `@redai/application/messages` subpath export so its flat helper names
 * never collide with the other application modules. The API layer imports the service
 * + DTO record types; the runtime driver imports the service + repository/ports; only
 * the DB adapters reach into `@redai/db`, and only the provider resolver reaches into
 * `@redai/llm`.
 */

export {
  AskService,
  canonicalBodyHash,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  DEFAULT_BUDGET_MICRO_USD,
  DEFAULT_MAX_STEPS,
  ABSOLUTE_TIMEOUT_SECONDS,
} from './service.js';
export type { AskServiceDeps, CreateAskInput, CreateAskResult, StepResult } from './service.js';

export { assembleAskContext, ASK_SYSTEM_PROMPT } from './context.js';

export {
  MessagesError,
  isMessagesError,
  ProjectNotFoundError,
  ChatNotFoundError,
  RunNotFoundError,
  ProviderConfigNotFoundError,
  ChatHasActiveRunError,
  IdempotencyConflictError,
  RequestInProgressError,
} from './errors.js';
export type { MessagesErrorCode } from './errors.js';

export { createDbMessagesRepository } from './dbRepository.js';
export { createDbAskContextBuilder } from './contextBuilder.js';
export { createProviderResolver } from './providerResolver.js';
export type {
  ProviderResolverDeps,
  ProviderConfigReader,
  CredentialResolver,
} from './providerResolver.js';

export { InMemoryMessagesRepository, scriptedUuids } from './memoryRepository.js';

export { encodeCursor, decodeCursor } from './cursor.js';

export type {
  Clock,
  RandomSource,
  RunMode,
  RunKind,
  RunState,
  RunOutcome,
  MessageRole,
  MessageStatus,
  RunRecord,
  MessageRecord,
  Page,
  PageQuery,
  CreateAskRunInput,
  CreateAskRunOutcome,
  IdempotencyKey,
  ClaimedRun,
  BeginAssistantInput,
  PersistPartialInput,
  FinalizeAssistantInput,
  FailRunInput,
  FenceResult,
  MessagesRepository,
  AskContextBuilder,
  AskContextInputs,
  ProviderResolver,
  DataMode,
  Message,
  ProviderCandidate,
  GenerateResult,
} from './ports.js';
