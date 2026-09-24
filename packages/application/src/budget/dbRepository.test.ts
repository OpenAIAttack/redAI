/**
 * Live-PostgreSQL integration test for the DB-backed budget repository (docs/11 §7).
 *
 * Gated on DATABASE_URL: when it is unset the suite SKIPS loudly (never a silent
 * green). It creates its own throwaway database on the cluster named by DATABASE_URL,
 * runs the real migrations, and exercises the ATOMIC reserve/reconcile paths against
 * actual SQL — including the `FOR UPDATE` row lock that keeps two concurrent
 * reservations from over-committing the shared run ledger, child requests competing on
 * the same budget, unknown usage HELD (never refunded to 0), and the audited
 * owner budget increase.
 *
 * Imports @redai/db from the workspace package (built) and the module under test by
 * relative source path (D09 pattern).
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrate } from '@redai/db';
import type { Pool } from '@redai/db';
import { createDbBudgetRepository } from './dbRepository.js';
import { BudgetService } from './service.js';
import type { PricingConfig } from './ports.js';
import type { Usage } from '@redai/llm';

const DATABASE_URL = process.env['DATABASE_URL'];
const HAS_DB = typeof DATABASE_URL === 'string' && DATABASE_URL.length > 0;

if (!HAS_DB) {
  console.warn(
    '\n[T14] DATABASE_URL is not set — the budget DB suite is SKIPPED.\n' +
      '      Start a throwaway PostgreSQL 16 cluster and export DATABASE_URL, then re-run:\n' +
      '        pnpm exec vitest run packages/application/src/budget/dbRepository.test.ts\n',
  );
}

const describeDb = HAS_DB ? describe : describe.skip;

const PRICING: PricingConfig = {
  version: 'test-2026-09',
  provenance: 'manual',
  inputMicroUsdPerMillion: 1_000_000,
  outputMicroUsdPerMillion: 1_000_000,
};

function urlForDatabase(base: string, dbName: string): string {
  const u = new URL(base);
  u.pathname = `/${dbName}`;
  return u.toString();
}

describeDb('budget DB repository (live PG)', () => {
  let pool: Pool;
  let dbName: string;
  let workspaceId: string;
  let projectId: string;
  let providerConfigId: string;

  beforeAll(async () => {
    dbName = `redai_t14_${randomBytes(6).toString('hex')}`;
    const admin = createPool({ connectionString: DATABASE_URL!, max: 1 });
    try {
      await admin.query(`CREATE DATABASE ${dbName}`);
    } finally {
      await admin.end();
    }
    pool = createPool({ connectionString: urlForDatabase(DATABASE_URL!, dbName), max: 6 });
    await migrate(pool);

    const ws = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (name, installation_id) VALUES ('redAI', gen_random_uuid()) RETURNING id`,
    );
    workspaceId = ws.rows[0]!.id;
    const proj = await pool.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, name) VALUES ($1, 'P') RETURNING id`,
      [workspaceId],
    );
    projectId = proj.rows[0]!.id;
    const pc = await pool.query<{ id: string }>(
      `INSERT INTO provider_configs (workspace_id, display_name, config) VALUES ($1, 'pc', '{}'::jsonb) RETURNING id`,
      [workspaceId],
    );
    providerConfigId = pc.rows[0]!.id;
  });

  afterAll(async () => {
    if (pool) await pool.end().catch(() => {});
    if (HAS_DB && dbName) {
      const admin = createPool({ connectionString: DATABASE_URL!, max: 1 });
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    }
  });

  async function newRun(limitMicroUsd: bigint): Promise<string> {
    // Each run gets its OWN chat: `one_active_run_per_chat` forbids two active runs
    // on one chat, and every run here starts in the default 'queued' (active) state.
    const chat = await pool.query<{ id: string }>(
      `INSERT INTO chats (workspace_id, project_id, title) VALUES ($1, $2, 'C') RETURNING id`,
      [workspaceId, projectId],
    );
    const runChatId = chat.rows[0]!.id;
    const res = await pool.query<{ id: string }>(
      `INSERT INTO runs
         (workspace_id, project_id, chat_id, mode, provider_config_id, config_snapshot,
          budget_limit_micro_usd, expires_at)
       VALUES ($1, $2, $3, 'agent', $4, '{}'::jsonb, $5, now() + interval '1 day')
       RETURNING id`,
      [workspaceId, projectId, runChatId, providerConfigId, limitMicroUsd.toString()],
    );
    return res.rows[0]!.id;
  }

  function service(): BudgetService {
    return new BudgetService({ repo: createDbBudgetRepository(pool) });
  }

  const baseReserve = (runId: string) => ({
    workspaceId,
    projectId,
    runId,
    pricing: PRICING,
    inputUpperBoundTokens: 100,
    maxOutputTokens: 100,
  });

  it('reserves against the run limit and persists a reservation row', async () => {
    const svc = service();
    const runId = await newRun(10_000n);
    const out = await svc.reserve({
      ...baseReserve(runId),
      providerAttempt: 1,
      requestFingerprint: 'fp1',
    });
    expect(out.kind).toBe('reserved');
    const rows = await pool.query<{ reserved_micro_usd: string; state: string }>(
      `SELECT reserved_micro_usd, state FROM budget_reservations WHERE run_id = $1`,
      [runId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.reserved_micro_usd).toBe('200');
    expect(rows.rows[0]!.state).toBe('reserved');
  });

  it('two concurrent reservations never over-commit the ledger (FOR UPDATE race)', async () => {
    const svc = service();
    const runId = await newRun(300n); // room for exactly one 200 µUSD reservation
    const results = await Promise.allSettled([
      svc.reserve({ ...baseReserve(runId), providerAttempt: 1, requestFingerprint: 'A' }),
      svc.reserve({ ...baseReserve(runId), providerAttempt: 2, requestFingerprint: 'B' }),
    ]);
    const outcomes = results.map((r) => (r.status === 'fulfilled' ? r.value.kind : 'error'));
    expect(outcomes.filter((k) => k === 'reserved')).toHaveLength(1);
    expect(outcomes.filter((k) => k === 'exceeded')).toHaveLength(1);

    const ledger = await svc.getLedger(workspaceId, runId);
    expect(ledger.unresolvedReservedMicroUsd).toBe(200n);
    expect(ledger.totalHeldMicroUsd <= ledger.limitMicroUsd).toBe(true);
  });

  it('child requests compete for the same shared run budget', async () => {
    const svc = service();
    const runId = await newRun(500n);
    const root = await svc.reserve({
      ...baseReserve(runId),
      providerAttempt: 1,
      requestFingerprint: 'root',
      agentStepId: null,
    });
    const child1 = await svc.reserve({
      ...baseReserve(runId),
      providerAttempt: 1,
      requestFingerprint: 'c1',
      agentStepId: null,
    });
    const child2 = await svc.reserve({
      ...baseReserve(runId),
      providerAttempt: 1,
      requestFingerprint: 'c2',
      agentStepId: null,
    });
    expect(root.kind).toBe('reserved');
    expect(child1.kind).toBe('reserved');
    expect(child2.kind).toBe('exceeded');
  });

  it('reconciles known usage: reserved replaced by observed cost', async () => {
    const svc = service();
    const runId = await newRun(10_000n);
    const r = await svc.reserve({
      ...baseReserve(runId),
      providerAttempt: 1,
      requestFingerprint: 'fp1',
    });
    if (r.kind !== 'reserved') throw new Error('unreachable');
    const usage: Usage = { kind: 'known', inputTokens: 40, outputTokens: 10, totalTokens: 50 };
    const out = await svc.reconcile({
      workspaceId,
      runId,
      reservationId: r.reservation.id,
      pricing: PRICING,
      usage,
    });
    expect(out.kind).toBe('reconciled');
    const ledger = await svc.getLedger(workspaceId, runId);
    expect(ledger.committedObservedMicroUsd).toBe(50n);
    expect(ledger.unresolvedReservedMicroUsd).toBe(0n);

    const row = await pool.query<{ state: string; basis: string; observed_micro_usd: string }>(
      `SELECT r.state, u.basis, u.observed_micro_usd
         FROM budget_reservations r JOIN usage_entries u ON u.reservation_id = r.id
        WHERE r.id = $1`,
      [r.reservation.id],
    );
    expect(row.rows[0]!.state).toBe('reconciled');
    expect(row.rows[0]!.basis).toBe('provider');
    expect(row.rows[0]!.observed_micro_usd).toBe('50');
  });

  it('HOLDS unknown usage as unknown — never recorded as 0', async () => {
    const svc = service();
    const runId = await newRun(10_000n);
    const r = await svc.reserve({
      ...baseReserve(runId),
      providerAttempt: 1,
      requestFingerprint: 'fp1',
    });
    if (r.kind !== 'reserved') throw new Error('unreachable');
    const out = await svc.reconcile({
      workspaceId,
      runId,
      reservationId: r.reservation.id,
      pricing: PRICING,
      usage: { kind: 'unknown' },
    });
    expect(out.kind).toBe('held_unknown');
    const ledger = await svc.getLedger(workspaceId, runId);
    expect(ledger.unresolvedReservedMicroUsd).toBe(200n); // still HELD
    expect(ledger.unknownReservationCount).toBe(1);

    const row = await pool.query<{
      state: string;
      basis: string;
      observed_micro_usd: string | null;
    }>(
      `SELECT r.state, u.basis, u.observed_micro_usd
         FROM budget_reservations r JOIN usage_entries u ON u.reservation_id = r.id
        WHERE r.id = $1`,
      [r.reservation.id],
    );
    expect(row.rows[0]!.state).toBe('unknown');
    expect(row.rows[0]!.basis).toBe('unknown');
    expect(row.rows[0]!.observed_micro_usd).toBeNull(); // NOT 0
  });

  it('idempotent reserve replay on (run, fingerprint)', async () => {
    const svc = service();
    const runId = await newRun(10_000n);
    const a = await svc.reserve({
      ...baseReserve(runId),
      providerAttempt: 1,
      requestFingerprint: 'dup',
    });
    const b = await svc.reserve({
      ...baseReserve(runId),
      providerAttempt: 1,
      requestFingerprint: 'dup',
    });
    if (a.kind !== 'reserved' || b.kind !== 'replayed') throw new Error('unreachable');
    expect(b.reservation.id).toBe(a.reservation.id);
    const rows = await pool.query(
      `SELECT count(*) AS n FROM budget_reservations WHERE run_id = $1`,
      [runId],
    );
    expect(Number((rows.rows[0] as { n: string }).n)).toBe(1);
  });

  it('owner budget increase updates the limit and appends an audit event', async () => {
    const svc = service();
    const runId = await newRun(300n);
    const out = await svc.increaseLimit({
      workspaceId,
      projectId,
      runId,
      newLimitMicroUsd: 5_000n,
      actor: 'owner',
      reason: 'headroom',
    });
    expect(out.limitMicroUsd).toBe(5_000n);

    const run = await pool.query<{ budget_limit_micro_usd: string }>(
      `SELECT budget_limit_micro_usd FROM runs WHERE id = $1`,
      [runId],
    );
    expect(run.rows[0]!.budget_limit_micro_usd).toBe('5000');

    const ev = await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM events WHERE run_id = $1 AND event_type = 'budget.limit_increased'`,
      [runId],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]!.payload['actor']).toBe('owner');
    expect(ev.rows[0]!.payload['from_micro_usd']).toBe('300');
    expect(ev.rows[0]!.payload['to_micro_usd']).toBe('5000');
  });
});
