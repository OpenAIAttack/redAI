/**
 * @redai/application execution barrel — the task scheduler, signed-lease and result
 * plane (T17). The API worker-tasks plugin consumes {@link ExecutionService} through a
 * structural port; the coordinator wires the concrete service in via
 * {@link createDbExecutionService} and adds the `./execution` subpath export to the
 * package `exports` map (T17 does not edit shared package files).
 */
import type { Pool } from '@redai/db';
import { createDbExecutionRepository } from './dbRepository.js';
import { ExecutionService, type ExecutionServiceDeps } from './service.js';

export {
  ExecutionService,
  WORKER_LEASE_SECONDS,
  WORKER_RENEW_SECONDS,
  WORKER_SAFETY_MARGIN_SECONDS,
  CAPABILITY_MAX_TTL_SECONDS,
  DEFAULT_TIMEOUT_SECONDS,
} from './service.js';
export type {
  ExecutionServiceDeps,
  ExecutionServiceConfig,
  CredentialResolver,
  TaskEnvelope,
  RenewResult,
  ResultAck,
} from './service.js';

export {
  canonicalize,
  canonicalSha256Hex,
  base64url,
  mintLeaseJws,
  verifyLeaseJws,
  createEd25519LeaseSigner,
  ed25519PublicKeyFromBase64Url,
} from './jcs.js';
export type { LeaseSigner, CanonicalValue } from './jcs.js';

export {
  ExecutionError,
  SessionSupersededError,
  StaleFenceError,
  ResultConflictError,
  AttemptNotFoundError,
  LeaseRefusedError,
  ArtifactNotLinkedError,
  CapabilityInvalidError,
} from './errors.js';
export type { ExecutionErrorCode } from './errors.js';

export { createDbExecutionRepository } from './dbRepository.js';
export { InMemoryExecutionRepository } from './memoryRepository.js';
export type { ReconciliationNote } from './memoryRepository.js';

export type {
  AttemptRecord,
  AttemptState,
  ClaimContext,
  Clock,
  EnqueueAttemptInput,
  ExecutionRepository,
  FenceGuard,
  IdSource,
  LiveRenewCheck,
  NetworkProfile,
  ResourceLimits,
  SubmitResultInput,
  SubmitResultOutcome,
  WorkerScope,
  WorkerResultStatus,
  EffectObservation,
} from './ports.js';

/** Construct a DB-backed {@link ExecutionService} (coordinator wiring). */
export function createDbExecutionService(
  pool: Pool,
  deps: Omit<ExecutionServiceDeps, 'repo'>,
): ExecutionService {
  return new ExecutionService({ repo: createDbExecutionRepository(pool), ...deps });
}
