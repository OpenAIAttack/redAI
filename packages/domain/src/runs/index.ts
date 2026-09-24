/**
 * Pure run-domain barrel: state machine, step boundaries, stable logical tool-call
 * IDs, loop detection and limit predicates. All pure (no I/O), so the Agent runtime
 * builds its durable loop on top and unit tests exercise the invariants directly.
 */
export {
  RUN_STATES,
  TERMINAL_RUN_STATES,
  ACTIVE_RUN_STATES,
  AGENT_TRANSITIONS,
  isTerminal,
  isActive,
  canTransition,
  assertTransition,
  IllegalTransitionError,
} from './stateMachine.js';
export type { RunState } from './stateMachine.js';

export {
  STEP_PHASES,
  isResumablePhase,
  resumeRePlans,
  logicalToolCallId,
  toolAttemptId,
  finalMessageId,
} from './steps.js';
export type { StepPhase } from './steps.js';

export {
  LOOP_REPEAT_THRESHOLD,
  computeFingerprint,
  noProgressRepeatCount,
  isLoopDetected,
} from './loop.js';
export type { ActionFingerprintInput, FingerprintRecord } from './loop.js';

export {
  MAX_STEPS,
  ACTIVE_TIMEOUT_SECONDS,
  ABSOLUTE_TIMEOUT_SECONDS,
  exceededMaxSteps,
  exceededActiveTimeout,
  exceededAbsoluteTimeout,
  checkLimits,
} from './limits.js';
export type { LimitStop, LimitCheckInput } from './limits.js';

export { extractPlanBlock, parsePlanFromText } from './plan.js';
export type { PlanItem, PlanItemStatus, ParsePlanResult } from './plan.js';
