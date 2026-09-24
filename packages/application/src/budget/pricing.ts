/**
 * Pricing-version-aware cost math (docs/11 §7). Unit: `micro_usd_per_million_tokens`.
 * All rounding is UP to an integer micro-USD (conservative — the ledger never
 * under-charges). Reservation before a request is a conservative upper bound; the
 * observed cost after the request is reconciled against it.
 */
import { InvalidPricingError } from './errors.js';
import type { PricingConfig, UsageBasis } from './ports.js';
import type { Usage } from '@redai/llm';

const MILLION = 1_000_000n;

/** ceil(tokens * ratePerMillion / 1_000_000) in bigint. */
function costFor(tokens: bigint, ratePerMillion: number): bigint {
  if (tokens <= 0n || ratePerMillion <= 0) return 0n;
  const rate = BigInt(Math.ceil(ratePerMillion));
  const numerator = tokens * rate;
  // ceil division
  return (numerator + MILLION - 1n) / MILLION;
}

function validate(pricing: PricingConfig): void {
  if (pricing.inputMicroUsdPerMillion < 0 || pricing.outputMicroUsdPerMillion < 0) {
    throw new InvalidPricingError('pricing rates must be non-negative');
  }
  if ((pricing.fixedFeeMicroUsd ?? 0) < 0) {
    throw new InvalidPricingError('fixed fee must be non-negative');
  }
}

/**
 * The conservative reservation for one request (docs/11 §7):
 *   inputUpperBound × inputRate + maxOutputTokens × outputRate + fixed fee.
 *
 * `inputUpperBoundTokens` is the caller's conservative input estimate. When there is
 * no compatible tokenizer the caller passes the CONFIGURED CONTEXT CAP (never a low
 * guess). A local zero-model-cost provider reserves 0 (compute cost is not measured).
 */
export function estimateReservation(
  pricing: PricingConfig,
  inputUpperBoundTokens: number,
  maxOutputTokens: number,
): bigint {
  validate(pricing);
  if (pricing.localZeroModelCost) return 0n;
  const input = costFor(
    BigInt(Math.max(0, Math.ceil(inputUpperBoundTokens))),
    pricing.inputMicroUsdPerMillion,
  );
  const output = costFor(
    BigInt(Math.max(0, Math.ceil(maxOutputTokens))),
    pricing.outputMicroUsdPerMillion,
  );
  const fee = BigInt(Math.ceil(pricing.fixedFeeMicroUsd ?? 0));
  return input + output + fee;
}

export interface ObservedCost {
  /** Cost in micro-USD, or null when usage is unknown (reservation stays HELD). */
  observedMicroUsd: bigint | null;
  inputTokens: bigint | null;
  outputTokens: bigint | null;
  basis: UsageBasis;
}

/**
 * Reconcile provider {@link Usage} into an observed cost + basis.
 *   - `unknown` usage → { observedMicroUsd: null, basis: 'unknown' } — HELD, never 0.
 *   - a local zero-model-cost provider → observed 0, basis 'local_zero_model_cost'.
 *   - known usage → measured provider cost, basis 'provider'.
 */
export function observedCost(pricing: PricingConfig, usage: Usage): ObservedCost {
  validate(pricing);
  if (usage.kind === 'unknown') {
    return { observedMicroUsd: null, inputTokens: null, outputTokens: null, basis: 'unknown' };
  }
  const inputTokens = BigInt(Math.max(0, Math.floor(usage.inputTokens)));
  const outputTokens = BigInt(Math.max(0, Math.floor(usage.outputTokens)));
  if (pricing.localZeroModelCost) {
    return { observedMicroUsd: 0n, inputTokens, outputTokens, basis: 'local_zero_model_cost' };
  }
  const cost =
    costFor(inputTokens, pricing.inputMicroUsdPerMillion) +
    costFor(outputTokens, pricing.outputMicroUsdPerMillion) +
    BigInt(Math.ceil(pricing.fixedFeeMicroUsd ?? 0));
  return { observedMicroUsd: cost, inputTokens, outputTokens, basis: 'provider' };
}
