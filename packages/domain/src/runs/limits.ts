/**
 * Pure step / time limit predicates (docs/07 §9, SPEC_LOCK defaults).
 *
 * The Agent runtime enforces a hard step cap, an active-time budget and an absolute
 * deadline. These are pure predicates over durable counters + injected clock values so
 * the runtime can decide "must I stop now?" before it spends another model call, and
 * so the thresholds are unit-testable against the SPEC_LOCK numbers.
 */

/** SPEC_LOCK.json defaults. */
export const MAX_STEPS = 40;
export const ACTIVE_TIMEOUT_SECONDS = 1800;
export const ABSOLUTE_TIMEOUT_SECONDS = 86400;

/** True once `stepCount` has reached the cap — the NEXT step is not allowed. */
export function exceededMaxSteps(stepCount: number, maxSteps: number = MAX_STEPS): boolean {
  return stepCount >= maxSteps;
}

/** True once the accumulated ACTIVE time reaches the budget. */
export function exceededActiveTimeout(
  activeElapsedMs: number,
  limitSeconds: number = ACTIVE_TIMEOUT_SECONDS,
): boolean {
  return activeElapsedMs >= limitSeconds * 1000;
}

/** True once wall-clock since creation reaches the absolute deadline (never extended). */
export function exceededAbsoluteTimeout(
  createdAt: Date,
  now: Date,
  limitSeconds: number = ABSOLUTE_TIMEOUT_SECONDS,
): boolean {
  return now.getTime() - createdAt.getTime() >= limitSeconds * 1000;
}

/** A machine reason for why the runtime must stop, or null when within all limits. */
export type LimitStop = 'MAX_STEPS' | 'ACTIVE_TIMEOUT' | 'ABSOLUTE_TIMEOUT' | null;

export interface LimitCheckInput {
  stepCount: number;
  activeElapsedMs: number;
  createdAt: Date;
  now: Date;
  maxSteps?: number;
  activeTimeoutSeconds?: number;
  absoluteTimeoutSeconds?: number;
}

/**
 * Evaluate all limits in priority order. The absolute deadline wins (it maps to an
 * `expired` terminal state); the active-time budget and step cap map to `failed`.
 */
export function checkLimits(input: LimitCheckInput): LimitStop {
  if (exceededAbsoluteTimeout(input.createdAt, input.now, input.absoluteTimeoutSeconds)) {
    return 'ABSOLUTE_TIMEOUT';
  }
  if (exceededActiveTimeout(input.activeElapsedMs, input.activeTimeoutSeconds)) {
    return 'ACTIVE_TIMEOUT';
  }
  if (exceededMaxSteps(input.stepCount, input.maxSteps)) {
    return 'MAX_STEPS';
  }
  return null;
}
