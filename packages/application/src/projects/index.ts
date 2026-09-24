/**
 * @redai/application projects barrel — project/chat/note/worker-binding use cases.
 *
 * The coordinator re-exports this from the package barrel (`packages/application/
 * src/index.ts`); this task must not edit that shared file. The API layer imports
 * these use cases; only the DB adapter reaches into `@redai/db`.
 */

export { ProjectsService, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from './service.js';
export type { ProjectsServiceDeps, DeleteProjectInput } from './service.js';

export {
  ProjectsError,
  ProjectNotFoundError,
  ChatNotFoundError,
  NoteNotFoundError,
  WorkerNotFoundError,
  BindingNotFoundError,
  RevisionConflictError,
  InboxProtectedError,
  InboxExistsError,
  ProjectNotActiveError,
  ProjectHasActiveRunError,
  ChatHasActiveRunError,
  NameConfirmationMismatchError,
} from './errors.js';
export type { ProjectsErrorCode } from './errors.js';

export { createDbProjectsRepository } from './dbRepository.js';
export { InMemoryProjectsRepository } from './memoryRepository.js';
export type { FakeWorker, FakeRun } from './memoryRepository.js';

export { encodeCursor, decodeCursor } from './cursor.js';
export type { CursorKey } from './cursor.js';

export type {
  Clock,
  RandomSource,
  ProjectStatus,
  ApprovalMode,
  DataMode,
  ProjectRecord,
  ChatRecord,
  NoteRecord,
  BindingRecord,
  Page,
  PageQuery,
  ProjectsRepository,
  CreateProjectFields,
  UpdateProjectFields,
  CreateChatFields,
  UpdateChatFields,
  CreateNoteFields,
  UpdateNoteFields,
  UpsertBindingFields,
} from './ports.js';
