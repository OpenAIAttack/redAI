/**
 * Tool transports (the dispatch SEAM) and authorizers for the Agent loop.
 *
 * T13 does NOT dispatch any real tool/network. Two seams are provided:
 *   - {@link notImplementedTransport}: the PRODUCTION T13 wiring. Its `dispatch` throws
 *     {@link ToolDispatchUnavailableError}, so a real agent run parks at the dispatch
 *     boundary (`needs_attention` / WAITING_DISPATCH) rather than performing an effect.
 *     T17 replaces this with the scheduler that creates a signed `task_attempts` lease.
 *   - {@link MockToolTransport}: a DETERMINISTIC in-memory transport for tests. It records
 *     every dispatch (so a test can assert a logical id was dispatched AT MOST ONCE) and
 *     replays scripted results by tool name.
 *
 * Authorizers decide allow/ask/deny BEFORE dispatch (the model never grants permission).
 * {@link allowAllAuthorizer} is for tests; {@link createPolicyAuthorizer} is the seam the
 * runtime wires to @redai/policy (T12) — kept thin so a denied network tool becomes a
 * blocked item with no dispatch.
 */
import { createHash } from 'node:crypto';
import { ToolDispatchUnavailableError } from './ports.js';
import type {
  ToolAuthorizer,
  ToolDispatchRequest,
  ToolResultRecord,
  ToolTransport,
} from './ports.js';

/** The production T13 seam: no real dispatch exists yet (T17). */
export function notImplementedTransport(): ToolTransport {
  return {
    async dispatch(req: ToolDispatchRequest): Promise<ToolResultRecord> {
      throw new ToolDispatchUnavailableError(req.toolName);
    },
  };
}

export interface MockToolScript {
  /** Match on tool name; the first matching script wins. */
  toolName: string;
  ok?: boolean;
  summary?: string;
  effectObservation?: ToolResultRecord['effectObservation'];
  /**
   * Force a fixed result sha (so a loop test can return the SAME sha every call). When
   * omitted the sha is derived from the arguments, so different args → different sha.
   */
  fixedResultSha?: string;
}

/** A deterministic, no-network transport that records dispatches for test assertions. */
export class MockToolTransport implements ToolTransport {
  private readonly scripts: MockToolScript[];
  private readonly dispatchedIds: string[] = [];

  public constructor(scripts: MockToolScript[] = []) {
    this.scripts = scripts;
  }

  /** Every logical tool-call id dispatched, in order (duplicates would be a bug). */
  public get dispatched(): readonly string[] {
    return this.dispatchedIds;
  }

  /** How many times a given logical id was dispatched (must be ≤ 1 across restarts). */
  public countFor(toolCallId: string): number {
    return this.dispatchedIds.filter((id) => id === toolCallId).length;
  }

  async dispatch(req: ToolDispatchRequest): Promise<ToolResultRecord> {
    this.dispatchedIds.push(req.toolCallId);
    const script = this.scripts.find((s) => s.toolName === req.toolName);
    const sha =
      script?.fixedResultSha ??
      createHash('sha256')
        .update(`${req.toolName}|${JSON.stringify(req.arguments)}`, 'utf8')
        .digest('hex');
    return {
      toolCallId: req.toolCallId,
      ok: script?.ok ?? true,
      resultSha256: sha,
      summary: script?.summary ?? `mock result for ${req.toolName}`,
      effectObservation: script?.effectObservation ?? 'completed',
    };
  }
}

/** Test authorizer: everything is allowed. */
export const allowAllAuthorizer: ToolAuthorizer = {
  async authorize() {
    return { verdict: 'allow', reasonCode: 'ALLOW' };
  },
};

/** Test authorizer: everything is denied (proves deny → no dispatch). */
export const denyAllAuthorizer: ToolAuthorizer = {
  async authorize() {
    return { verdict: 'deny', reasonCode: 'SCOPE_DENY' };
  },
};

/**
 * A verdict-map authorizer keyed by tool name (tests inject a specific policy). The
 * production authorizer that consults @redai/policy against the run's scope snapshot +
 * live grant is wired in the runtime (T13 leaves that composition to the runtime layer
 * so this module imports no scope-repository); an unmapped tool defaults to deny.
 */
export function mapAuthorizer(verdicts: Record<string, 'allow' | 'ask' | 'deny'>): ToolAuthorizer {
  return {
    async authorize(input) {
      const v = verdicts[input.toolName] ?? 'deny';
      return { verdict: v, reasonCode: v === 'allow' ? 'ALLOW' : `SCOPE_${v.toUpperCase()}` };
    },
  };
}
