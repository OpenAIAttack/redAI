/**
 * Budget-ledger ports (docs/11 §7). Storage-neutral records + the repository seam so
 * the service is pure orchestration: the unit tests drive an in-memory fake and the
 * DB adapter owns the row-lock / atomic-decrement transaction boundaries.
 *
 * The ledger is per-RUN and SHARED: child agents draw from the same run limit, so a
 * child reservation competes against the parent's on the one budget (docs/11 §7
 * "Child agents dùng cùng ledger"). The core invariant enforced on every reserve:
 *
 *     committed_observed + unresolved_reserved + new_reservation <= limit
 *
 * A reservation whose provider usage never arrives is HELD as `unknown` — its reserved
 * amount stays counted, never refunded to 0 (docs/11 §7, §9).
 */

/** Injectable clock (mirrors the other application modules). */
export interface Clock {
  now(): Date;
}

export type ReservationState = 'reserved' | 'reconciled' | 'released' | 'unknown';

/** Basis of a recorded usage entry (mirrors the `usage_entries.basis` CHECK). */
export type UsageBasis = 'provider' | 'estimated' | 'unknown' | 'local_zero_model_cost';

/**
 * A versioned pricing config with provenance (docs/11 §7). Rates are
 * `micro_usd_per_million_tokens`. `localZeroModelCost` marks an owner-approved local
 * endpoint that declares model_api_cost = 0 (compute cost is NOT measured; the UI says
 * so — never presented as a real $0 spend elsewhere).
 */
export interface PricingConfig {
  version: string;
  provenance: 'manual' | 'official_import';
  inputMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
  fixedFeeMicroUsd?: number;
  localZeroModelCost?: boolean;
}

export interface ReservationRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  runId: string;
  /** The agent step this reservation belongs to (a child agent's step, or null). */
  agentStepId: string | null;
  providerAttempt: number;
  reservedMicroUsd: bigint;
  state: ReservationState;
  pricingSnapshot: PricingConfig;
  requestFingerprint: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UsageEntryRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  runId: string;
  reservationId: string;
  providerRequestId: string | null;
  inputTokens: bigint | null;
  outputTokens: bigint | null;
  observedMicroUsd: bigint | null;
  basis: UsageBasis;
  createdAt: Date;
}

/** A point-in-time view of one run's shared ledger. */
export interface LedgerSnapshot {
  runId: string;
  limitMicroUsd: bigint;
  /** Sum of observed cost of reconciled/local reservations. */
  committedObservedMicroUsd: bigint;
  /** Sum of reserved amounts still held (state reserved OR unknown). */
  unresolvedReservedMicroUsd: bigint;
  /** committed + unresolved — what counts against the limit. */
  totalHeldMicroUsd: bigint;
  /** Count of reservations held as unknown (usage never arrived). */
  unknownReservationCount: number;
  remainingMicroUsd: bigint;
}

// --- write inputs / outcomes -------------------------------------------------

export interface ReserveInput {
  workspaceId: string;
  projectId: string;
  runId: string;
  agentStepId?: string | null;
  providerAttempt: number;
  /** Idempotency key within the run (UNIQUE(run_id, request_fingerprint)). */
  requestFingerprint: string;
  /** Conservative upper-bound estimate (micro-USD) computed from pricing + caps. */
  amountMicroUsd: bigint;
  pricingSnapshot: PricingConfig;
  now: Date;
}

export type ReserveOutcome =
  | { kind: 'reserved'; reservation: ReservationRecord; ledger: LedgerSnapshot }
  | { kind: 'replayed'; reservation: ReservationRecord; ledger: LedgerSnapshot }
  | { kind: 'exceeded'; requested: bigint; ledger: LedgerSnapshot };

export interface ReconcileInput {
  workspaceId: string;
  runId: string;
  reservationId: string;
  providerRequestId?: string | null;
  /** Observed cost, or null when usage is unknown (then the reservation is HELD). */
  observedMicroUsd: bigint | null;
  inputTokens?: bigint | null;
  outputTokens?: bigint | null;
  basis: UsageBasis;
  now: Date;
}

export type ReconcileOutcome =
  | { kind: 'reconciled'; entry: UsageEntryRecord; ledger: LedgerSnapshot }
  | { kind: 'held_unknown'; entry: UsageEntryRecord; ledger: LedgerSnapshot }
  | { kind: 'noop'; ledger: LedgerSnapshot };

export interface ReleaseInput {
  workspaceId: string;
  runId: string;
  reservationId: string;
  now: Date;
}

export interface IncreaseLimitInput {
  workspaceId: string;
  projectId: string;
  runId: string;
  newLimitMicroUsd: bigint;
  /** Who authorised the increase (the owner) — recorded in the audit. */
  actor: string;
  reason?: string;
  now: Date;
}

export interface IncreaseLimitOutcome {
  limitMicroUsd: bigint;
  /** Audit record id (an event id for the DB adapter). */
  auditId: string;
}

/**
 * The budget ledger storage port. `reserve` and `increaseRunBudget` MUST be atomic and
 * race-safe: the DB adapter locks the run row `FOR UPDATE` so two concurrent reserves
 * never both fit past the limit; the in-memory fake reproduces the same serialised
 * check-and-insert critical section.
 */
export interface BudgetRepository {
  reserve(input: ReserveInput): Promise<ReserveOutcome>;
  reconcile(input: ReconcileInput): Promise<ReconcileOutcome>;
  release(input: ReleaseInput): Promise<{ released: boolean; ledger: LedgerSnapshot }>;
  getLedger(workspaceId: string, runId: string): Promise<LedgerSnapshot>;
  listReservations(workspaceId: string, runId: string): Promise<ReservationRecord[]>;
  increaseRunBudget(input: IncreaseLimitInput): Promise<IncreaseLimitOutcome>;
}
