/**
 * Canonical evaluator for the SHARED policy vectors (`tests/policy-cases.json`,
 * derived from `specs/tests/policy-cases.json`). The TS engine and the Go proxy must
 * agree on every vector (docs/10 §8); this function is the single TS entry point the
 * table test drives, so both sides evaluate the same context shapes the same way.
 *
 * Each vector's `context` is a heterogeneous bag keyed by which guard it exercises.
 * We dispatch on the distinctive fields, walking the docs/10 §4 decision order:
 * identity → discovery → grant → transport → canonicalization → exclusions →
 * includes → addresses → mode, plus the lease/approval-fingerprint execution gates.
 */
import { hostMatchesRule, type OriginRule } from './match.js';
import {
  type ApprovalMode,
  type AuthorizationInput,
  type GrantStatus,
  type PolicyDecision,
  type RiskTier,
  type ScopePolicy,
  type Verdict,
  evaluateAuthorization,
} from './decision.js';

/** The external vector decision vocabulary (`allow` | `deny` | `ask_user`). */
export type CaseDecision = 'allow' | 'deny' | 'ask_user';

/** Map an engine verdict to the vector vocabulary. */
export function toCaseDecision(v: Verdict): CaseDecision {
  return v === 'ask' ? 'ask_user' : v;
}

type Ctx = Record<string, unknown>;

function str(ctx: Ctx, key: string): string | undefined {
  const v = ctx[key];
  return typeof v === 'string' ? v : undefined;
}
function num(ctx: Ctx, key: string): number | undefined {
  const v = ctx[key];
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}
function bool(ctx: Ctx, key: string): boolean | undefined {
  const v = ctx[key];
  return typeof v === 'boolean' ? v : undefined;
}

/**
 * Evaluate one shared policy vector's `context` against `scope`, returning the full
 * structured decision. `decidePolicyCaseDecision` unwraps it to the vector verbatim.
 */
export function decidePolicyCase(context: Ctx, scope: ScopePolicy): PolicyDecision {
  // Identity / tenant closure (docs/10 §4 step 1; POL-032).
  const sessionTenant = str(context, 'session_tenant');
  const resourceTenant = str(context, 'resource_tenant');
  if (
    sessionTenant !== undefined &&
    resourceTenant !== undefined &&
    sessionTenant !== resourceTenant
  ) {
    return d('deny', 'IDENTITY_TENANT_MISMATCH', 'Session tenant does not own the resource.');
  }

  // Discovery is not authorization (POL-026).
  if (str(context, 'discovery') !== undefined || str(context, 'requested_target') !== undefined) {
    return d(
      'deny',
      'DISCOVERY_NOT_AUTHORIZATION',
      'Discovered asset does not grant authorization.',
    );
  }

  // Wildcard rule-shape vector (POL-027/028): { rule, target }.
  const ruleObj = context['rule'];
  const target = str(context, 'target');
  if (isOriginRuleLike(ruleObj) && target !== undefined) {
    return hostMatchesRule(ruleObj, target)
      ? d(
          'allow',
          'IN_SCOPE_ALLOWED',
          'Explicit descendant rule matches; further checks still apply.',
          [ruleObj.rule_id],
        )
      : d(
          'deny',
          'WILDCARD_APEX_EXCLUDED',
          'Wildcard rule does not cover this target (apex excluded / no match).',
          [ruleObj.rule_id],
        );
  }

  // Lease fencing gate (POL-029): a stale fence cannot start or commit.
  const currentFence = num(context, 'current_fence');
  const requestFence = num(context, 'request_fence');
  if (currentFence !== undefined && requestFence !== undefined) {
    return requestFence < currentFence
      ? d('deny', 'FENCE_STALE', 'Stale fencing token; a superseded worker cannot act.')
      : d('allow', 'IN_SCOPE_ALLOWED', 'Fencing token is current.');
  }

  // Approval fingerprint gate (POL-030): changed input invalidates the approval.
  const approvalSha = str(context, 'approval_input_sha256');
  const currentSha = str(context, 'current_input_sha256');
  if (approvalSha !== undefined && currentSha !== undefined) {
    return approvalSha !== currentSha
      ? d('deny', 'APPROVAL_INPUT_CHANGED', 'Input changed since approval; approval is stale.')
      : d('allow', 'IN_SCOPE_ALLOWED', 'Approval fingerprint still matches.');
  }

  // Browser blind-connect (POL-031): tunneling cannot enforce origin/path.
  if (str(context, 'transport') === 'blind_connect') {
    return d('deny', 'BROWSER_BLIND_CONNECT', 'Blind tunnel cannot enforce HTTP origin/path.');
  }

  // Otherwise this is a scoped network request (POL-001..025). Build the input.
  const input: AuthorizationInput = {
    grantStatus: (str(context, 'grant') as GrantStatus | undefined) ?? 'active',
    mode: (str(context, 'mode') as ApprovalMode | undefined) ?? 'automatic',
    host: str(context, 'host') ?? '',
    scheme: str(context, 'scheme') ?? 'https',
    port: num(context, 'port') ?? 443,
    path: str(context, 'path') ?? '/',
    method: str(context, 'method') ?? 'GET',
    zone: str(context, 'zone'),
    resolvedAddresses: Array.isArray(context['resolved_addresses'])
      ? (context['resolved_addresses'] as unknown[]).filter(
          (x): x is string => typeof x === 'string',
        )
      : [],
    riskTier: str(context, 'risk_tier') as RiskTier | undefined,
    workerBinding: str(context, 'worker_binding') as 'bound' | 'unbound' | undefined,
    hostHeader: str(context, 'host_header'),
    tlsValid: bool(context, 'tls_valid'),
    redirectTo: str(context, 'redirect_to'),
    exclusionMatch: bool(context, 'exclusion_match'),
    parserDisagreement: bool(context, 'parser_disagreement'),
    dependency: bool(context, 'dependency'),
  };
  return evaluateAuthorization(scope, input);
}

/** As {@link decidePolicyCase} but returns only the vector-vocabulary decision. */
export function decidePolicyCaseDecision(context: Ctx, scope: ScopePolicy): CaseDecision {
  return toCaseDecision(decidePolicyCase(context, scope).verdict);
}

function d(
  verdict: Verdict,
  reasonCode: PolicyDecision['reasonCode'],
  rationale: string,
  matchedRuleIds: string[] = [],
): PolicyDecision {
  return { verdict, reasonCode, matchedRuleIds, rationale };
}

function isOriginRuleLike(v: unknown): v is OriginRule {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Partial<OriginRule>;
  return typeof r.host === 'string' && (r.match === 'exact' || r.match === 'subdomains');
}
