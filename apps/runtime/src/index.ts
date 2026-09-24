/**
 * @redai/runtime — durable Agent state machine + maintenance loops.
 * T09 lands the durable Ask loop (see `./ask`): claim a queued Ask run via
 * compare-and-set lease, run the fence-guarded step, release. The full Agent step
 * loop, checkpoints and reconciliation land in T13. The loop MUST claim runs via
 * compare-and-set lease and never hold a DB transaction across a model call
 * (architecture §6).
 */

export const RUNTIME_PACKAGE = '@redai/runtime';

export { AskRuntimeDriver, DEFAULT_LEASE_SECONDS } from './ask/index.js';
export type { AskRuntimeDriverDeps, TickResult } from './ask/index.js';

async function main(): Promise<void> {
  console.log('redAI runtime skeleton started; durable Ask loop is T09, Agent loop lands in T13.');
}

// Only run the entrypoint when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
