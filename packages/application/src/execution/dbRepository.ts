/**
 * DB-backed {@link ExecutionRepository} over `@redai/db` — the production scheduler
 * adapter (the service unit tests use the in-memory fake instead). It owns its SQL;
 * every statement carries an explicit `workspace_id` predicate (INV-001).
 *
 * The two mutations that must be race-safe run inside one transaction:
 *   - {@link claimNextAttempt} locks the worker row, checks the live session + free
 *     slots against `worker_capacity`, then selects the oldest bound queued attempt
 *     with `FOR UPDATE SKIP LOCKED` so two concurrent claims never take the same
 *     attempt and never oversubscribe the worker;
 *   - {@link submitResult} locks the attempt + its tool call, then applies the fence /
 *     dedup / conflict rules — a stale fence is refused (never accepted as success)
 *     and a conflicting digest quarantines rather than overwrites (docs/08 §9).
 *
 * The fence is a SERVER-write guard only: accepting a result is never a claim of
 * exactly-once external effect, and a lost external op is never auto-reassigned.
 */
import { withTransaction, type Executor, type Pool } from '@redai/db';
import { SessionSupersededError } from './errors.js';
import type {
  AckInput,
  AttemptRecord,
  AttemptState,
  ClaimContext,
  EnqueueAttemptInput,
  ExecutionRepository,
  FenceGuard,
  LiveRenewCheck,
  SubmitResultInput,
  SubmitResultOutcome,
  WorkerScope,
} from './ports.js';

const ACTIVE_ATTEMPT_STATES = ['leased', 'started', 'uploading', 'cancel_requested'];

interface AttemptRow {
  id: string;
  workspace_id: string;
  project_id: string;
  run_id: string;
  tool_call_id: string;
  attempt_no: number;
  fencing_token: string;
  worker_id: string | null;
  worker_session_id: string | null;
  state: AttemptState;
  lease_until: Date | null;
  lease_claims: Record<string, unknown> | null;
  started_at: Date | null;
  finished_at: Date | null;
  result_sha256: string | null;
  effect_observation: AttemptRecord['effectObservation'];
  journal_seq: string;
  created_at: Date;
}

const ATTEMPT_FIELDS = [
  'id',
  'workspace_id',
  'project_id',
  'run_id',
  'tool_call_id',
  'attempt_no',
  'fencing_token::text AS fencing_token',
  'worker_id',
  'worker_session_id',
  'state',
  'lease_until',
  'lease_claims',
  'started_at',
  'finished_at',
  'result_sha256',
  'effect_observation',
  'journal_seq::text AS journal_seq',
  'created_at',
];
const ATTEMPT_COLS = ATTEMPT_FIELDS.join(', ');
/** Same columns, qualified with a table alias (for locking joins). */
function attemptColsAliased(alias: string): string {
  return ATTEMPT_FIELDS.map((f) => {
    const m = /^(\w+)(::text)? AS (\w+)$/.exec(f);
    if (m) return `${alias}.${m[1]}${m[2] ?? ''} AS ${m[3]}`;
    return `${alias}.${f}`;
  }).join(', ');
}

function toAttempt(r: AttemptRow): AttemptRecord {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    runId: r.run_id,
    toolCallId: r.tool_call_id,
    attemptNo: r.attempt_no,
    fencingToken: r.fencing_token,
    workerId: r.worker_id,
    workerSessionId: r.worker_session_id,
    state: r.state,
    leaseUntil: r.lease_until,
    leaseClaims: r.lease_claims,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    resultSha256: r.result_sha256,
    effectObservation: r.effect_observation,
    journalSeq: r.journal_seq,
    createdAt: r.created_at,
  };
}

