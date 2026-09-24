/**
 * @redai/application workerIdentity barrel — worker enrollment, identity and
 * credential lifecycle. The API worker plugin and the bootstrap wiring consume these
 * use cases; only hashes cross into `@redai/db`.
 *
 * The package-level barrel (`packages/application/src/index.ts`) re-exports this
 * module; that wiring is owned by the coordinator (T15 does not edit shared files).
 */

export {
  WorkerIdentityService,
  ENROLLMENT_TTL_MS,
  WORKER_CREDENTIAL_TTL_MS,
  CREDENTIAL_ROTATION_OVERLAP_MS,
} from './service.js';
export type {
  WorkerIdentityServiceDeps,
  CreateEnrollmentTokenInput,
  CreateEnrollmentTokenResult,
  RedeemEnrollmentInput,
  RedeemEnrollmentResult,
  WorkerAuthContext,
  RotateCredentialResult,
} from './service.js';

export {
  WorkerIdentityError,
  EnrollmentInvalidError,
  EnrollmentExpiredError,
  EnrollmentAlreadyConsumedError,
  WorkerCredentialInvalidError,
  WorkerNotFoundError,
} from './errors.js';
export type { WorkerIdentityErrorCode } from './errors.js';

export { createDbWorkerIdentityRepository } from './dbRepository.js';
export { InMemoryWorkerIdentityRepository } from './memoryRepository.js';

export type {
  WorkerIdentityRepository,
  WorkerState,
  WorkerRecord,
  WorkerCredentialRecord,
  EnrollmentTokenRecord,
  WorkerDefaults,
  CredentialWithWorker,
  CreateEnrollmentTokenInput as CreateEnrollmentTokenRepoInput,
  RedeemEnrollmentInput as RedeemEnrollmentRepoInput,
  RedeemEnrollmentOutcome,
  NewWorkerInput,
  NewCredentialInput,
} from './ports.js';
