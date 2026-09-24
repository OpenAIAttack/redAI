/**
 * The deterministic policy decision (docs/10 §4 decision order, §5 mode matrix).
 *
 * A decision is authorization FIRST (allow / deny), then approval mode applied only
 * to an already-authorized request. An `automatic` mode can never turn a deny into an
 * allow, and no approval can widen scope (docs/10 §1). Every deny carries a stable
 * machine `reason_code`; the engine returns structured results, never a bare boolean
 * (docs/10 §4). Pure: no DNS, no clock, no DB.
 */
import {
  addressInAnyLabRange,
  exclusionCoversHost,
  hostMatchesRule,
  methodMatchesRule,
  type OriginRule,
  pathMatchesRule,
  portMatchesRule,
  ruleMatchesRequest,
  schemeMatchesRule,
} from './match.js';
import { isHardDeniedAddress, normalizeAddress, normalizePath } from './normalize.js';

/** Scope policy, shaped exactly like `scope.schema.json` (the contracts `Scope`
 * type is structurally assignable to this). */
export interface ScopePolicy {
  schema_version: string;
  name: string;
  rules: OriginRule[];
  exclusions: OriginRule[];
  action_categories: string[];
  allowed_worker_ids: string[];
  allowed_zones: string[];
  dependency_authorization: 'explicit_only';
  deny_platform_resources: boolean;
}

export type GrantStatus = 'active' | 'revoked' | 'expired' | 'inactive' | 'pending';
export type ApprovalMode = 'automatic' | 'always_ask' | 'ask_high_risk' | 'reject';
export type RiskTier = 'routine' | 'high';
export type Verdict = 'allow' | 'ask' | 'deny';

export type ReasonCode =
  | 'IN_SCOPE_ALLOWED'
  | 'APPROVAL_REQUIRED'
  | 'MODE_REJECT'
  | 'IDENTITY_TENANT_MISMATCH'
  | 'GRANT_REVOKED'
  | 'GRANT_EXPIRED'
  | 'GRANT_INACTIVE'
  | 'TLS_INVALID'
  | 'HOST_AUTHORITY_MISMATCH'
  | 'WORKER_UNBOUND'
  | 'PATH_CANONICALIZATION_AMBIGUOUS'
  | 'REDIRECT_REQUIRES_AUTHORIZATION'
  | 'EXCLUSION_MATCH'
  | 'HOST_NOT_IN_SCOPE'
  | 'SCHEME_NOT_IN_SCOPE'
  | 'PORT_NOT_IN_SCOPE'
  | 'PATH_NOT_IN_SCOPE'
  | 'METHOD_NOT_IN_SCOPE'
  | 'ZONE_NOT_ALLOWED'
  | 'ADDRESS_BLOCKED'
  | 'ADDRESS_NOT_IN_LAB_SCOPE'
  | 'ADDRESS_NOT_PUBLIC'
  | 'DEPENDENCY_EXPLICIT_ONLY'
  | 'PLATFORM_RESOURCE_DENIED'
  | 'FENCE_STALE'
  | 'APPROVAL_INPUT_CHANGED'
  | 'BROWSER_BLIND_CONNECT'
  | 'DISCOVERY_NOT_AUTHORIZATION'
  | 'WILDCARD_APEX_EXCLUDED';

export interface PolicyDecision {
  verdict: Verdict;
  reasonCode: ReasonCode;
  matchedRuleIds: string[];
  /** Human-readable, target-content-free rationale (safe to log). */
  rationale: string;
}

export interface AuthorizationInput {
  grantStatus: GrantStatus;
  mode: ApprovalMode;
  host: string;
  scheme: string;
  port: number;
  path: string;
  method: string;
  /** The zone the request was dispatched into (must be an allowed zone). */
  zone?: string | undefined;
  resolvedAddresses: string[];
  riskTier?: RiskTier | undefined;
  /** 'ask_no_execution' is always permitted (docs/10 §5: Reject still allows Ask). */
  actionKind?: 'ask_no_execution' | 'execution' | undefined;
  /** Worker binding state; 'unbound' denies (no silent worker fallback). */
  workerBinding?: 'bound' | 'unbound' | undefined;
  hostHeader?: string | undefined;
  tlsValid?: boolean | undefined;
  redirectTo?: string | undefined;
  /** Pre-classified exclusion overlap from the caller (in addition to real rules). */
  exclusionMatch?: boolean | undefined;
  parserDisagreement?: boolean | undefined;
  /** This request loads a dependency / third-party resource (explicit_only). */
  dependency?: boolean | undefined;
}

