/**
 * Budget service (docs/11 §7) — pure orchestration over an injected
 * {@link BudgetRepository}, {@link PricingConfig} math and a {@link Clock}.
 *
 * Responsibilities:
 *   1. `reserve` — compute the conservative upper-bound reservation from pricing +
 *      context caps and reserve it BEFORE a request, atomically against the shared run
 *      ledger. Over-budget returns a discriminated outcome (the runtime stops new
 *      requests, docs/11 §7) rather than throwing.
 *   2. `reconcile` — turn provider {@link Usage} into an observed cost. Unknown usage
 *      is HELD (the reservation stays counted, never refunded to 0).
 *   3. `release` — release a reservation ONLY when the pre-send failure proves the
 *      request was never sent (docs/11 §7 "Failed pre-send có bằng chứng chưa gửi").
 *   4. `increaseLimit` — owner-only, audited budget increase.
 *
 * The service reads no globals and opens no sockets, so the unit tests drive it with
 * the in-memory fake.
 */
import { estimateReservation, observedCost } from './pricing.js';
import type {
  BudgetRepository,
  Clock,
  IncreaseLimitOutcome,
  LedgerSnapshot,
  PricingConfig,
  ReconcileOutcome,
  ReservationRecord,
  ReserveOutcome,
} from './ports.js';
import type { Usage } from '@redai/llm';

export interface BudgetServiceDeps {
  repo: BudgetRepository;
  clock?: Clock;
}

export interface ReserveRequestInput {
  workspaceId: string;
  projectId: string;
  runId: string;
  /** The agent step (child agent) this reservation belongs to; null for the root. */
  agentStepId?: string | null;
  providerAttempt: number;
  requestFingerprint: string;
  pricing: PricingConfig;
  /**
   * Conservative input-token upper bound. With no compatible tokenizer, pass the
   * CONFIGURED CONTEXT CAP (docs/11 §7) — never a low guess.
   */
  inputUpperBoundTokens: number;
  maxOutputTokens: number;
}

export interface ReconcileUsageInput {
  workspaceId: string;
  runId: string;
  reservationId: string;
  providerRequestId?: string | null;
  pricing: PricingConfig;
  usage: Usage;
}

export interface IncreaseLimitRequest {
  workspaceId: string;
  projectId: string;
  runId: string;
  newLimitMicroUsd: bigint;
  actor: string;
  reason?: string;
}

export class BudgetService {
  private readonly repo: BudgetRepository;
  private readonly clock: Clock;

  public constructor(deps: BudgetServiceDeps) {
    this.repo = deps.repo;
    this.clock = deps.clock ?? { now: () => new Date() };
  }

  /** Reserve budget for one model request against the shared run ledger. */
  async reserve(input: ReserveRequestInput): Promise<ReserveOutcome> {
    const amount = estimateReservation(
      input.pricing,
      input.inputUpperBoundTokens,
      input.maxOutputTokens,
    );
    return this.repo.reserve({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      runId: input.runId,
      agentStepId: input.agentStepId ?? null,
      providerAttempt: input.providerAttempt,
      requestFingerprint: input.requestFingerprint,
      amountMicroUsd: amount,
      pricingSnapshot: input.pricing,
      now: this.clock.now(),
    });
  }

  /** Reconcile a reservation with the provider usage (or hold it as unknown). */
  async reconcile(input: ReconcileUsageInput): Promise<ReconcileOutcome> {
    const cost = observedCost(input.pricing, input.usage);
    return this.repo.reconcile({
      workspaceId: input.workspaceId,
      runId: input.runId,
      reservationId: input.reservationId,
      providerRequestId: input.providerRequestId ?? null,
      observedMicroUsd: cost.observedMicroUsd,
      inputTokens: cost.inputTokens,
      outputTokens: cost.outputTokens,
      basis: cost.basis,
      now: this.clock.now(),
    });
  }

  /**
   * Release a reservation. ONLY call with proof the request was never sent (a pre-send
   * failure). An in-flight request whose result is unknown must be reconciled as
   * unknown, NOT released (docs/11 §7).
   */
  async release(input: {
    workspaceId: string;
    runId: string;
    reservationId: string;
  }): Promise<{ released: boolean; ledger: LedgerSnapshot }> {
    return this.repo.release({ ...input, now: this.clock.now() });
  }

  async getLedger(workspaceId: string, runId: string): Promise<LedgerSnapshot> {
    return this.repo.getLedger(workspaceId, runId);
  }

  async listReservations(workspaceId: string, runId: string): Promise<ReservationRecord[]> {
    return this.repo.listReservations(workspaceId, runId);
  }

  /** Owner-only, audited increase of a run's budget limit (docs/11 §7). */
  async increaseLimit(input: IncreaseLimitRequest): Promise<IncreaseLimitOutcome> {
    return this.repo.increaseRunBudget({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      runId: input.runId,
      newLimitMicroUsd: input.newLimitMicroUsd,
      actor: input.actor,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      now: this.clock.now(),
    });
  }
}
