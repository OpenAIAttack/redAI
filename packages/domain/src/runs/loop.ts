/**
 * Pure loop / runaway detection (docs/07 §9).
 *
 * An action FINGERPRINT is `tool name + normalized args + target + input versions`.
 * Three occurrences of the SAME fingerprint WITHOUT PROGRESS trigger a single nudge
 * and then a `LOOP_DETECTED` stop. "No progress" means no NEW artifact/result/plan
 * state — not merely a repeated message — so the caller stamps each recorded
 * fingerprint with whether that step made progress, and this module counts the
 * trailing no-progress repeats. Pure and deterministic; the runtime owns persistence.
 */
import { createHash } from 'node:crypto';

export const LOOP_REPEAT_THRESHOLD = 3;

/** The inputs that make an action identity (docs/07 §9). */
export interface ActionFingerprintInput {
  toolName: string;
  /** Canonical JSON of the normalized tool arguments. */
  normalizedArgs: string;
  /** The effect target (host, path, artifact id, …) or null for a target-less tool. */
  target: string | null;
  /** Version markers of every input the action reads (artifact hashes, note revisions). */
  inputVersions: string[];
}

/** A recorded action + whether the step it belonged to made progress. */
export interface FingerprintRecord {
  fingerprint: string;
  progressed: boolean;
}

/** Stable fingerprint hex for an action identity. */
export function computeFingerprint(input: ActionFingerprintInput): string {
  const canonical = JSON.stringify([
    input.toolName,
    input.normalizedArgs,
    input.target,
    [...input.inputVersions].sort(),
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * How many times `fingerprint` has occurred at the END of `history` with NO progress
 * in between. A record that made progress resets the streak (progress broke the loop).
 * The count INCLUDES a candidate occurrence about to be appended when `includeCandidate`
 * is true, so the runtime can test "would this be the third?" before dispatching.
 */
export function noProgressRepeatCount(
  history: readonly FingerprintRecord[],
  fingerprint: string,
  includeCandidate = true,
): number {
  let count = includeCandidate ? 1 : 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const rec = history[i]!;
    if (rec.progressed) break;
    if (rec.fingerprint === fingerprint) count += 1;
    else break;
  }
  return count;
}

/**
 * True when repeating `fingerprint` now would reach the no-progress threshold — the
 * runtime must NOT dispatch it again, and stops with `LOOP_DETECTED` (docs/07 §9).
 */
export function isLoopDetected(
  history: readonly FingerprintRecord[],
  fingerprint: string,
  threshold: number = LOOP_REPEAT_THRESHOLD,
): boolean {
  return noProgressRepeatCount(history, fingerprint, true) >= threshold;
}