function deny(
  reasonCode: ReasonCode,
  rationale: string,
  matchedRuleIds: string[] = [],
): PolicyDecision {
  return { verdict: 'deny', reasonCode, matchedRuleIds, rationale };
}

/**
 * Authorize a scoped network request against a scope policy and live grant status,
 * then apply the approval mode. Returns allow / ask / deny with a reason code.
 */
export function evaluateAuthorization(
  scope: ScopePolicy,
  input: AuthorizationInput,
): PolicyDecision {
  // An Ask with no execution is permitted in every mode (docs/10 §5 first row).
  if (input.actionKind === 'ask_no_execution') {
    return {
      verdict: 'allow',
      reasonCode: 'IN_SCOPE_ALLOWED',
      matchedRuleIds: [],
      rationale: 'Ask without execution is always permitted.',
    };
  }

  // 5. Grant status / epoch — live revocation and expiry override any run snapshot.
  if (input.grantStatus === 'revoked') return deny('GRANT_REVOKED', 'Grant is revoked.');
  if (input.grantStatus === 'expired') return deny('GRANT_EXPIRED', 'Grant has expired.');
  if (input.grantStatus !== 'active') return deny('GRANT_INACTIVE', 'No active grant.');

  // Transport integrity guards (fail closed).
  if (input.tlsValid === false) return deny('TLS_INVALID', 'TLS validation failed; no bypass.');
  if (input.hostHeader !== undefined && input.hostHeader.trim() !== '') {
    if (
      input.hostHeader.trim().toLowerCase().replace(/\.$/, '') !==
      input.host.trim().toLowerCase().replace(/\.$/, '')
    ) {
      return deny('HOST_AUTHORITY_MISMATCH', 'Host/authority header disagrees with target host.');
    }
  }
  if (input.workerBinding === 'unbound') {
    return deny('WORKER_UNBOUND', 'No bound worker; silent worker fallback is not allowed.');
  }

  // 6. Canonicalize target — ambiguous path canonicalization fails closed.
  const np = normalizePath(input.path);
  if (np.ambiguous || input.parserDisagreement === true) {
    return deny('PATH_CANONICALIZATION_AMBIGUOUS', 'Ambiguous path canonicalization.');
  }

  // Each redirect target requires independent authorization; a redirect off the
  // matched origin is denied here (the caller re-authorizes the new origin).
  if (input.redirectTo !== undefined && input.redirectTo.trim() !== '') {
    return deny('REDIRECT_REQUIRES_AUTHORIZATION', 'Redirect requires independent authorization.');
  }

  // 7. Exclusions BEFORE includes — explicit deny wins.
  if (input.exclusionMatch === true) {
    return deny('EXCLUSION_MATCH', 'Target matches an explicit exclusion.');
  }
  for (const ex of scope.exclusions) {
    if (exclusionCoversHost(ex, input.host)) {
      return deny('EXCLUSION_MATCH', 'Target matches an explicit exclusion.', [ex.rule_id]);
    }
  }

  // 8. Includes: find a rule that matches host+scheme+port+path+method, with a
  // precise reason when it does not.
  const req = {
    host: input.host,
    scheme: input.scheme,
    port: input.port,
    path: np.path,
    method: input.method,
  };
  const hostRules = scope.rules.filter((r) => hostMatchesRule(r, input.host));
  if (hostRules.length === 0) {
    if (input.dependency === true) {
      return deny(
        'DEPENDENCY_EXPLICIT_ONLY',
        'Dependency/third-party host is not an explicit allowed origin.',
      );
    }
    return deny('HOST_NOT_IN_SCOPE', 'Host is not covered by any allowed origin rule.');
  }
  const schemeRules = hostRules.filter((r) => schemeMatchesRule(r, input.scheme));
  if (schemeRules.length === 0)
    return deny('SCHEME_NOT_IN_SCOPE', 'Scheme is not granted for this host.', ids(hostRules));
  const portRules = schemeRules.filter((r) => portMatchesRule(r, input.port));
  if (portRules.length === 0)
    return deny('PORT_NOT_IN_SCOPE', 'Port is not granted for this host.', ids(schemeRules));
  const pathRules = portRules.filter((r) => pathMatchesRule(r, np.path));
  if (pathRules.length === 0)
    return deny('PATH_NOT_IN_SCOPE', 'Path prefix is not granted.', ids(portRules));
  const matched = pathRules.filter((r) => methodMatchesRule(r, input.method));
  if (matched.length === 0)
    return deny('METHOD_NOT_IN_SCOPE', 'Method/action is not granted.', ids(pathRules));

  // Defensive: full-request match must hold.
  const rule = matched.find((r) => ruleMatchesRequest(r, req));
  if (!rule) return deny('HOST_NOT_IN_SCOPE', 'No fully matching rule.', ids(matched));

  // Zone must be allowed and, if the request declares a zone, agree with the rule.
  if (!scope.allowed_zones.includes(rule.zone)) {
    return deny('ZONE_NOT_ALLOWED', 'Matched rule zone is not an allowed zone.', [rule.rule_id]);
  }
  if (input.zone !== undefined && input.zone !== rule.zone) {
    return deny('ZONE_NOT_ALLOWED', 'Request zone disagrees with the matched rule zone.', [
      rule.rule_id,
    ]);
  }

  // 8b. Every resolved address must pass: never hard-denied, and inside the declared
  // lab range (lab rule) or globally routable (public rule). Validate ALL addresses.
  const addrDecision = evaluateAddresses(input.resolvedAddresses, rule);
  if (addrDecision) return { ...addrDecision, matchedRuleIds: [rule.rule_id] };

  // Authorized. 11. Apply approval mode.
  return applyApprovalMode(input.mode, input.riskTier ?? 'routine', [rule.rule_id]);
}