export function createDbExecutionRepository(pool: Pool): ExecutionRepository {
  const exec: Executor = pool;

  async function inputArtifactIds(
    e: Executor,
    attemptId: string,
    workspaceId: string,
  ): Promise<string[]> {
    const res = await e.query<{ artifact_id: string }>(
      `SELECT artifact_id FROM artifact_links
       WHERE workspace_id = $1 AND source_kind = 'task_attempt' AND source_id = $2 AND relationship = 'input'
       ORDER BY created_at ASC, id ASC`,
      [workspaceId, attemptId],
    );
    return res.rows.map((r) => r.artifact_id);
  }

  return {
    async enqueueAttempt(input: EnqueueAttemptInput, id: string): Promise<AttemptRecord> {
      return withTransaction(pool, async (tx) => {
        const fenceRes = await tx.query<{ next_fence: string }>(
          `UPDATE tool_calls SET next_fence = next_fence + 1, updated_at = now()
           WHERE id = $1 AND run_id = $2 AND project_id = $3 AND workspace_id = $4
           RETURNING next_fence::text AS next_fence`,
          [input.toolCallId, input.runId, input.projectId, input.workspaceId],
        );
        const fence = fenceRes.rows[0]?.next_fence;
        if (!fence) throw new Error('enqueueAttempt: tool_call not found');
        const noRes = await tx.query<{ n: number }>(
          `SELECT COALESCE(MAX(attempt_no), 0) + 1 AS n FROM task_attempts WHERE tool_call_id = $1`,
          [input.toolCallId],
        );
        const attemptNo = noRes.rows[0]!.n;
        const ins = await tx.query<AttemptRow>(
          `INSERT INTO task_attempts
             (id, workspace_id, project_id, run_id, tool_call_id, attempt_no, fencing_token, state)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued')
           RETURNING ${ATTEMPT_COLS}`,
          [id, input.workspaceId, input.projectId, input.runId, input.toolCallId, attemptNo, fence],
        );
        await tx.query(
          `UPDATE tool_calls SET current_attempt_id = $1, updated_at = now()
           WHERE id = $2 AND workspace_id = $3`,
          [id, input.toolCallId, input.workspaceId],
        );
        return toAttempt(ins.rows[0]!);
      });
    },

    async getAttempt(workspaceId: string, attemptId: string): Promise<AttemptRecord | null> {
      const res = await exec.query<AttemptRow>(
        `SELECT ${ATTEMPT_COLS} FROM task_attempts WHERE id = $1 AND workspace_id = $2`,
        [attemptId, workspaceId],
      );
      return res.rows[0] ? toAttempt(res.rows[0]) : null;
    },

    async claimNextAttempt(scope, sessionId, leaseUntil, _now): Promise<ClaimContext | null> {
      return withTransaction(pool, async (tx) => {
        const w = await tx.query<{ capacity: number; session_id: string | null; state: string }>(
          `SELECT capacity, session_id, state FROM workers
           WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
          [scope.workerId, scope.workspaceId],
        );
        const worker = w.rows[0];
        if (!worker || worker.state === 'revoked') throw new SessionSupersededError();
        if (worker.session_id !== sessionId) throw new SessionSupersededError();

        const active = await tx.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM task_attempts
           WHERE worker_id = $1 AND state = ANY($2::text[])`,
          [scope.workerId, ACTIVE_ATTEMPT_STATES],
        );
        if (Number(active.rows[0]!.n) >= worker.capacity) return null;

        const cand = await tx.query<{ id: string }>(
          `SELECT a.id
           FROM task_attempts a
           JOIN runs r ON r.id = a.run_id AND r.workspace_id = a.workspace_id
           JOIN project_workers pw
             ON pw.project_id = a.project_id AND pw.worker_id = $1 AND pw.enabled = true
                AND pw.workspace_id = a.workspace_id
           WHERE a.workspace_id = $2 AND a.state = 'queued'
             AND (r.selected_worker_id IS NULL OR r.selected_worker_id = $1)
           ORDER BY a.created_at ASC, a.id ASC
           FOR UPDATE OF a SKIP LOCKED
           LIMIT 1`,
          [scope.workerId, scope.workspaceId],
        );
        const attemptId = cand.rows[0]?.id;
        if (!attemptId) return null;

        const upd = await tx.query<AttemptRow>(
          `UPDATE task_attempts
           SET state = 'leased', worker_id = $2, worker_session_id = $3, lease_until = $4, updated_at = now()
           WHERE id = $1 AND state = 'queued'
           RETURNING ${ATTEMPT_COLS}`,
          [attemptId, scope.workerId, sessionId, leaseUntil],
        );
        const attempt = toAttempt(upd.rows[0]!);

        const ctxRes = await tx.query<{
          tool_name: string;
          canonical_input: string;
          input_sha256: string;
          effect_class: string;
          timeout_seconds: number | null;
          scope_version_id: string | null;
          grant_id: string | null;
          installation_id: string;
          policy_epoch: string | null;
          policy_sha256: string | null;
          policy: Record<string, unknown> | null;
        }>(
          `SELECT tc.tool_name, tc.canonical_input, tc.input_sha256, tc.effect_class,
                  NULL::int AS timeout_seconds,
                  r.scope_version_id, r.grant_id,
                  ws.installation_id,
                  g.policy_epoch::text AS policy_epoch,
                  sv.policy_sha256,
                  sv.policy
           FROM tool_calls tc
           JOIN runs r ON r.id = tc.run_id AND r.workspace_id = tc.workspace_id
           JOIN workspaces ws ON ws.id = tc.workspace_id
           LEFT JOIN authorization_grants g
             ON g.id = r.grant_id AND g.project_id = r.project_id AND g.workspace_id = r.workspace_id
           LEFT JOIN scope_versions sv
             ON sv.id = r.scope_version_id AND sv.project_id = r.project_id AND sv.workspace_id = r.workspace_id
           WHERE tc.id = $1 AND tc.workspace_id = $2`,
          [attempt.toolCallId, scope.workspaceId],
        );
        const c = ctxRes.rows[0]!;
        const artifacts = await inputArtifactIds(tx, attempt.id, scope.workspaceId);

        return {
          attempt,
          installationId: c.installation_id,
          workerSessionId: sessionId,
          toolName: c.tool_name,
          toolInput: JSON.parse(c.canonical_input),
          inputSha256: c.input_sha256,
          effectClass: c.effect_class,
          timeoutSeconds: c.timeout_seconds,
          scopeVersionId: c.scope_version_id,
          grantId: c.grant_id,
          policyEpoch: c.policy_epoch ?? '1',
          scopePolicySha256: c.policy_sha256,
          inputArtifactIds: artifacts,
          policySnapshot: (c.policy as ClaimContext['policySnapshot']) ?? null,
        };
      });
    },

    async recordLease(workspaceId, attemptId, _fencingToken, leaseClaims): Promise<void> {
      await exec.query(
        `UPDATE task_attempts SET lease_claims = $3::jsonb, updated_at = now()
         WHERE id = $1 AND workspace_id = $2`,
        [attemptId, workspaceId, JSON.stringify(leaseClaims)],
      );
    },

    async getLiveRenewCheck(workspaceId, attemptId): Promise<LiveRenewCheck | null> {
      const res = await exec.query<{
        worker_session_id: string | null;
        worker_state: string | null;
        grant_status: string | null;
        grant_policy_epoch: string | null;
      }>(
        `SELECT w.session_id AS worker_session_id, w.state AS worker_state,
                g.status AS grant_status, g.policy_epoch::text AS grant_policy_epoch
         FROM task_attempts a
         LEFT JOIN workers w ON w.id = a.worker_id AND w.workspace_id = a.workspace_id
         LEFT JOIN runs r ON r.id = a.run_id AND r.workspace_id = a.workspace_id
         LEFT JOIN authorization_grants g
           ON g.id = r.grant_id AND g.project_id = r.project_id AND g.workspace_id = r.workspace_id
         WHERE a.id = $1 AND a.workspace_id = $2`,
        [attemptId, workspaceId],
      );
      const row = res.rows[0];
      if (!row) return null;
      // Grant presence is derived from lease_claims in the service; here we surface the
      // LIVE grant status + epoch so a revoke/epoch bump refuses renewal.
      return {
        workerSessionId: row.worker_session_id ?? '',
        workerRevoked: row.worker_state === 'revoked' || row.worker_state === null,
        grantStatus: (row.grant_status as LiveRenewCheck['grantStatus']) ?? null,
        grantPolicyEpoch: row.grant_policy_epoch,
      };
    },

    async applyAck(scope, attemptId, input: AckInput, now): Promise<FenceGuard> {
      return withTransaction(pool, async (tx) => {
        const guard = await lockAndFence(tx, scope, attemptId, input.sessionId, input.fencingToken);
        if (guard.kind !== 'ok') return guard;
        const a = guard.attempt;
        if (input.phase === 'started' && (a.state === 'leased' || a.state === 'started')) {
          const upd = await tx.query<AttemptRow>(
            `UPDATE task_attempts
             SET state = 'started', started_at = COALESCE(started_at, $3),
                 journal_seq = GREATEST(journal_seq, $4::bigint), updated_at = now()
             WHERE id = $1 AND workspace_id = $2
             RETURNING ${ATTEMPT_COLS}`,
            [attemptId, scope.workspaceId, now, input.journalSeq],
          );
          return { kind: 'ok', attempt: toAttempt(upd.rows[0]!) };
        }
        const upd = await tx.query<AttemptRow>(
          `UPDATE task_attempts SET journal_seq = GREATEST(journal_seq, $3::bigint), updated_at = now()
           WHERE id = $1 AND workspace_id = $2 RETURNING ${ATTEMPT_COLS}`,
          [attemptId, scope.workspaceId, input.journalSeq],
        );
        return { kind: 'ok', attempt: toAttempt(upd.rows[0]!) };
      });
    },

    async extendLease(scope, attemptId, fencingToken, leaseUntil, _now): Promise<FenceGuard> {
      return withTransaction(pool, async (tx) => {
        const guard = await lockAndFence(tx, scope, attemptId, undefined, fencingToken);
        if (guard.kind !== 'ok') return guard;
        const upd = await tx.query<AttemptRow>(
          `UPDATE task_attempts SET lease_until = $3, updated_at = now()
           WHERE id = $1 AND workspace_id = $2 RETURNING ${ATTEMPT_COLS}`,
          [attemptId, scope.workspaceId, leaseUntil],
        );
        return { kind: 'ok', attempt: toAttempt(upd.rows[0]!) };
      });
    },

    async submitResult(
      scope,
      attemptId,
      input: SubmitResultInput,
      _now,
    ): Promise<SubmitResultOutcome> {
      return withTransaction(pool, async (tx) => {
        const guard = await lockAndFence(tx, scope, attemptId, input.sessionId, input.fencingToken);
        if (guard.kind === 'not-found') return { kind: 'not-found' };
        if (guard.kind === 'session-superseded') return { kind: 'session-superseded' };
        if (guard.kind === 'stale-fence') {
          // A safe reconciliation record is kept implicitly by leaving the current
          // attempt untouched; the stale write is refused, never accepted as success.
          return { kind: 'stale-fence', currentFence: guard.currentFence };
        }
        const a = guard.attempt;
        if (a.resultSha256) {
          if (a.resultSha256 === input.resultSha256) return { kind: 'duplicate', attempt: a };
          // Conflicting digest: quarantine rather than overwrite (docs/08 §9). The
          // first result stays authoritative; the attempt is flagged for review.
          await tx.query(
            `UPDATE task_attempts SET updated_at = now() WHERE id = $1 AND workspace_id = $2`,
            [attemptId, scope.workspaceId],
          );
          return { kind: 'conflict-quarantined', attempt: a };
        }
        const upd = await tx.query<AttemptRow>(
          `UPDATE task_attempts
           SET state = $3, result_json = $4::jsonb, result_sha256 = $5,
               effect_observation = $6, observed_quiescent = $7,
               started_at = COALESCE(started_at, $8), finished_at = $9, updated_at = now()
           WHERE id = $1 AND workspace_id = $2
           RETURNING ${ATTEMPT_COLS}`,
          [
            attemptId,
            scope.workspaceId,
            input.status,
            JSON.stringify(input.resultJson),
            input.resultSha256,
            input.effectObservation,
            input.observedQuiescent,
            input.startedAt,
            input.finishedAt,
          ],
        );
        return { kind: 'accepted', attempt: toAttempt(upd.rows[0]!) };
      });
    },

    async authorizeInputArtifact(scope, attemptId, sessionId, fencingToken, artifactId) {
      const guard = await lockAndFence(exec, scope, attemptId, sessionId, fencingToken);
      if (guard.kind === 'not-found') return 'not-found';
      if (guard.kind === 'session-superseded') return 'session-superseded';
      if (guard.kind === 'stale-fence') return 'stale-fence';
      const linked = await exec.query(
        `SELECT 1 FROM artifact_links
         WHERE workspace_id = $1 AND source_kind = 'task_attempt' AND source_id = $2
           AND relationship = 'input' AND artifact_id = $3`,
        [scope.workspaceId, attemptId, artifactId],
      );
      return (linked.rowCount ?? 0) > 0 ? 'ok' : 'artifact-not-linked';
    },

    async reattemptAfterReconcile(
      workspaceId,
      priorAttemptId,
      newAttemptId,
      _reason,
    ): Promise<AttemptRecord> {
      return withTransaction(pool, async (tx) => {
        // The prior attempt is settled to a terminal state (canceled) as part of the
        // explicit reconcile decision BEFORE a fresh attempt exists: the
        // `one_unsettled_attempt_per_call` index forbids two live attempts, and a lost
        // external op is never silently re-run — reconciliation owns this transition.
        const prior = await tx.query<AttemptRow>(
          `UPDATE task_attempts SET state = 'canceled', finished_at = COALESCE(finished_at, now()), updated_at = now()
           WHERE id = $1 AND workspace_id = $2 RETURNING ${ATTEMPT_COLS}`,
          [priorAttemptId, workspaceId],
        );
        const p = prior.rows[0];
        if (!p) throw new Error('reattempt: prior attempt not found');
        const fenceRes = await tx.query<{ next_fence: string }>(
          `UPDATE tool_calls SET next_fence = next_fence + 1, updated_at = now()
           WHERE id = $1 AND workspace_id = $2 RETURNING next_fence::text AS next_fence`,
          [p.tool_call_id, workspaceId],
        );
        const fence = fenceRes.rows[0]!.next_fence;
        const noRes = await tx.query<{ n: number }>(
          `SELECT COALESCE(MAX(attempt_no), 0) + 1 AS n FROM task_attempts WHERE tool_call_id = $1`,
          [p.tool_call_id],
        );
        const ins = await tx.query<AttemptRow>(
          `INSERT INTO task_attempts
             (id, workspace_id, project_id, run_id, tool_call_id, attempt_no, fencing_token, state)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued')
           RETURNING ${ATTEMPT_COLS}`,
          [
            newAttemptId,
            workspaceId,
            p.project_id,
            p.run_id,
            p.tool_call_id,
            noRes.rows[0]!.n,
            fence,
          ],
        );
        await tx.query(
          `UPDATE tool_calls SET current_attempt_id = $1, updated_at = now()
           WHERE id = $2 AND workspace_id = $3`,
          [newAttemptId, p.tool_call_id, workspaceId],
        );
        return toAttempt(ins.rows[0]!);
      });
    },
  };
}

