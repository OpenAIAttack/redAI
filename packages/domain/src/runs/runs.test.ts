/**
 * Unit tests for the pure run domain: state transitions, stable logical tool-call
 * IDs, loop detection and limit predicates. No I/O — these prove the invariants the
 * Agent runtime relies on (docs/07).
 */
import { describe, expect, it } from 'vitest';
import {
  canTransition,
  assertTransition,
  IllegalTransitionError,
  isTerminal,
  isActive,
  logicalToolCallId,
  toolAttemptId,
  computeFingerprint,
  noProgressRepeatCount,
  isLoopDetected,
  checkLimits,
  exceededMaxSteps,
  exceededActiveTimeout,
  exceededAbsoluteTimeout,
  parsePlanFromText,
  MAX_STEPS,
} from './index.js';

const RUN = '11111111-1111-4111-8111-111111111111';

describe('run state machine', () => {
  it('allows queued -> running and running -> completed/failed', () => {
    expect(canTransition('queued', 'running')).toBe(true);
    expect(canTransition('running', 'completed')).toBe(true);
    expect(canTransition('running', 'failed')).toBe(true);
    expect(canTransition('running', 'needs_attention')).toBe(true);
  });

  it('forbids moving out of a terminal state, including a self-move', () => {
    expect(canTransition('completed', 'running')).toBe(false);
    expect(canTransition('failed', 'running')).toBe(false);
    expect(canTransition('completed', 'completed')).toBe(false);
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('running')).toBe(false);
    expect(isActive('needs_attention')).toBe(true);
    expect(isActive('completed')).toBe(false);
  });

  it('forbids queued -> completed (must run first) and reports it', () => {
    expect(canTransition('queued', 'completed')).toBe(false);
    expect(() => assertTransition('queued', 'completed')).toThrow(IllegalTransitionError);
  });
});

describe('stable logical tool-call ids', () => {
  it('is deterministic in (runId, stepNo, providerToolIndex)', () => {
    const a = logicalToolCallId(RUN, 1, 0);
    const b = logicalToolCallId(RUN, 1, 0);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('differs across step, index and run', () => {
    const base = logicalToolCallId(RUN, 1, 0);
    expect(logicalToolCallId(RUN, 2, 0)).not.toBe(base);
    expect(logicalToolCallId(RUN, 1, 1)).not.toBe(base);
    expect(logicalToolCallId('22222222-2222-4222-8222-222222222222', 1, 0)).not.toBe(base);
  });

  it('attempt ids are stable per attempt and distinct from the logical id', () => {
    const id = logicalToolCallId(RUN, 1, 0);
    expect(toolAttemptId(id, 1)).toBe(toolAttemptId(id, 1));
    expect(toolAttemptId(id, 1)).not.toBe(toolAttemptId(id, 2));
    expect(toolAttemptId(id, 1)).not.toBe(id);
  });

  it('rejects out-of-range inputs', () => {
    expect(() => logicalToolCallId(RUN, 0, 0)).toThrow(RangeError);
    expect(() => logicalToolCallId(RUN, 1, -1)).toThrow(RangeError);
  });
});

describe('loop detection', () => {
  const fp = (name: string): string =>
    computeFingerprint({ toolName: name, normalizedArgs: '{}', target: null, inputVersions: [] });

  it('trips only after three no-progress repeats of the same fingerprint', () => {
    const f = fp('http.request');
    const history = [
      { fingerprint: f, progressed: false },
      { fingerprint: f, progressed: false },
    ];
    // Two prior + the candidate = 3.
    expect(noProgressRepeatCount(history, f)).toBe(3);
    expect(isLoopDetected(history, f)).toBe(true);
    // Only one prior + candidate = 2 → not yet.
    expect(isLoopDetected([{ fingerprint: f, progressed: false }], f)).toBe(false);
  });

  it('progress breaks the streak', () => {
    const f = fp('http.request');
    const history = [
      { fingerprint: f, progressed: false },
      { fingerprint: f, progressed: true },
      { fingerprint: f, progressed: false },
    ];
    // The trailing streak is a single no-progress record; candidate makes 2.
    expect(isLoopDetected(history, f)).toBe(false);
  });

  it('a different fingerprint does not accumulate', () => {
    const f1 = fp('a');
    const f2 = fp('b');
    const history = [
      { fingerprint: f1, progressed: false },
      { fingerprint: f1, progressed: false },
    ];
    expect(isLoopDetected(history, f2)).toBe(false);
  });
});

describe('limit predicates', () => {
  it('step cap fires at the configured max', () => {
    expect(exceededMaxSteps(MAX_STEPS)).toBe(true);
    expect(exceededMaxSteps(MAX_STEPS - 1)).toBe(false);
  });

  it('active + absolute timeouts fire at the boundary', () => {
    expect(exceededActiveTimeout(1800 * 1000)).toBe(true);
    expect(exceededActiveTimeout(1800 * 1000 - 1)).toBe(false);
    const created = new Date('2026-01-01T00:00:00Z');
    const later = new Date(created.getTime() + 86400 * 1000);
    expect(exceededAbsoluteTimeout(created, later)).toBe(true);
    expect(exceededAbsoluteTimeout(created, new Date(created.getTime() + 1000))).toBe(false);
  });

  it('checkLimits prioritizes absolute deadline, then active, then steps', () => {
    const created = new Date('2026-01-01T00:00:00Z');
    expect(
      checkLimits({
        stepCount: MAX_STEPS,
        activeElapsedMs: 1800 * 1000,
        createdAt: created,
        now: new Date(created.getTime() + 86400 * 1000),
      }),
    ).toBe('ABSOLUTE_TIMEOUT');
    expect(
      checkLimits({
        stepCount: MAX_STEPS,
        activeElapsedMs: 1800 * 1000,
        createdAt: created,
        now: new Date(created.getTime() + 1000),
      }),
    ).toBe('ACTIVE_TIMEOUT');
    expect(
      checkLimits({
        stepCount: MAX_STEPS,
        activeElapsedMs: 0,
        createdAt: created,
        now: new Date(created.getTime() + 1000),
      }),
    ).toBe('MAX_STEPS');
    expect(
      checkLimits({ stepCount: 1, activeElapsedMs: 0, createdAt: created, now: created }),
    ).toBeNull();
  });
});

describe('plan parsing (untrusted model output)', () => {
  it('absent plan block → empty plan (ok)', () => {
    const r = parsePlanFromText('no plan here');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan).toEqual([]);
  });

  it('valid plan block parses to items', () => {
    const text =
      'intro\n```redai:plan\n{"plan":[{"id":"1","title":"Recon","status":"pending"}]}\n```';
    const r = parsePlanFromText(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan).toHaveLength(1);
      expect(r.plan[0]!.title).toBe('Recon');
    }
  });

  it('present but malformed plan JSON is rejected (no coercion)', () => {
    const text = '```redai:plan\n{not json}\n```';
    const r = parsePlanFromText(text);
    expect(r.ok).toBe(false);
  });

  it('a plan item with a bad status is rejected', () => {
    const text = '```redai:plan\n{"plan":[{"id":"1","title":"x","status":"nope"}]}\n```';
    expect(parsePlanFromText(text).ok).toBe(false);
  });
});
