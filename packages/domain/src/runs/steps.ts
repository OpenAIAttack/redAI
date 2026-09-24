/**
 * Pure step-boundary model + STABLE logical tool-call IDs (docs/07 §2, §4; docs/04 §36).
 *
 * A durable Agent step advances through a small, ordered set of phases. Every phase is
 * a CHECKPOINT BOUNDARY: the runtime commits the checkpoint (fence-guarded) at each
 * phase edge, so a crash resumes deterministically from the last committed phase and
 * never replays an effect it already committed. This module is pure data + pure
 * functions so the boundary logic is unit-testable without a database.
 *
 * The logical tool-call ID is derived DETERMINISTICALLY from `(runId, stepNo,
 * providerToolIndex)` — never from the provider-supplied id, which is untrusted and
 * not a system primary key (docs/07 §4). Because it is a pure function of durable
 * facts, a resumed runtime re-derives the SAME id for the same requested call and so
 * cannot create a duplicate logical call after a restart (docs/07 §10 acceptance).
 */
import { createHash } from 'node:crypto';

/**
 * Ordered checkpoint phases of one durable step. `planning`/`calling_model` re-plan
 * safely on resume (no tool committed yet); `model_committed` means the logical tool
 * calls are durable and dispatch may proceed exactly-once; `done` is the terminal
 * phase written alongside the final message.
 */
export type StepPhase = 'planning' | 'calling_model' | 'model_committed' | 'done';

export const STEP_PHASES: readonly StepPhase[] = Object.freeze([
  'planning',
  'calling_model',
  'model_committed',
  'done',
]);

/** Every phase edge is a durable boundary; a resume is legal from any non-terminal phase. */
export function isResumablePhase(phase: StepPhase): boolean {
  return phase !== 'done';
}

/** A resume from `calling_model` re-issues the model call (no effect was committed yet). */
export function resumeRePlans(phase: StepPhase): boolean {
  return phase === 'planning' || phase === 'calling_model';
}

const TOOL_CALL_NAMESPACE = 'redai.tool_call.v1';

/**
 * Format 32 hex chars (16 bytes) as a canonical UUID string. The version/variant bits
 * are set so the value is a well-formed v5-style UUID (name-based), matching the
 * `uuid` column shape of `tool_calls.id` without importing a uuid library.
 */
function hexToUuid(hex32: string): string {
  const bytes = hex32.slice(0, 32).split('');
  // version 5
  bytes[12] = '5';
  // variant 10xx -> one of 8,9,a,b
  const variantNibble = parseInt(bytes[16] ?? '0', 16);
  bytes[16] = ((variantNibble & 0x3) | 0x8).toString(16);
  const s = bytes.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/**
 * The stable logical id for a model-requested tool call. Deterministic in
 * `(runId, stepNo, providerToolIndex)`, so a restart re-derives the same id and the
 * `(agent_step_id, provider_tool_index)` uniqueness holds without a fresh random id.
 */
export function logicalToolCallId(
  runId: string,
  stepNo: number,
  providerToolIndex: number,
): string {
  if (!Number.isInteger(stepNo) || stepNo < 1) {
    throw new RangeError(`stepNo must be a positive integer, got ${stepNo}`);
  }
  if (!Number.isInteger(providerToolIndex) || providerToolIndex < 0) {
    throw new RangeError(
      `providerToolIndex must be a non-negative integer, got ${providerToolIndex}`,
    );
  }
  const digest = createHash('sha1')
    .update(`${TOOL_CALL_NAMESPACE}|${runId}|${stepNo}|${providerToolIndex}`, 'utf8')
    .digest('hex');
  return hexToUuid(digest);
}

/**
 * The stable id of a run's SINGLE final assistant message. Deterministic in `runId`,
 * so a resumed runtime re-derives the same id and a re-finalize updates the same row
 * (idempotent) — there is never a duplicate final message (docs/07 §10 acceptance).
 */
export function finalMessageId(runId: string): string {
  const digest = createHash('sha1').update(`redai.final_message.v1|${runId}`, 'utf8').digest('hex');
  return hexToUuid(digest);
}

/**
 * A stable per-attempt id for a logical tool call. Distinct from the logical id so a
 * retried dispatch (a NEW grant of execution) carries a fresh `attempt_id` while the
 * logical `tool_call_id` stays stable (AGENTS: stable tool_call_id + per-attempt
 * attempt_id/fencing_token).
 */
export function toolAttemptId(toolCallId: string, attemptNo: number): string {
  if (!Number.isInteger(attemptNo) || attemptNo < 1) {
    throw new RangeError(`attemptNo must be a positive integer, got ${attemptNo}`);
  }
  const digest = createHash('sha1')
    .update(`redai.tool_attempt.v1|${toolCallId}|${attemptNo}`, 'utf8')
    .digest('hex');
  return hexToUuid(digest);
}
