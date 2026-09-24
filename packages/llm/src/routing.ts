/**
 * Data-mode provider routing (docs/11 §3). The binding decision — may THIS provider
 * serve THIS data mode? — is made HERE, before any provider is called, so a
 * `local_only` request is filtered down to owner-approved local endpoints and can
 * never reach a cloud (OpenAI-compatible) adapter. There is no cloud fallback in
 * `local_only`: cloud candidates are removed from the eligible set entirely, so the
 * fallback loop cannot even attempt them (docs/11 §9 acceptance).
 */
import { LlmDataModeError, LlmNoProviderError, isLlmError } from './errors.js';
import type { DataMode, GenerateRequest, GenerateResult, ModelProvider } from './types.js';

/**
 * A provider plus the policy metadata routing needs. `allowedDataModes` is the
 * provider config's `allowed_data_modes`; `isLocalEndpoint` marks an owner-approved
 * local endpoint (loopback / egress-allowlisted) — the ONLY kind permitted under
 * `local_only`, regardless of adapter family (a local model may speak the OpenAI API).
 */
export interface ProviderCandidate {
  provider: ModelProvider;
  allowedDataModes: DataMode[];
  isLocalEndpoint: boolean;
}

/** True when `candidate` may serve `mode` under the data-mode rules. */
export function isCandidateEligible(candidate: ProviderCandidate, mode: DataMode): boolean {
  if (!candidate.allowedDataModes.includes(mode)) return false;
  // local_only: only owner-approved local endpoints; never a cloud egress.
  if (mode === 'local_only' && !candidate.isLocalEndpoint) return false;
  return true;
}

/**
 * Assert a specific candidate may serve `mode`. Used as a belt-and-braces gate right
 * before dispatch even when selection already ran — a `local_only` request must fail
 * closed (LLM_DATA_MODE) rather than silently egress.
 */
export function assertDataModeAllowed(candidate: ProviderCandidate, mode: DataMode): void {
  if (!isCandidateEligible(candidate, mode)) {
    throw new LlmDataModeError(
      mode === 'local_only'
        ? 'local_only requires an owner-approved local endpoint; refusing cloud egress'
        : `provider does not allow data mode ${mode}`,
    );
  }
}

/**
 * Select the first eligible provider for `mode` from `candidates` (primary first,
 * then fallbacks). Throws {@link LlmNoProviderError} when none is eligible — notably
 * when the only providers are cloud and the mode is `local_only`.
 */
export function selectProvider(candidates: ProviderCandidate[], mode: DataMode): ProviderCandidate {
  const eligible = candidates.filter((c) => isCandidateEligible(c, mode));
  if (eligible.length === 0) {
    throw new LlmNoProviderError(
      mode === 'local_only'
        ? 'no owner-approved local provider for local_only (no cloud fallback permitted)'
        : `no provider permits data mode ${mode}`,
    );
  }
  return eligible[0]!;
}

/**
 * Generate against the first eligible provider, falling back to the NEXT eligible
 * candidate only on a retryable error. Fallback stays inside the eligible set, so it
 * never crosses the data-mode boundary (a `local_only` run never tries a cloud
 * provider — those candidates are not eligible and are never called).
 */
export async function generateWithFallback(
  candidates: ProviderCandidate[],
  request: GenerateRequest,
): Promise<GenerateResult> {
  const mode: DataMode = request.dataMode ?? 'redacted_cloud';
  const eligible = candidates.filter((c) => isCandidateEligible(c, mode));
  if (eligible.length === 0) {
    throw new LlmNoProviderError(
      mode === 'local_only'
        ? 'no owner-approved local provider for local_only (no cloud fallback permitted)'
        : `no provider permits data mode ${mode}`,
    );
  }

  let lastError: unknown;
  for (const candidate of eligible) {
    // Defence in depth: re-check the boundary immediately before the call.
    assertDataModeAllowed(candidate, mode);
    try {
      return await candidate.provider.generate({ ...request, dataMode: mode });
    } catch (err) {
      lastError = err;
      const retryable = isLlmError(err) && err.retryable;
      if (!retryable) throw err;
    }
  }
  throw lastError;
}

/** The provider label of a candidate (for provenance in the runtime). */
export function candidateLabel(candidate: ProviderCandidate): string {
  return candidate.provider.info.label;
}
