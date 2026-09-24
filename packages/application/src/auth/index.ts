/**
 * @redai/application auth barrel — owner bootstrap, sessions, password lifecycle.
 * The API layer and the bootstrap CLI consume these use cases; only hashes cross
 * into `@redai/db`.
 */

export { AuthService, DEFAULT_SESSION_POLICY, MIN_PASSWORD_LENGTH } from './service.js';
export type {
  AuthServiceDeps,
  BootstrapOwnerInput,
  BootstrapOwnerResult,
  LoginInput,
  LoginResult,
  SessionSecrets,
  SessionProfile,
  SessionContext,
  ChangePasswordInput,
  ResetWithRecoveryInput,
  ResetResult,
} from './service.js';

export {
  AuthError,
  OwnerExistsError,
  InvalidCredentialsError,
  SessionInvalidError,
  RecoveryInvalidError,
  NotBootstrappedError,
  WeakPasswordError,
} from './errors.js';
export type { AuthErrorCode } from './errors.js';

export {
  scryptHasher,
  cryptoRandom,
  systemClock,
  hashToken,
  hashRecoveryCode,
  constantTimeEqual,
} from './crypto.js';

export { createDbAuthRepository } from './dbRepository.js';
export { InMemoryAuthRepository } from './memoryRepository.js';

export type {
  AuthRepository,
  Clock,
  PasswordHasher,
  RandomSource,
  SessionPolicy,
  OwnerRecord,
  SessionRecord,
  BootstrapInput,
  BootstrapResult,
  CreateSessionRecord,
} from './ports.js';
