/**
 * Budget-service unit tests over the in-memory fake (docs/11 §7, §9):
 *   - reserve BEFORE a request; the shared per-run ledger enforces the invariant
 *     committed + reserved + new <= limit.
 *   - parallel reservations never over-commit the ledger (race).
 *   - child requests compete for the SAME run budget (max_children semantics).
 *   - missing provider usage → HELD as unknown, never recorded as 0.
 *   - pricing-version-aware cost; reconcile replaces reserved with observed.
 *   - owner budget increase is audited; a decrease is rejected.
 */
import { describe, expect, it } from 'vitest';
import { BudgetService } from './service.js';
import { InMemoryBudgetRepository } from './memoryRepository.js';
import type { PricingConfig } from './ports.js';
import type { Usage } from '@redai/llm';

const PRICING: PricingConfig = {
  version: 'test-2026-09',
  provenance: 'manual',
  inputMicroUsdPerMillion: 1_000_000, // 1 µUSD per token
  outputMicroUsdPerMillion: 1_000_000,
};

function fixedClock(): { now: () => Date } {
  return { now: () => new Date('2026-09-24T00:00:00.000Z') };
}

function svc(limit: bigint): {
  service: BudgetService;
  repo: InMemoryBudgetRepository;
  runId: string;
} {
  const repo = new InMemoryBudgetRepository();
  const runId = 'run-1';
  repo.setRunLimit(runId, limit);
  return { service: new BudgetService({ repo, clock: fixedClock() }), repo, runId };
}

const base = {
  workspaceId: 'ws',
  projectId: 'proj',
  runId: 'run-1',
  pricing: PRICING,
  maxOutputTokens: 100,
  inputUpperBoundTokens: 100,
};

describe('BudgetService.reserve', () => {
  it('reserves the conservative estimate and reduces remaining budget', async () => {
    const { service } = svc(10_000n);
    const out = await service.reserve({ ...base, providerAttempt: 1, requestFingerprint: 'fp1' });
    expect(out.kind).toBe('reserved');
    // 100 input + 100 output tokens at 1 µUSD/token = 200 µUSD
    if (out.kind !== 'reserved') throw new Error('unreachable');
    expect(out.reservation.reservedMicroUsd).toBe(200n);
    expect(out.ledger.unresolvedReservedMicroUsd).toBe(200n);
    expect(out.ledger.remainingMicroUsd).toBe(9_800n);
  });

  it('rejects a reservation that would exceed the run budget (no silent overrun)', async () => {
    const { service } = svc(300n);
    await service.reserve({ ...base, providerAttempt: 1, requestFingerprint: 'fp1' }); // 200 held
    const out = await service.reserve({ ...base, providerAttempt: 2, requestFingerprint: 'fp2' });
    expect(out.kind).toBe('exceeded');
    if (out.kind !== 'exceeded') throw new Error('unreachable');
    expect(out.requested).toBe(200n);
    expect(out.ledger.unresolvedReservedMicroUsd).toBe(200n); // unchanged
  });

  it('is idempotent on (run, request_fingerprint) — a replay does not double-charge', async () => {
    const { service } = svc(10_000n);
    const a = await service.reserve({ ...base, providerAttempt: 1, requestFingerprint: 'fp1' });
    const b = await service.reserve({ ...base, providerAttempt: 1, requestFingerprint: 'fp1' });
    expect(b.kind).toBe('replayed');
    if (a.kind !== 'reserved' || b.kind !== 'replayed') throw new Error('unreachable');
    expect(b.reservation.id).toBe(a.reservation.id);
    expect(b.ledger.unresolvedReservedMicroUsd).toBe(200n);
  });

  it('parallel reservations never over-commit the ledger (race)', async () => {
    // Limit fits exactly ONE 200 µUSD reservation; two race for it.
    const { service, repo } = svc(300n);
    const results = await Promise.all([
      service.reserve({ ...base, providerAttempt: 1, requestFingerprint: 'fpA' }),
      service.reserve({ ...base, providerAttempt: 2, requestFingerprint: 'fpB' }),
    ]);
    const reserved = results.filter((r) => r.kind === 'reserved');
    const exceeded = results.filter((r) => r.kind === 'exceeded');
    expect(reserved).toHaveLength(1);
    expect(exceeded).toHaveLength(1);
    const ledger = await repo.getLedger('ws', 'run-1');
    expect(ledger.unresolvedReservedMicroUsd).toBe(200n);
    expect(ledger.totalHeldMicroUsd).toBeLessThanOrEqual(ledger.limitMicroUsd);
  });

  it('child requests compete for the SAME run budget', async () => {
    // limit 500; each reservation 200. root + one child fit (400); a second child (600) does not.
    const { service } = svc(500n);
    const root = await service.reserve({
      ...base,
      providerAttempt: 1,
      requestFingerprint: 'root',
      agentStepId: null,
    });
    const child1 = await service.reserve({
      ...base,
      providerAttempt: 1,
      requestFingerprint: 'child1',
      agentStepId: 'step-a',
    });
    const child2 = await service.reserve({
      ...base,
      providerAttempt: 1,
      requestFingerprint: 'child2',
      agentStepId: 'step-b',
    });
    expect(root.kind).toBe('reserved');
    expect(child1.kind).toBe('reserved');
    expect(child2.kind).toBe('exceeded'); // shared ledger is full at 400/500
  });
});

