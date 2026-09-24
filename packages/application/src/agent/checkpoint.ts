/**
 * Serialize the typed {@link AgentCheckpoint} to the snake_case JSON the `runs.checkpoint`
 * column stores (and that {@link AgentService} reads back). The active-time counter is
 * mirrored INTO the checkpoint so the pure loop can read it from the neutral RunRecord
 * without a dedicated column field. NEVER put a secret in the checkpoint (docs/07 §3) —
 * only ids, hashes, effect classes and bounded summaries are persisted here.
 */
import type { AgentCheckpoint } from './ports.js';

export function toCheckpointJson(
  cp: AgentCheckpoint,
  activeElapsedMs: number,
): Record<string, unknown> {
  return {
    phase: cp.phase,
    step_no: cp.stepNo,
    agent_session_id: cp.agentSessionId,
    objective: cp.objective,
    provider_request_id: cp.providerRequestId,
    context_manifest: cp.contextManifest,
    pending_tool_calls: cp.pendingToolCalls,
    tool_results: cp.toolResults,
    fingerprints: cp.fingerprints,
    last_result_sha_by_fingerprint: cp.lastResultShaByFingerprint,
    assistant_message_id: cp.assistantMessageId,
    stop_reason: cp.stopReason,
    active_elapsed_ms: activeElapsedMs,
  };
}
