/**
 * Durable Agent runtime driver (T13).
 *
 * A single "tick" claims the oldest claimable agent run via a compare-and-set lease
 * (`runtime_owner`/`runtime_fence`/`runtime_lease_until`), advances it by ONE checkpoint
 * phase, and releases the lease. `runToCompletion` keeps ticking a claimed run across
 * its phases until it reaches a terminal state (or goes stale). Recovery is automatic:
 * `claimQueuedAgentRun` also picks up a `running` run whose lease expired mid-flight,
 * and every step write is fence-guarded, so a resumed run NEVER dispatches a duplicate
 * logical tool call and NEVER commits a duplicate final message (docs/07 §10).
 *
 * The loop lives ONLY here (apps/runtime) — never in a web request (AGENTS: "Web không
 * chạy agent loop"). It holds no DB transaction across the model call and opens no
 * sockets itself; the tool dispatch goes through the injected transport SEAM, which in
 * T13 is a mock (tests) or the not-implemented seam (production parks at the gate).
 */
import type { AgentClaimedRun, AgentStepResult } from '@redai/application/agent';
import type { AgentService } from '@redai/application/agent';

export interface Clock {
  now(): Date;
}

/** A claim + one-step-advance port (satisfied by the DB or in-memory repository). */
export interface AgentClaimPort {
  claimQueuedAgentRun(owner: string, now: Date, leaseUntil: Date): Promise<AgentClaimedRun | null>;
  releaseLease(runId: string, workspaceId: string, expectedFence: string): Promise<void>;
}

export interface AgentRuntimeDriverDeps {
  repo: AgentClaimPort;
  service: Pick<AgentService, 'runStep'>;
  /** Stable identity for this runtime process, written as `runtime_owner`. */
  owner: string;
  clock?: Clock;
  /** Lease TTL in seconds (SPEC_LOCK `runtime_lease_seconds`, default 60). */
  leaseSeconds?: number;
  /** Bound on phase advances within a single claimed run (runaway guard). */
  maxPhasesPerRun?: number;
}

export interface AgentTickResult {
  claimed: boolean;
  runId?: string;
  /** The step results produced across the phases advanced this tick. */
  steps?: AgentStepResult[];
  /** The last (most advanced) step outcome. */
  outcome?: AgentStepResult['outcome'];
}

export const DEFAULT_LEASE_SECONDS = 60;
export const DEFAULT_MAX_PHASES_PER_RUN = 200;

export class AgentRuntimeDriver {
  private readonly repo: AgentClaimPort;
  private readonly service: Pick<AgentService, 'runStep'>;
  private readonly owner: string;
  private readonly clock: Clock;
  private readonly leaseSeconds: number;
  private readonly maxPhasesPerRun: number;

  public constructor(deps: AgentRuntimeDriverDeps) {
    this.repo = deps.repo;
    this.service = deps.service;
    this.owner = deps.owner;
    this.clock = deps.clock ?? { now: () => new Date() };
    this.leaseSeconds = deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
    this.maxPhasesPerRun = deps.maxPhasesPerRun ?? DEFAULT_MAX_PHASES_PER_RUN;
  }

  /**
   * Advance a claimed agent run by exactly ONE checkpoint phase, then release the lease.
   * Returns `{ claimed: false }` when nothing is claimable. The single-phase form is what
   * the boundary-restart tests drive to simulate a crash between any two phases.
   */
  async tickOnce(): Promise<AgentTickResult> {
    const now = this.clock.now();
    const leaseUntil = new Date(now.getTime() + this.leaseSeconds * 1000);
    const claimed = await this.repo.claimQueuedAgentRun(this.owner, now, leaseUntil);
    if (!claimed) return { claimed: false };

    let step: AgentStepResult;
    try {
      step = await this.service.runStep(claimed);
    } finally {
      await this.repo.releaseLease(claimed.run.id, claimed.run.workspaceId, claimed.fence);
    }
    return { claimed: true, runId: claimed.run.id, steps: [step], outcome: step.outcome };
  }

  /**
   * Claim one run and drive it through its phases (re-claiming a fresh lease/fence each
   * phase) until it reaches a terminal outcome, goes stale, or hits `maxPhasesPerRun`.
   * Because each phase re-claims, a stale runtime that also holds an old fence is fenced
   * out of every subsequent commit — exactly one advances (docs/07 §10).
   */
  async runToCompletion(): Promise<AgentTickResult> {
    const first = await this.tickOnce();
    if (!first.claimed) return first;
    const steps = [...(first.steps ?? [])];
    let last = first.outcome;
    for (let i = 1; i < this.maxPhasesPerRun; i += 1) {
      if (last !== 'stepped') break;
      const next = await this.tickOnce();
      if (!next.claimed) break;
      if (next.steps) steps.push(...next.steps);
      last = next.outcome;
    }
    return {
      claimed: true,
      ...(first.runId !== undefined ? { runId: first.runId } : {}),
      steps,
      ...(last !== undefined ? { outcome: last } : {}),
    };
  }

  /** Drain: keep running claimable agent runs to completion, bounded by `maxRuns`. */
  async drain(maxRuns = 100): Promise<AgentTickResult[]> {
    const results: AgentTickResult[] = [];
    for (let i = 0; i < maxRuns; i += 1) {
      const result = await this.runToCompletion();
      if (!result.claimed) break;
      results.push(result);
    }
    return results;
  }
}
