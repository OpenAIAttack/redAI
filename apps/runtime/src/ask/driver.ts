/**
 * Durable Ask runtime driver (T09).
 *
 * A single "tick" claims the oldest claimable Ask run via a compare-and-set lease
 * (`runtime_owner`/`runtime_fence`/`runtime_lease_until`), runs the durable step, and
 * releases the lease. Recovery is automatic: `claimQueuedAskRun` also picks up a
 * `running` run whose lease expired mid-flight, and the step is fence-guarded and
 * writes to a single assistant-message row, so a resumed run NEVER duplicates the
 * final message (docs/07 §10 acceptance).
 *
 * This driver depends only on `@redai/application/messages` — it holds no DB
 * transaction across the model call (the step does the round-trip between the
 * fence-guarded begin and finalize), and it opens no sockets itself. `tickOnce` is
 * deterministic (clock injected) so tests can drive one tick at a time.
 */
import type { ClaimedRun, MessagesRepository, StepResult } from '@redai/application/messages';

/** Injected clock so a test can freeze/advance time deterministically. */
export interface Clock {
  now(): Date;
}

export interface AskRuntimeDriverDeps {
  repo: MessagesRepository;
  /** The durable step, typically `askService.runStep.bind(askService)`. */
  runStep: (claimed: ClaimedRun) => Promise<StepResult>;
  /** Stable identity for this runtime process, written as `runtime_owner`. */
  owner: string;
  clock?: Clock;
  /** Lease TTL in seconds (SPEC_LOCK `runtime_lease_seconds`, default 60). */
  leaseSeconds?: number;
}

export interface TickResult {
  /** True when a run was claimed and a step attempted this tick. */
  claimed: boolean;
  runId?: string;
  step?: StepResult;
}

export const DEFAULT_LEASE_SECONDS = 60;

export class AskRuntimeDriver {
  private readonly repo: MessagesRepository;
  private readonly runStep: (claimed: ClaimedRun) => Promise<StepResult>;
  private readonly owner: string;
  private readonly clock: Clock;
  private readonly leaseSeconds: number;

  public constructor(deps: AskRuntimeDriverDeps) {
    this.repo = deps.repo;
    this.runStep = deps.runStep;
    this.owner = deps.owner;
    this.clock = deps.clock ?? { now: () => new Date() };
    this.leaseSeconds = deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  }

  /**
   * Claim one claimable Ask run, run its step, and release the lease. Returns
   * `{ claimed: false }` when there is nothing to do. The lease is only released when
   * the step reports `stale` (another runtime took over) or the run is not yet
   * terminal; a completed/failed run has already cleared its own lease inside the
   * fence-guarded commit, so the release is a harmless no-op.
   */
  async tickOnce(): Promise<TickResult> {
    const now = this.clock.now();
    const leaseUntil = new Date(now.getTime() + this.leaseSeconds * 1000);
    const claimed = await this.repo.claimQueuedAskRun(this.owner, now, leaseUntil);
    if (!claimed) return { claimed: false };

    let step: StepResult;
    try {
      step = await this.runStep(claimed);
    } finally {
      // Release the lease if the run is still holding it (e.g. the step went stale or
      // threw). Fence-guarded, so we never disturb a run another runtime now owns.
      await this.repo.releaseLease(claimed.run.id, claimed.run.workspaceId, claimed.fence);
    }
    return { claimed: true, runId: claimed.run.id, step };
  }

  /**
   * Drain: keep ticking until there is nothing claimable, bounded by `maxTicks` so a
   * misbehaving fixture cannot spin forever. Returns the ticks that did work.
   */
  async drain(maxTicks = 100): Promise<TickResult[]> {
    const results: TickResult[] = [];
    for (let i = 0; i < maxTicks; i += 1) {
      const result = await this.tickOnce();
      if (!result.claimed) break;
      results.push(result);
    }
    return results;
  }
}
