/**
 * apps/runtime agent barrel — the durable Agent loop driver (T13). The loop runs ONLY
 * in this runtime process, never in a web request.
 */
export { AgentRuntimeDriver, DEFAULT_LEASE_SECONDS, DEFAULT_MAX_PHASES_PER_RUN } from './driver.js';
export type { AgentRuntimeDriverDeps, AgentTickResult, AgentClaimPort, Clock } from './driver.js';
