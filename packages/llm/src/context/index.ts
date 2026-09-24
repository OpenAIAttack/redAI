/**
 * @redai/llm context barrel — the context-manifest + redaction pipeline (docs/11
 * §4–§5). Ships with the gateway so the runtime builds the model request from
 * owner-approved sources under token caps, with secret references (never values) and
 * a canary a test can prove never leaks.
 */

export { buildContextManifest, estimateTokens } from './manifest.js';
export { Redactor, redactText, REDACTION_TRANSFORM_ID } from './redact.js';
export type { RedactorOptions } from './redact.js';
export { makeCanary, scanForSecret, assertNoSecretLeak, CANARY_PREFIX } from './canary.js';
export type { EgressSurfaces } from './canary.js';
export type {
  SourceClassification,
  ContextLayer,
  ContextSource,
  TokenCaps,
  SecretRefInput,
  RedactionOptions,
  InclusionReason,
  ManifestEntry,
  RedactionCounts,
  ContextManifest,
} from './types.js';
