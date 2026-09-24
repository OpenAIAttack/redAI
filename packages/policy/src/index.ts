/**
 * @redai/policy — the PURE, deterministic scope-authorization engine (T12).
 *
 * Authority lives OUTSIDE the model (docs/16 TH01): this package takes a scope
 * policy plus live grant status and returns a structured allow/ask/deny with a stable
 * machine reason code. It performs host/address/path canonicalization, deceptive-
 * suffix-safe origin matching, exclusion-before-include precedence, lab-zone CIDR
 * containment, SSRF-sensitive address blocking, and the four-mode approval matrix —
 * where `automatic` NEVER overrides an explicit deny and no approval widens scope.
 *
 * It imports only `@redai/domain` (kept pure); the import-boundary test forbids HTTP,
 * UI, DB and provider modules here. The Go proxy mirrors these decisions against the
 * same shared vectors (docs/10 §8).
 */

export const POLICY_PACKAGE = '@redai/policy';

export {
  normalizeHost,
  normalizeAddress,
  normalizePath,
  isHardDeniedAddress,
  isPublicSuffix,
  PUBLIC_SUFFIXES,
  type AddressClass,
  type NormalizedAddress,
  type NormalizedPath,
} from './normalize.js';

export {
  hostMatchesRule,
  schemeMatchesRule,
  portMatchesRule,
  pathMatchesRule,
  methodMatchesRule,
  ruleMatchesRequest,
  exclusionCoversHost,
  addressInCidr,
  addressInAnyLabRange,
  type OriginRule,
} from './match.js';

export {
  evaluateAuthorization,
  applyApprovalMode,
  type ScopePolicy,
  type AuthorizationInput,
  type PolicyDecision,
  type Verdict,
  type ReasonCode,
  type GrantStatus,
  type ApprovalMode,
  type RiskTier,
} from './decision.js';

export {
  decidePolicyCase,
  decidePolicyCaseDecision,
  toCaseDecision,
  type CaseDecision,
} from './cases.js';
