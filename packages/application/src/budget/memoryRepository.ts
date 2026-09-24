/**
 * In-memory {@link BudgetRepository} fake for unit tests. It reproduces the DB
 * adapter's ATOMICITY: `reserve` and `increaseRunBudget` do their read-check-write in
 * ONE synchronous critical section (no `await` between the ledger read and the
 * insert), so two reservations raced with `Promise.all` can never both slip past the
 * limit — exactly the guarantee the DB gets from a `FOR UPDATE` row lock.
 *
 * It is NOT a persistence layer; it holds run limits, reservations, usage entries and
 * an audit log in memory for the tests that drive {@link BudgetService}.
 */
import { randomUUID } from 'node:crypto';
import { InvalidBudgetIncreaseError, RunNotFoundError } from './errors.js';
import type {
  BudgetRepository,
  IncreaseLimitInput,
  IncreaseLimitOutcome,
  LedgerSnapshot,
  ReconcileInput,
  ReconcileOutcome,
  ReleaseInput,
  ReservationRecord,
  ReserveInput,
  ReserveOutcome,
  UsageEntryRecord,
} from './ports.js';

export interface BudgetAuditEntry {
  id: string;
  runId: string;
  actor: string;
  fromMicroUsd: bigint;
  toMicroUsd: bigint;
  reason: string | null;
  at: Date;
}

export class InMemoryBudgetRepository implements BudgetRepository {
  private readonly limits = new Map<string, bigint>();
  private readonly reservations = new Map<string, ReservationRecord>();
  private readonly usage = new Map<string, UsageEntryRecord>(); // keyed by reservationId
  public readonly audit: BudgetAuditEntry[] = [];

  /** Seed (or reset) a run's budget limit before reserving against it. */
  public setRunLimit(runId: string, limitMicroUsd: bigint): void {
    this.limits.set(runId, limitMicroUsd);
  }

  private requireLimit(runId: string): bigint {
    const limit = this.limits.get(runId);
    if (limit === undefined) throw new RunNotFoundError();
    return limit;
  }

  private snapshot(runId: string): LedgerSnapshot {
    const limit = this.requireLimit(runId);
    let committed = 0n;
    let reserved = 0n;
    let unknownCount = 0;
    for (const r of this.reservations.values()) {
      if (r.runId !== runId) continue;
      if (r.state === 'reserved' || r.state === 'unknown') {
        reserved += r.reservedMicroUsd;
        if (r.state === 'unknown') unknownCount += 1;
      } else if (r.state === 'reconciled') {
        const u = this.usage.get(r.id);
        if (u?.observedMicroUsd != null) committed += u.observedMicroUsd;
      }
    }
    const totalHeld = committed + reserved;
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

  // NOTE: intentionally synchronous body wrapped in a resolved promise — the critical
  // section runs to completion before any other microtask, mirroring the row lock.
  async reserve(input: ReserveInput): Promise<ReserveOutcome> {
    const limit = this.requireLimit(input.runId);

    // Idempotent replay on (runId, fingerprint).
    for (const r of this.reservations.values()) {
      if (r.runId === input.runId && r.requestFingerprint === input.requestFingerprint) {
        return { kind: 'replayed', reservation: r, ledger: this.snapshot(input.runId) };
      }
    }

    const current = this.snapshot(input.runId);
    if (current.totalHeldMicroUsd + input.amountMicroUsd > limit) {
      return { kind: 'exceeded', requested: input.amountMicroUsd, ledger: current };
    }

    const record: ReservationRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      runId: input.runId,
      agentStepId: input.agentStepId ?? null,
      providerAttempt: input.providerAttempt,
      reservedMicroUsd: input.amountMicroUsd,
      state: 'reserved',
      pricingSnapshot: input.pricingSnapshot,
      requestFingerprint: input.requestFingerprint,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.reservations.set(record.id, record);
    return { kind: 'reserved', reservation: record, ledger: this.snapshot(input.runId) };
  }

  async reconcile(input: ReconcileInput): Promise<ReconcileOutcome> {
    const r = this.reservations.get(input.reservationId);
    if (!r || r.runId !== input.runId) {
      return { kind: 'noop', ledger: this.snapshot(input.runId) };
    }
    if (r.state !== 'reserved') {
      // Already reconciled/released/unknown — idempotent.
      return { kind: 'noop', ledger: this.snapshot(input.runId) };
    }

    const entry: UsageEntryRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      projectId: r.projectId,
      runId: input.runId,
      reservationId: r.id,
      providerRequestId: input.providerRequestId ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      observedMicroUsd: input.observedMicroUsd,
      basis: input.basis,
      createdAt: input.now,
    };
    this.usage.set(r.id, entry);

    if (input.basis === 'unknown' || input.observedMicroUsd === null) {
      // HELD: the reservation stays counted, never refunded to 0.
      this.reservations.set(r.id, { ...r, state: 'unknown', updatedAt: input.now });
      return { kind: 'held_unknown', entry, ledger: this.snapshot(input.runId) };
    }
    this.reservations.set(r.id, { ...r, state: 'reconciled', updatedAt: input.now });
    return { kind: 'reconciled', entry, ledger: this.snapshot(input.runId) };
  }

  async release(input: ReleaseInput): Promise<{ released: boolean; ledger: LedgerSnapshot }> {
    const r = this.reservations.get(input.reservationId);
    if (!r || r.runId !== input.runId || r.state !== 'reserved') {
      return { released: false, ledger: this.snapshot(input.runId) };
    }
    this.reservations.set(r.id, { ...r, state: 'released', updatedAt: input.now });
    return { released: true, ledger: this.snapshot(input.runId) };
  }

  async getLedger(_workspaceId: string, runId: string): Promise<LedgerSnapshot> {
    return this.snapshot(runId);
  }

  async listReservations(_workspaceId: string, runId: string): Promise<ReservationRecord[]> {
    return [...this.reservations.values()]
      .filter((r) => r.runId === runId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async increaseRunBudget(input: IncreaseLimitInput): Promise<IncreaseLimitOutcome> {
    const current = this.requireLimit(input.runId);
    if (input.newLimitMicroUsd < current) {
      throw new InvalidBudgetIncreaseError(
        'a budget increase must not lower the limit (docs/11 §7 controls, never silent shrink)',
      );
    }
    this.limits.set(input.runId, input.newLimitMicroUsd);
    const audit: BudgetAuditEntry = {
      id: randomUUID(),
      runId: input.runId,
      actor: input.actor,
      fromMicroUsd: current,
      toMicroUsd: input.newLimitMicroUsd,
      reason: input.reason ?? null,
      at: input.now,
    };
    this.audit.push(audit);
    return { limitMicroUsd: input.newLimitMicroUsd, auditId: audit.id };
  }
}
