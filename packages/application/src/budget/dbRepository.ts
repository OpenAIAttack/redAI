/**
 * DB-backed {@link BudgetRepository} over `@redai/db`. Transaction boundaries and the
 * race-safety live here (the unit tests use the in-memory fake).
 *
 * `reserve` runs inside one `withTransaction`: it locks the run row `FOR UPDATE`,
 * re-reads the ledger under that lock, and inserts the reservation only if
 *   committed_observed + unresolved_reserved + amount <= limit.
 * The row lock SERIALISES concurrent reservations for the same run, so two racers can
 * never both fit past the limit, and child agents (same run_id) compete on the one
 * shared ledger. `increaseRunBudget` is likewise atomic and appends an audit event in
 * the SAME transaction as the limit change.
 *
 * `unresolved_reserved` counts reservations in state `reserved` OR `unknown` — an
 * unknown (usage never arrived) stays HELD, never refunded to 0 (docs/11 §7).
 */
import { appendEvent, withTransaction } from '@redai/db';
import type { Executor, Pool } from '@redai/db';
import { InvalidBudgetIncreaseError, RunNotFoundError } from './errors.js';
import type {
  BudgetRepository,
  IncreaseLimitInput,
  IncreaseLimitOutcome,
  LedgerSnapshot,
  PricingConfig,
  ReconcileInput,
  ReconcileOutcome,
  ReleaseInput,
  ReservationRecord,
  ReserveInput,
  ReserveOutcome,
  ReservationState,
  UsageBasis,
  UsageEntryRecord,
} from './ports.js';

interface ReservationRow {
  id: string;
  workspace_id: string;
  project_id: string;
  run_id: string;
  agent_step_id: string | null;
  provider_attempt: number;
  reserved_micro_usd: string;
  state: ReservationState;
  pricing_snapshot: PricingConfig;
  request_fingerprint: string;
  created_at: Date;
  updated_at: Date;
}

interface UsageRow {
  id: string;
  workspace_id: string;
  project_id: string;
  run_id: string;
  reservation_id: string;
  provider_request_id: string | null;
  input_tokens: string | null;
  output_tokens: string | null;
  observed_micro_usd: string | null;
  basis: UsageBasis;
  created_at: Date;
}

function toReservation(row: ReservationRow): ReservationRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    runId: row.run_id,
    agentStepId: row.agent_step_id,
    providerAttempt: row.provider_attempt,
    reservedMicroUsd: BigInt(row.reserved_micro_usd),
    state: row.state,
    pricingSnapshot: row.pricing_snapshot,
    requestFingerprint: row.request_fingerprint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toUsage(row: UsageRow): UsageEntryRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    runId: row.run_id,
    reservationId: row.reservation_id,
    providerRequestId: row.provider_request_id,
    inputTokens: row.input_tokens === null ? null : BigInt(row.input_tokens),
    outputTokens: row.output_tokens === null ? null : BigInt(row.output_tokens),
    observedMicroUsd: row.observed_micro_usd === null ? null : BigInt(row.observed_micro_usd),
    basis: row.basis,
    createdAt: row.created_at,
  };
}

