/**
 * The reservation SEAM the runtime calls (docs/11 §7). This is the clean port the
 * coordinator wires into the durable model-call path — right BEFORE a provider
 * round-trip in `AskService.runStep` / `AgentService` (see the T14 report), and again
 * AFTER the round-trip to reconcile the provider usage.
 *
 * Keeping the seam this thin means T13's committed runtime files need only two calls:
 *   1. `const r = await gateway.reserveForModelCall(...)` before `provider.generate`.
 *      If `!r.ok`, the runtime stops NEW requests (parks/fails the run with
 *      BUDGET_EXCEEDED) without hiding the overrun — it never silently continues.
 *   2. `await gateway.reconcileModelCall({ reservationId: r.reservationId, usage })`
 *      after the round-trip. Unknown usage is HELD, not refunded to 0.
 *   3. On a PROVEN pre-send failure (the request was never sent), the runtime may call
 *      `gateway.releaseModelCall(...)`.
 */
import { BudgetService } from './service.js';
import type { PricingConfig, LedgerSnapshot } from './ports.js';
import type { Usage } from '@redai/llm';

export interface ReserveForModelCallInput {
  workspaceId: string;
  projectId: string;
  runId: string;
  /** The child agent step this call belongs to (null for the root run). */
  agentStepId?: string | null;
  /** Distinct per provider attempt so a retry reserves separately. */
  providerAttempt: number;
  /** Idempotency within the run: same fingerprint replays the same reservation. */
  requestFingerprint: string;
  pricing: PricingConfig;
  /** Conservative input upper bound; pass the configured context cap when unsure. */
  inputUpperBoundTokens: number;
  maxOutputTokens: number;
}

export type ReserveForModelCallResult =
  | { ok: true; reservationId: string; replayed: boolean; ledger: LedgerSnapshot }
  | { ok: false; requestedMicroUsd: bigint; ledger: LedgerSnapshot };

export interface ReconcileModelCallInput {
  workspaceId: string;
  runId: string;
  reservationId: string;
  providerRequestId?: string | null;
  pricing: PricingConfig;
  usage: Usage;
}

export interface ReservationGateway {
  reserveForModelCall(input: ReserveForModelCallInput): Promise<ReserveForModelCallResult>;
  reconcileModelCall(input: ReconcileModelCallInput): Promise<LedgerSnapshot>;
  releaseModelCall(input: {
    workspaceId: string;
    runId: string;
    reservationId: string;
  }): Promise<LedgerSnapshot>;
}

/** Build the runtime-facing reservation gateway over a {@link BudgetService}. */
export function createReservationGateway(service: BudgetService): ReservationGateway {
  return {
    async reserveForModelCall(input) {
      const outcome = await service.reserve({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        runId: input.runId,
        agentStepId: input.agentStepId ?? null,
        providerAttempt: input.providerAttempt,
        requestFingerprint: input.requestFingerprint,
        pricing: input.pricing,
        inputUpperBoundTokens: input.inputUpperBoundTokens,
        maxOutputTokens: input.maxOutputTokens,
      });
      if (outcome.kind === 'exceeded') {
        return { ok: false, requestedMicroUsd: outcome.requested, ledger: outcome.ledger };
      }
      return {
        ok: true,
        reservationId: outcome.reservation.id,
        replayed: outcome.kind === 'replayed',
        ledger: outcome.ledger,
      };
    },

    async reconcileModelCall(input) {
      const outcome = await service.reconcile(input);
      return outcome.ledger;
    },

    async releaseModelCall(input) {
      const { ledger } = await service.release(input);
      return ledger;
    },
  };
}
