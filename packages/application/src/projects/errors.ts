/**
 * Typed failures for the project / chat / note / worker-binding use cases.
 *
 * Each error carries a stable `code` the API layer maps to the redAI error
 * envelope + an HTTP status. Messages never embed target content, secrets or
 * tokens, so they are safe to log (AGENTS.md: no secret in log/URL/response).
 */

export type ProjectsErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'CHAT_NOT_FOUND'
  | 'NOTE_NOT_FOUND'
  | 'WORKER_NOT_FOUND'
  | 'BINDING_NOT_FOUND'
  | 'REVISION_CONFLICT'
  | 'INBOX_PROTECTED'
  | 'INBOX_EXISTS'
  | 'PROJECT_NOT_ACTIVE'
  | 'PROJECT_HAS_ACTIVE_RUN'
  | 'CHAT_HAS_ACTIVE_RUN'
  | 'NAME_CONFIRMATION_MISMATCH'
  | 'INVALID_STATE_TRANSITION';

export class ProjectsError extends Error {
  public readonly code: ProjectsErrorCode;
  /** The HTTP status the API layer should surface for this failure. */
  public readonly httpStatus: number;
  public constructor(code: ProjectsErrorCode, httpStatus: number, message: string) {
    super(message);
    this.name = 'ProjectsError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class ProjectNotFoundError extends ProjectsError {
  public constructor() {
    super('PROJECT_NOT_FOUND', 404, 'Project not found in this workspace.');
    this.name = 'ProjectNotFoundError';
  }
}

/**
 * A chat/note/binding was addressed under the wrong project. Because every read and
 * write filters on the composite `(id, project_id, workspace_id)` key, a valid UUID
 * that belongs to another project simply resolves to "not found" (INV-001: a valid
 * UUID is not authorization). This is the headline cross-project-isolation failure.
 */
export class ChatNotFoundError extends ProjectsError {
  public constructor() {
    super('CHAT_NOT_FOUND', 404, 'Chat not found in this project.');
    this.name = 'ChatNotFoundError';
  }
}

export class NoteNotFoundError extends ProjectsError {
  public constructor() {
    super('NOTE_NOT_FOUND', 404, 'Note not found in this project.');
    this.name = 'NoteNotFoundError';
  }
}

/** The referenced worker does not exist in this workspace (binding FK unsatisfied). */
export class WorkerNotFoundError extends ProjectsError {
  public constructor() {
    super('WORKER_NOT_FOUND', 404, 'Worker not found in this workspace.');
    this.name = 'WorkerNotFoundError';
  }
}

export class BindingNotFoundError extends ProjectsError {
  public constructor() {
    super('BINDING_NOT_FOUND', 404, 'Worker binding not found for this project.');
    this.name = 'BindingNotFoundError';
  }
}

/**
 * Optimistic-concurrency failure: the caller's `expected_revision` did not match the
 * row's current revision, so a concurrent edit won. The caller must re-read and retry
 * (docs/05: `revision` increments with optimistic concurrency).
 */
export class RevisionConflictError extends ProjectsError {
  public readonly expected: string;
  public readonly current: string;
  public constructor(expected: string, current: string) {
    super('REVISION_CONFLICT', 409, 'Stale revision; the resource was modified concurrently.');
    this.name = 'RevisionConflictError';
    this.expected = expected;
    this.current = current;
  }
}

/** The Inbox is a system project: it cannot be archived, deleted or un-inboxed. */
export class InboxProtectedError extends ProjectsError {
  public constructor() {
    super(
      'INBOX_PROTECTED',
      409,
      'The Inbox is a system project and cannot be archived or deleted.',
    );
    this.name = 'InboxProtectedError';
  }
}

/** Attempt to create a second Inbox (the partial unique `one_inbox` guards this). */
export class InboxExistsError extends ProjectsError {
  public constructor() {
    super('INBOX_EXISTS', 409, 'An Inbox already exists for this workspace.');
    this.name = 'InboxExistsError';
  }
}

/** A mutation (e.g. create chat) was attempted against a non-active project. */
export class ProjectNotActiveError extends ProjectsError {
  public constructor() {
    super(
      'PROJECT_NOT_ACTIVE',
      409,
      'Project is not active; archived/deleting projects are read-only.',
    );
    this.name = 'ProjectNotActiveError';
  }
}

/** Deleting a project (or chat) with an active run requires cancelling it first (INV-002/§6). */
export class ProjectHasActiveRunError extends ProjectsError {
  public constructor() {
    super('PROJECT_HAS_ACTIVE_RUN', 409, 'Project has an active run; cancel it before deleting.');
    this.name = 'ProjectHasActiveRunError';
  }
}

export class ChatHasActiveRunError extends ProjectsError {
  public constructor() {
    super('CHAT_HAS_ACTIVE_RUN', 409, 'Chat has an active run; cancel it before deleting.');
    this.name = 'ChatHasActiveRunError';
  }
}

/** Destructive delete requires the owner to re-type the exact project name (docs/03 §5). */
export class NameConfirmationMismatchError extends ProjectsError {
  public constructor() {
    super('NAME_CONFIRMATION_MISMATCH', 422, 'Typed name does not match the project name.');
    this.name = 'NameConfirmationMismatchError';
  }
}
