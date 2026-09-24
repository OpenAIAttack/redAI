/**
 * @redai/runtime — durable Agent state machine + maintenance loops.
 * T01 provides only a startup entrypoint; the durable step loop, checkpoints
 * and reconciliation land in T13. The loop MUST claim runs via compare-and-set
 * lease and never hold a DB transaction across a model call (architecture §6).
 */

export const RUNTIME_PACKAGE = '@redai/runtime';

async function main(): Promise<void> {
  console.log('redAI runtime skeleton started; durable Agent loop lands in T13.');
}

void main();