/** Read a run's limit (locking the run row when `lock` is set). Null when missing. */
async function readLimit(
  tx: Executor,
  workspaceId: string,
  runId: string,
  lock: boolean,
): Promise<bigint | null> {
  const res = await tx.query<{ budget_limit_micro_usd: string }>(
    `SELECT budget_limit_micro_usd FROM runs WHERE id = $1 AND workspace_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [runId, workspaceId],
  );
  const row = res.rows[0];
  return row ? BigInt(row.budget_limit_micro_usd) : null;
}

async function ledgerWithin(tx: Executor, runId: string, limit: bigint): Promise<LedgerSnapshot> {
  const reservedRes = await tx.query<{ reserved: string | null; unknown_count: string }>(
    `SELECT COALESCE(SUM(reserved_micro_usd), 0) AS reserved,
            COUNT(*) FILTER (WHERE state = 'unknown') AS unknown_count
       FROM budget_reservations
      WHERE run_id = $1 AND state IN ('reserved','unknown')`,
    [runId],
  );
  const committedRes = await tx.query<{ committed: string | null }>(
    `SELECT COALESCE(SUM(observed_micro_usd), 0) AS committed
       FROM usage_entries
      WHERE run_id = $1 AND observed_micro_usd IS NOT NULL`,
    [runId],
  );
  const reserved = BigInt(reservedRes.rows[0]?.reserved ?? '0');
  const committed = BigInt(committedRes.rows[0]?.committed ?? '0');
  const unknownCount = Number(reservedRes.rows[0]?.unknown_count ?? '0');
  const totalHeld = reserved + committed;
  return {
    runId,
    limitMicroUsd: limit,
    committedObservedMicroUsd: committed,
    unresolvedReservedMicroUsd: reserved,
    totalHeldMicroUsd: totalHeld,
    unknownReservationCount: unknownCount,
    remainingMicroUsd: limit - totalHeld,
  };
}

export function createDbBudgetRepository(pool: Pool): BudgetRepository {
  return {
    async reserve(input: ReserveInput): Promise<ReserveOutcome> {
      return withTransaction(pool, async (tx: Executor) => {
        const limit = await readLimit(tx, input.workspaceId, input.runId, true);
        if (limit === null) throw new RunNotFoundError();

        // Idempotent replay on (run_id, request_fingerprint).
        const existing = await tx.query<ReservationRow>(
          `SELECT * FROM budget_reservations WHERE run_id = $1 AND request_fingerprint = $2`,
          [input.runId, input.requestFingerprint],
        );
        if (existing.rows[0]) {
          return {
            kind: 'replayed' as const,
            reservation: toReservation(existing.rows[0]),
            ledger: await ledgerWithin(tx, input.runId, limit),
          };
        }

        const ledger = await ledgerWithin(tx, input.runId, limit);
        if (ledger.totalHeldMicroUsd + input.amountMicroUsd > limit) {
          return { kind: 'exceeded' as const, requested: input.amountMicroUsd, ledger };
        }

        const inserted = await tx.query<ReservationRow>(
          `INSERT INTO budget_reservations
             (workspace_id, project_id, run_id, agent_step_id, provider_attempt,
              reserved_micro_usd, state, pricing_snapshot, request_fingerprint, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'reserved', $7::jsonb, $8, $9, $9)
           RETURNING *`,
          [
            input.workspaceId,
            input.projectId,
            input.runId,
            input.agentStepId ?? null,
            input.providerAttempt,
            input.amountMicroUsd.toString(),
            JSON.stringify(input.pricingSnapshot),
            input.requestFingerprint,
            input.now,
          ],
        );
        const reservation = toReservation(inserted.rows[0]!);
        return {
          kind: 'reserved' as const,
          reservation,
          ledger: await ledgerWithin(tx, input.runId, limit),
        };
      });
    },

    async reconcile(input: ReconcileInput): Promise<ReconcileOutcome> {
      return withTransaction(pool, async (tx: Executor) => {
        const resv = await tx.query<ReservationRow>(
          `SELECT * FROM budget_reservations WHERE id = $1 AND run_id = $2 FOR UPDATE`,
          [input.reservationId, input.runId],
        );
        const row = resv.rows[0];
        const limit = await readLimit(tx, input.workspaceId, input.runId, false);
        if (!row || limit === null || row.state !== 'reserved') {
          return {
            kind: 'noop' as const,
            ledger: await ledgerWithin(tx, input.runId, limit ?? 0n),
          };
        }

        const held = input.basis === 'unknown' || input.observedMicroUsd === null;
        const newState: ReservationState = held ? 'unknown' : 'reconciled';

        const usageRes = await tx.query<UsageRow>(
          `INSERT INTO usage_entries
             (workspace_id, project_id, run_id, reservation_id, provider_request_id,
              input_tokens, output_tokens, observed_micro_usd, basis, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING *`,
          [
            input.workspaceId,
            row.project_id,
            input.runId,
            row.id,
            input.providerRequestId ?? null,
            input.inputTokens?.toString() ?? null,
            input.outputTokens?.toString() ?? null,
            input.observedMicroUsd === null ? null : input.observedMicroUsd.toString(),
            input.basis,
            input.now,
          ],
        );
        await tx.query(`UPDATE budget_reservations SET state = $2, updated_at = $3 WHERE id = $1`, [
          row.id,
          newState,
          input.now,
        ]);

        const ledger = await ledgerWithin(tx, input.runId, limit);
        const entry = toUsage(usageRes.rows[0]!);
        return held
          ? { kind: 'held_unknown' as const, entry, ledger }
          : { kind: 'reconciled' as const, entry, ledger };
      });
    },

    async release(input: ReleaseInput): Promise<{ released: boolean; ledger: LedgerSnapshot }> {
      return withTransaction(pool, async (tx: Executor) => {
        const limit = await readLimit(tx, input.workspaceId, input.runId, true);
        if (limit === null) throw new RunNotFoundError();
        const upd = await tx.query(
          `UPDATE budget_reservations SET state = 'released', updated_at = $3
             WHERE id = $1 AND run_id = $2 AND state = 'reserved'`,
          [input.reservationId, input.runId, input.now],
        );
        return {
          released: (upd.rowCount ?? 0) === 1,
          ledger: await ledgerWithin(tx, input.runId, limit),
        };
      });
    },

    async getLedger(workspaceId: string, runId: string): Promise<LedgerSnapshot> {
      const limit = await readLimit(pool, workspaceId, runId, false);
      if (limit === null) throw new RunNotFoundError();
      return ledgerWithin(pool, runId, limit);
    },

    async listReservations(workspaceId: string, runId: string): Promise<ReservationRecord[]> {
      const res = await pool.query<ReservationRow>(
        `SELECT * FROM budget_reservations WHERE workspace_id = $1 AND run_id = $2 ORDER BY created_at ASC`,
        [workspaceId, runId],
      );
      return res.rows.map(toReservation);
    },

    async increaseRunBudget(input: IncreaseLimitInput): Promise<IncreaseLimitOutcome> {
      return withTransaction(pool, async (tx: Executor) => {
        const current = await readLimit(tx, input.workspaceId, input.runId, true);
        if (current === null) throw new RunNotFoundError();
        if (input.newLimitMicroUsd < current) {
          throw new InvalidBudgetIncreaseError(
            'a budget increase must not lower the limit (docs/11 §7 controls, never silent shrink)',
          );
        }
        await tx.query(
          `UPDATE runs SET budget_limit_micro_usd = $2, updated_at = $3 WHERE id = $1`,
          [input.runId, input.newLimitMicroUsd.toString(), input.now],
        );
        const eventId = await appendEvent(tx, {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          runId: input.runId,
          eventType: 'budget.limit_increased',
          payload: {
            actor: input.actor,
            from_micro_usd: current.toString(),
            to_micro_usd: input.newLimitMicroUsd.toString(),
            reason: input.reason ?? null,
          },
        });
        return { limitMicroUsd: input.newLimitMicroUsd, auditId: eventId.toString() };
      });
    },
  };
}