describe('BudgetService.reconcile', () => {
  it('reconciles KNOWN usage: reserved is replaced by observed cost', async () => {
    const { service, repo } = svc(10_000n);
    const r = await service.reserve({ ...base, providerAttempt: 1, requestFingerprint: 'fp1' });
    if (r.kind !== 'reserved') throw new Error('unreachable');
    const usage: Usage = { kind: 'known', inputTokens: 40, outputTokens: 10, totalTokens: 50 };
    const out = await service.reconcile({
      workspaceId: 'ws',
      runId: 'run-1',
      reservationId: r.reservation.id,
      pricing: PRICING,
      usage,
    });
    expect(out.kind).toBe('reconciled');
    const ledger = await repo.getLedger('ws', 'run-1');
    // observed = 40 + 10 = 50 µUSD committed; the 200 reserved is released.
    expect(ledger.committedObservedMicroUsd).toBe(50n);
    expect(ledger.unresolvedReservedMicroUsd).toBe(0n);
    expect(ledger.totalHeldMicroUsd).toBe(50n);
  });

  it('HOLDS unknown usage: never recorded as 0, stays reserved', async () => {
    const { service, repo } = svc(10_000n);
    const r = await service.reserve({ ...base, providerAttempt: 1, requestFingerprint: 'fp1' });
    if (r.kind !== 'reserved') throw new Error('unreachable');
    const out = await service.reconcile({
      workspaceId: 'ws',
      runId: 'run-1',
      reservationId: r.reservation.id,
      pricing: PRICING,
      usage: { kind: 'unknown' },
    });
    if (out.kind !== 'held_unknown') throw new Error('unreachable');
    expect(out.entry.basis).toBe('unknown');
    expect(out.entry.observedMicroUsd).toBeNull();
    const ledger = await repo.getLedger('ws', 'run-1');
    expect(ledger.committedObservedMicroUsd).toBe(0n);
    expect(ledger.unresolvedReservedMicroUsd).toBe(200n); // HELD, not 0
    expect(ledger.unknownReservationCount).toBe(1);
  });

  it('a local zero-model-cost provider records observed 0 with a distinct basis', async () => {
    const local: PricingConfig = { ...PRICING, localZeroModelCost: true };
    const { service, repo } = svc(10_000n);
    const r = await service.reserve({
      ...base,
      pricing: local,
      providerAttempt: 1,
      requestFingerprint: 'fp1',
    });
    if (r.kind !== 'reserved') throw new Error('unreachable');
    expect(r.reservation.reservedMicroUsd).toBe(0n); // local declares 0 api cost
    const out = await service.reconcile({
      workspaceId: 'ws',
      runId: 'run-1',
      reservationId: r.reservation.id,
      pricing: local,
      usage: { kind: 'known', inputTokens: 100, outputTokens: 100, totalTokens: 200 },
    });
    if (out.kind !== 'reconciled') throw new Error('unreachable');
    expect(out.entry.basis).toBe('local_zero_model_cost');
    expect(out.entry.observedMicroUsd).toBe(0n);
    const ledger = await repo.getLedger('ws', 'run-1');
    expect(ledger.committedObservedMicroUsd).toBe(0n);
  });

  it('reconcile is idempotent (a second call is a noop)', async () => {
    const { service } = svc(10_000n);
    const r = await service.reserve({ ...base, providerAttempt: 1, requestFingerprint: 'fp1' });
    if (r.kind !== 'reserved') throw new Error('unreachable');
    const usage: Usage = { kind: 'known', inputTokens: 10, outputTokens: 10, totalTokens: 20 };
    await service.reconcile({
      workspaceId: 'ws',
      runId: 'run-1',
      reservationId: r.reservation.id,
      pricing: PRICING,
      usage,
    });
    const again = await service.reconcile({
      workspaceId: 'ws',
      runId: 'run-1',
      reservationId: r.reservation.id,
      pricing: PRICING,
      usage,
    });
    expect(again.kind).toBe('noop');
  });
});

describe('BudgetService.release', () => {
  it('releases a reservation on a proven pre-send failure', async () => {
    const { service, repo } = svc(10_000n);
    const r = await service.reserve({ ...base, providerAttempt: 1, requestFingerprint: 'fp1' });
    if (r.kind !== 'reserved') throw new Error('unreachable');
    const out = await service.release({
      workspaceId: 'ws',
      runId: 'run-1',
      reservationId: r.reservation.id,
    });
    expect(out.released).toBe(true);
    const ledger = await repo.getLedger('ws', 'run-1');
    expect(ledger.unresolvedReservedMicroUsd).toBe(0n);
  });
});

describe('BudgetService.increaseLimit', () => {
  it('raises the run budget and records an audit entry', async () => {
    const { service, repo } = svc(300n);
    const out = await service.increaseLimit({
      workspaceId: 'ws',
      projectId: 'proj',
      runId: 'run-1',
      newLimitMicroUsd: 1_000n,
      actor: 'owner',
      reason: 'run needs more headroom',
    });
    expect(out.limitMicroUsd).toBe(1_000n);
    expect(repo.audit).toHaveLength(1);
    expect(repo.audit[0]!.fromMicroUsd).toBe(300n);
    expect(repo.audit[0]!.toMicroUsd).toBe(1_000n);
    expect(repo.audit[0]!.actor).toBe('owner');
    const ledger = await repo.getLedger('ws', 'run-1');
    expect(ledger.limitMicroUsd).toBe(1_000n);
  });

  it('rejects a decrease (never a silent shrink)', async () => {
    const { service } = svc(1_000n);
    await expect(
      service.increaseLimit({
        workspaceId: 'ws',
        projectId: 'proj',
        runId: 'run-1',
        newLimitMicroUsd: 500n,
        actor: 'owner',
      }),
    ).rejects.toThrow(/must not lower/);
  });
});
