/**
 * Typed use-case errors for the Ask / chat-persistence module (T09). Each carries a
 * stable `code` and an HTTP `httpStatus` so the API layer maps it onto the docs/06 §6
 * envelope without a runtime class import (the API recognises them structurally).
 */

export type MessagesErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'CHAT_NOT_FOUND'
  | 'RUN_NOT_FOUND'
  | 'PROVIDER_CONFIG_NOT_FOUND'
  | 'CHAT_HAS_ACTIVE_RUN'
  | 'IDEMPOTENCY_CONFLICT'
  | 'REQUEST_IN_PROGRESS'
  | 'INVALID_BODY';

export class MessagesError extends Error {
  public readonly code: MessagesErrorCode;
  public readonly httpStatus: number;

  public constructor(code: MessagesErrorCode, httpStatus: number, message: string) {
    super(message);
    this.name = 'MessagesError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export class ProjectNotFoundError extends MessagesError {
  public constructor() {
    super('PROJECT_NOT_FOUND', 404, 'Project not found.');
  }
}

export class ChatNotFoundError extends MessagesError {
  public constructor() {
    super('CHAT_NOT_FOUND', 404, 'Chat not found.');
  }
}

export class RunNotFoundError extends MessagesError {
  public constructor() {
    super('RUN_NOT_FOUND', 404, 'Run not found.');
  }
}

export class ProviderConfigNotFoundError extends MessagesError {
  public constructor() {
    super('PROVIDER_CONFIG_NOT_FOUND', 404, 'Provider config not found.');
  }
}

export class ChatHasActiveRunError extends MessagesError {
  public constructor() {
    super('CHAT_HAS_ACTIVE_RUN', 409, 'This chat already has an active run.');
  }
}

/** Same idempotency key reused with a DIFFERENT body (docs/06 §4). */
export class IdempotencyConflictError extends MessagesError {
  public constructor() {
    super('IDEMPOTENCY_CONFLICT', 409, 'Idempotency-Key reused with a different body.');
  }
}

/** A concurrent duplicate is still committing under the same key (docs/06 §4). */
export class RequestInProgressError extends MessagesError {
  public constructor() {
    super('REQUEST_IN_PROGRESS', 409, 'A duplicate request is still in progress.');
  }
}

export function isMessagesError(err: unknown): err is MessagesError {
  return err instanceof MessagesError;
}