function evaluateAddresses(addresses: string[], rule: OriginRule): PolicyDecision | null {
  const isLabRule = (rule.lab_ip_ranges ?? []).length > 0;
  if (addresses.length === 0) {
    // No resolved address is an unresolved dial → fail closed.
    return deny('ADDRESS_BLOCKED', 'No resolved address to validate.');
  }
  for (const raw of addresses) {
    const addr = normalizeAddress(raw);
    if (isHardDeniedAddress(addr)) {
      return deny(
        'ADDRESS_BLOCKED',
        'Resolved address is in a blocked range (loopback/link-local/metadata).',
      );
    }
    if (isLabRule) {
      if (!addressInAnyLabRange(addr, rule)) {
        return deny(
          'ADDRESS_NOT_IN_LAB_SCOPE',
          'Resolved address is not inside the declared lab range.',
        );
      }
    } else if (addr.klass !== 'public') {
      return deny(
        'ADDRESS_NOT_PUBLIC',
        'Resolved address is not globally routable for a public rule.',
      );
    }
  }
  return null;
}

/** docs/10 §5 mode matrix, applied ONLY to an already-authorized request. */
export function applyApprovalMode(
  mode: ApprovalMode,
  riskTier: RiskTier,
  matchedRuleIds: string[],
): PolicyDecision {
  switch (mode) {
    case 'reject':
      // Authorized by scope, but Reject mode refuses execution (docs/10 §5).
      return {
        verdict: 'deny',
        reasonCode: 'MODE_REJECT',
        matchedRuleIds,
        rationale: 'Reject mode: execution refused.',
      };
    case 'always_ask':
      return {
        verdict: 'ask',
        reasonCode: 'APPROVAL_REQUIRED',
        matchedRuleIds,
        rationale: 'Approval required before execution.',
      };
    case 'ask_high_risk':
      return riskTier === 'high'
        ? {
            verdict: 'ask',
            reasonCode: 'APPROVAL_REQUIRED',
            matchedRuleIds,
            rationale: 'High-risk action requires approval.',
          }
        : {
            verdict: 'allow',
            reasonCode: 'IN_SCOPE_ALLOWED',
            matchedRuleIds,
            rationale: 'Routine in-scope action.',
          };
    case 'automatic':
    default:
      return {
        verdict: 'allow',
        reasonCode: 'IN_SCOPE_ALLOWED',
        matchedRuleIds,
        rationale: 'In-scope action.',
      };
  }
}

function ids(rules: OriginRule[]): string[] {
  return rules.map((r) => r.rule_id);
}