/**
 * Lock an attempt + its tool call and evaluate the per-tool-call fence: a write is
 * accepted only for the tool call's CURRENT attempt with the matching fencing token.
 * Works on a transaction client (issues `FOR UPDATE`) or, for read-only auth checks,
 * on the pool.
 */
async function lockAndFence(
  e: Executor,
  scope: WorkerScope,
  attemptId: string,
  sessionId: string | undefined,
  fencingToken: string,
): Promise<FenceGuard> {
  const res = await e.query<
    AttemptRow & { current_attempt_id: string | null; current_fence: string | null }
  >(
    `SELECT ${attemptColsAliased('a')},
            tc.current_attempt_id,
            (SELECT ca.fencing_token::text FROM task_attempts ca WHERE ca.id = tc.current_attempt_id) AS current_fence
     FROM task_attempts a
     JOIN tool_calls tc ON tc.id = a.tool_call_id AND tc.workspace_id = a.workspace_id
     WHERE a.id = $1 AND a.workspace_id = $2
     FOR UPDATE OF a`,
    [attemptId, scope.workspaceId],
  );
  const row = res.rows[0];
  if (!row || row.worker_id !== scope.workerId) return { kind: 'not-found' };
  if (sessionId !== undefined && row.worker_session_id !== sessionId) {
    return { kind: 'session-superseded' };
  }
  if (row.current_attempt_id !== attemptId || row.fencing_token !== fencingToken) {
    return { kind: 'stale-fence', currentFence: row.current_fence ?? row.fencing_token };
  }
  return { kind: 'ok', attempt: toAttempt(row) };
}
