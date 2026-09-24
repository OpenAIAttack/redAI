/**
 * Typed failures for the artifact use cases. Each carries a stable `code` the API layer
 * maps to the redAI error envelope + HTTP status. Messages never embed host paths,
 * secrets or target bytes (AGENTS.md), so they are safe to log.
 */

export type ArtifactsErrorCode =
  | 'ARTIFACT_NOT_FOUND'
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_NOT_ACTIVE'
  | 'ARTIFACT_NOT_PENDING'
  | 'UPLOAD_NOT_STAGED'
  | 'HASH_MISMATCH'
  | 'SIZE_EXCEEDED'
  | 'CONTENT_NOT_READY'
  | 'MEDIA_TYPE_MISMATCH'
  | 'PREVIEW_UNSUPPORTED'
  | 'STORAGE_IO';

export class ArtifactsError extends Error {
  public readonly code: ArtifactsErrorCode;
  public readonly httpStatus: number;
  public constructor(code: ArtifactsErrorCode, httpStatus: number, message: string) {
    super(message);
    this.name = 'ArtifactsError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** The artifact was addressed under the wrong project / does not exist (INV-001). */
export class ArtifactNotFoundError extends ArtifactsError {
  public constructor() {
    super('ARTIFACT_NOT_FOUND', 404, 'Artifact not found in this project.');
    this.name = 'ArtifactNotFoundError';
  }
}
export class ProjectNotFoundError extends ArtifactsError {
  public constructor() {
    super('PROJECT_NOT_FOUND', 404, 'Project not found in this workspace.');
    this.name = 'ProjectNotFoundError';
  }
}
export class ProjectNotActiveError extends ArtifactsError {
  public constructor() {
    super('PROJECT_NOT_ACTIVE', 409, 'Project is not active; uploads are disabled.');
    this.name = 'ProjectNotActiveError';
  }
}
/** A content upload or finalize was attempted on an artifact no longer in `pending`. */
export class ArtifactNotPendingError extends ArtifactsError {
  public constructor() {
    super('ARTIFACT_NOT_PENDING', 409, 'Artifact is not awaiting upload.');
    this.name = 'ArtifactNotPendingError';
  }
}
/** Finalize found no staged bytes (upload never completed / was interrupted). */
export class UploadNotStagedError extends ArtifactsError {
  public constructor() {
    super('UPLOAD_NOT_STAGED', 409, 'No uploaded bytes to finalize.');
    this.name = 'UploadNotStagedError';
  }
}
/** The server-observed sha256/size did not match the declared values. */
export class HashMismatchError extends ArtifactsError {
  public readonly expectedSha256: string;
  public readonly observedSha256: string;
  public constructor(expectedSha256: string, observedSha256: string) {
    super('HASH_MISMATCH', 422, 'Uploaded bytes do not match the declared digest/size.');
    this.name = 'HashMismatchError';
    this.expectedSha256 = expectedSha256;
    this.observedSha256 = observedSha256;
  }
}
export class SizeExceededError extends ArtifactsError {
  public constructor() {
    super('SIZE_EXCEEDED', 413, 'Upload exceeds the maximum allowed size.');
    this.name = 'SizeExceededError';
  }
}
/** Download/preview requested for an artifact whose bytes are not verified-ready. */
export class ContentNotReadyError extends ArtifactsError {
  public constructor() {
    super('CONTENT_NOT_READY', 409, 'Artifact content is not ready.');
    this.name = 'ContentNotReadyError';
  }
}
/** The bytes contradicted the declared media type; the artifact was quarantined. */
export class MediaTypeMismatchError extends ArtifactsError {
  public constructor() {
    super(
      'MEDIA_TYPE_MISMATCH',
      422,
      'Content does not match its declared media type; quarantined.',
    );
    this.name = 'MediaTypeMismatchError';
  }
}
/** No safe preview exists for this media type; the owner can still download the bytes. */
export class PreviewUnsupportedError extends ArtifactsError {
  public constructor() {
    super('PREVIEW_UNSUPPORTED', 415, 'No preview is available for this media type.');
    this.name = 'PreviewUnsupportedError';
  }
}
/** An underlying filesystem write/rename failed (disk full, read-only, interrupted). */
export class StorageIoError extends ArtifactsError {
  public constructor() {
    super('STORAGE_IO', 507, 'Storage is unavailable or out of space.');
    this.name = 'StorageIoError';
  }
}
