/**
 * Pure run state machine (docs/07, SPEC_LOCK `run_states`).
 *
 * The set of run states and the LEGAL transitions the durable Agent runtime may make
 * live here as data, with no I/O, so a transition is unit-testable in isolation and
 * the runtime driver (apps/runtime) can assert a move before it writes. Authority for
 * a move is the runtime's fence-guarded CAS commit; this module only says which moves
 * are well-formed, never who is allowed to make them.
 */

export type RunState =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'waiting_worker'
  | 'paused'
  | 'cancel_requested'
  | 'cancellation_pending'
  | 'needs_attention'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'expired';

export const RUN_STATES: readonly RunState[] = Object.freeze([
  'queued',
  'running',
  'waiting_approval',
  'waiting_worker',
  'paused',
  'cancel_requested',
  'cancellation_pending',
  'needs_attention',
  'completed',
  'failed',
  'canceled',
  'expired',
]);

/** Terminal states: no further transition is legal (docs/07 §10). */
export const TERMINAL_RUN_STATES: readonly RunState[] = Object.freeze([
  'completed',
  'failed',
  'canceled',
  'expired',
]);

/** States in which a run still occupies the one-active-run-per-chat slot (INV-002). */
export const ACTIVE_RUN_STATES: readonly RunState[] = Object.freeze([
  'queued',
  'running',
  'waiting_approval',
  'waiting_worker',
  'paused',
  'cancel_requested',
  'cancellation_pending',
  'needs_attention',
]);

export function isTerminal(state: RunState): boolean {
  return TERMINAL_RUN_STATES.includes(state);
}

export function isActive(state: RunState): boolean {
  return ACTIVE_RUN_STATES.includes(state);
}

/**
 * Legal transitions for the Agent runtime. A key maps to every state it may move to
 * (a self-transition, e.g. running→running for an in-step checkpoint, is always
 * allowed and not listed). Terminal states map to an empty set. `cancel_requested`
 * and `pause` can be requested from any non-terminal state by the owner, but the
 * runtime moves them along only at a step boundary (docs/07 §6), so those are modeled
 * as reachable transitions here.
 */
export const AGENT_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> = Object.freeze({
  queued: ['running', 'canceled', 'expired'],
  running: [
    'waiting_approval',
    'waiting_worker',
    'paused',
    'needs_attention',
    'cancel_requested',
    'completed',
    'failed',
    'expired',
  ],
  waiting_approval: [
    'running',
    'needs_attention',
    'cancel_requested',
    'paused',
    'failed',
    'expired',
  ],
  waiting_worker: ['running', 'needs_attention', 'cancel_requested', 'paused', 'failed', 'expired'],
  paused: ['running', 'cancel_requested', 'needs_attention', 'expired', 'failed'],
  cancel_requested: ['cancellation_pending', 'canceled', 'failed'],
  cancellation_pending: ['canceled', 'failed'],
  needs_attention: ['running', 'cancel_requested', 'paused', 'failed', 'canceled', 'expired'],
  completed: [],
  failed: [],
  canceled: [],
  expired: [],
});

/** True when moving `from`→`to` is a well-formed transition (a self-move is allowed). */
export function canTransition(from: RunState, to: RunState): boolean {
  if (from === to) return !isTerminal(from);
  return AGENT_TRANSITIONS[from].includes(to);
}

/** Thrown by {@link assertTransition} for an illegal move. */
export class IllegalTransitionError extends Error {
  public readonly from: RunState;
  public readonly to: RunState;
  public constructor(from: RunState, to: RunState) {
    super(`illegal run transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}
