/**
 * T12 policy-engine unit tests.
 *
 * Part 1 drives ALL of the SHARED vectors (`tests/policy-cases.json`, copied from
 * `specs/tests/policy-cases.json`) as a table test against the documented fixture
 * scope — the TS side of the "TS policy and Go proxy use the same vectors" rule
 * (docs/10 §8). Part 2 adds focused cases the vectors summarize but do not spell out:
 * deceptive suffixes, IPv6 / mapped-IPv4, exclusions, shared-IP, lab-zone CIDR,
 * dependency explicit_only, and "automatic never overrides deny".
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type OriginRule,
  type ScopePolicy,
  addressInCidr,
  decidePolicyCase,
  decidePolicyCaseDecision,
  evaluateAuthorization,
  hostMatchesRule,
  normalizeAddress,
} from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

const fixtureScope = JSON.parse(
  readFileSync(resolve(repoRoot, 'contracts/examples/scope-valid.json'), 'utf8'),
) as ScopePolicy;

interface Vector {
  id: string;
  category: string;
  context: Record<string, unknown>;
  expected_decision: 'allow' | 'deny' | 'ask_user';
  reason: string;
}
const vectors = JSON.parse(readFileSync(resolve(repoRoot, 'tests/policy-cases.json'), 'utf8')) as {
  cases: Vector[];
};

describe('shared policy vectors (tests/policy-cases.json)', () => {
  it('has the expected count of vectors', () => {
    expect(vectors.cases.length).toBe(32);
  });

  for (const v of vectors.cases) {
    it(`${v.id} → ${v.expected_decision} (${v.reason})`, () => {
      const got = decidePolicyCaseDecision(v.context, fixtureScope);
      expect(got, `${v.id}: ${v.reason}`).toBe(v.expected_decision);
    });
  }
});

// ---------------------------------------------------------------------------

function labScope(overrides: Partial<OriginRule> = {}): ScopePolicy {
  const rule: OriginRule = {
    rule_id: '10000000-0000-4000-8000-000000000020',
    host: 'app.example.test',
    match: 'exact',
    include_apex: true,
    schemes: ['https'],
    ports: [443],
    path_prefixes: ['/api/'],
    methods: ['GET', 'HEAD'],
    zone: 'lab',
    lab_ip_ranges: ['192.0.2.0/24'],
    ...overrides,
  };
  return {
    schema_version: '1.0',
    name: 'test',
    rules: [rule],
    exclusions: [],
    action_categories: ['offline', 'external_read'],
    allowed_worker_ids: [],
    allowed_zones: ['lab'],
    dependency_authorization: 'explicit_only',
    deny_platform_resources: true,
  };
}

const labReq = {
  grantStatus: 'active' as const,
  mode: 'automatic' as const,
  scheme: 'https',
  port: 443,
  path: '/api/health',
  method: 'GET',
  zone: 'lab',
};

describe('deceptive-suffix defense (host matching)', () => {
  const exact: OriginRule = {
    rule_id: 'r',
    host: 'example.com',
    match: 'exact',
    include_apex: true,
    schemes: ['https'],
    ports: [443],
    path_prefixes: ['/'],
    methods: ['GET'],
    zone: 'z',
  };
  const subs: OriginRule = { ...exact, match: 'subdomains', include_apex: false };

  it('evil-example.com does NOT match example.com (exact)', () => {
    expect(hostMatchesRule(exact, 'evil-example.com')).toBe(false);
  });
  it('evil-example.com does NOT match example.com (subdomains)', () => {
    expect(hostMatchesRule(subs, 'evil-example.com')).toBe(false);
  });
  it('example.com.attacker.com does NOT match example.com', () => {
    expect(hostMatchesRule(exact, 'example.com.attacker.com')).toBe(false);
    expect(hostMatchesRule(subs, 'example.com.attacker.com')).toBe(false);
  });
  it('a.example.com matches the subdomains rule; apex only with include_apex', () => {
    expect(hostMatchesRule(subs, 'a.example.com')).toBe(true);
    expect(hostMatchesRule(subs, 'example.com')).toBe(false);
    expect(hostMatchesRule({ ...subs, include_apex: true }, 'example.com')).toBe(true);
  });
  it('normalizes case and trailing dot before matching', () => {
    expect(hostMatchesRule(exact, 'EXAMPLE.COM.')).toBe(true);
  });
  it('a bare public suffix is never an organizational root', () => {
    const badRoot: OriginRule = { ...subs, host: 'com' };
    expect(hostMatchesRule(badRoot, 'anything.com')).toBe(false);
  });
});

describe('IPv6 and mapped-IPv4 address classification', () => {
  it('unwraps ::ffff:127.0.0.1 to loopback', () => {
    const a = normalizeAddress('::ffff:127.0.0.1');
    expect(a.family).toBe(4);
    expect(a.klass).toBe('loopback');
  });
  it('unwraps the hex-encoded mapped form ::ffff:7f00:1 to loopback', () => {
    expect(normalizeAddress('::ffff:7f00:1').klass).toBe('loopback');
  });
  it('classifies ::1 as loopback and fe80:: as link-local', () => {
    expect(normalizeAddress('::1').klass).toBe('loopback');
    expect(normalizeAddress('fe80::1').klass).toBe('link_local');
  });
  it('classifies fc00::/7 as unique-local (private) and a global v6 as public', () => {
    expect(normalizeAddress('fc00::1').klass).toBe('unique_local');
    expect(normalizeAddress('2606:4700:4700::1111').klass).toBe('public');
  });
  it('CIDR containment works for IPv6', () => {
    expect(addressInCidr(normalizeAddress('2001:db8::5'), '2001:db8::/32')).toBe(true);
    expect(addressInCidr(normalizeAddress('2001:dead::5'), '2001:db8::/32')).toBe(false);
  });
  it('a hard-denied v6 loopback in a lab request is denied', () => {
    const dec = evaluateAuthorization(labScope(), {
      ...labReq,
      host: 'app.example.test',
      resolvedAddresses: ['::1'],
    });
    expect(dec.verdict).toBe('deny');
    expect(dec.reasonCode).toBe('ADDRESS_BLOCKED');
  });
});

describe('exclusions before includes', () => {
  it('an exclusion covering the host denies an otherwise in-scope request', () => {
    const scope = labScope();
    scope.exclusions = [
      {
        rule_id: 'x',
        host: 'app.example.test',
        match: 'exact',
        include_apex: true,
        schemes: ['https'],
        ports: [443],
        path_prefixes: ['/'],
        methods: ['GET'],
        zone: 'lab',
      },
    ];
    const dec = evaluateAuthorization(scope, {
      ...labReq,
      host: 'app.example.test',
      resolvedAddresses: ['192.0.2.10'],
    });
    expect(dec.verdict).toBe('deny');
    expect(dec.reasonCode).toBe('EXCLUSION_MATCH');
  });
});

describe('shared-IP: hostname grant does not authorize a co-located host', () => {
  it('a different vhost on the same lab IP is denied (host not in scope)', () => {
    const dec = evaluateAuthorization(labScope(), {
      ...labReq,
      host: 'other.example.test',
      resolvedAddresses: ['192.0.2.10'],
    });
    expect(dec.verdict).toBe('deny');
    expect(dec.reasonCode).toBe('HOST_NOT_IN_SCOPE');
  });
});

describe('lab-zone CIDR containment', () => {
  it('allows an address inside the declared lab range', () => {
    const dec = evaluateAuthorization(labScope(), {
      ...labReq,
      host: 'app.example.test',
      resolvedAddresses: ['192.0.2.10'],
    });
    expect(dec.verdict).toBe('allow');
  });
  it('denies a private address outside the declared lab range', () => {
    const dec = evaluateAuthorization(labScope(), {
      ...labReq,
      host: 'app.example.test',
      resolvedAddresses: ['10.2.0.5'],
    });
    expect(dec.verdict).toBe('deny');
    expect(dec.reasonCode).toBe('ADDRESS_NOT_IN_LAB_SCOPE');
  });
});

describe('automatic never overrides an explicit deny', () => {
  it('automatic mode still denies an out-of-scope host', () => {
    const dec = evaluateAuthorization(labScope(), {
      ...labReq,
      mode: 'automatic',
      host: 'nope.example.test',
      resolvedAddresses: ['192.0.2.10'],
    });
    expect(dec.verdict).toBe('deny');
  });
  it('automatic mode still denies a revoked grant', () => {
    const dec = evaluateAuthorization(labScope(), {
      ...labReq,
      grantStatus: 'revoked',
      host: 'app.example.test',
      resolvedAddresses: ['192.0.2.10'],
    });
    expect(dec.verdict).toBe('deny');
    expect(dec.reasonCode).toBe('GRANT_REVOKED');
  });
});

describe('dependency / third-party is explicit_only', () => {
  it('denies a dependency host that is not an explicit allowed origin', () => {
    const dec = evaluateAuthorization(labScope(), {
      ...labReq,
      host: 'cdn.dep.test',
      dependency: true,
      resolvedAddresses: ['192.0.2.10'],
    });
    expect(dec.verdict).toBe('deny');
    expect(dec.reasonCode).toBe('DEPENDENCY_EXPLICIT_ONLY');
  });
  it('allows a dependency host that IS an explicit rule and otherwise valid', () => {
    const dec = evaluateAuthorization(labScope(), {
      ...labReq,
      host: 'app.example.test',
      dependency: true,
      resolvedAddresses: ['192.0.2.10'],
    });
    expect(dec.verdict).toBe('allow');
  });
});

describe('mode matrix (approval applied after authorization)', () => {
  const base = { ...labReq, host: 'app.example.test', resolvedAddresses: ['192.0.2.10'] };
  it('always_ask asks for an in-scope request', () => {
    expect(evaluateAuthorization(labScope(), { ...base, mode: 'always_ask' }).verdict).toBe('ask');
  });
  it('ask_high_risk allows routine, asks for high risk', () => {
    expect(
      evaluateAuthorization(labScope(), { ...base, mode: 'ask_high_risk', riskTier: 'routine' })
        .verdict,
    ).toBe('allow');
    expect(
      evaluateAuthorization(labScope(), { ...base, mode: 'ask_high_risk', riskTier: 'high' })
        .verdict,
    ).toBe('ask');
  });
  it('reject denies execution but ask-without-execution is always allowed', () => {
    expect(evaluateAuthorization(labScope(), { ...base, mode: 'reject' }).verdict).toBe('deny');
    expect(
      evaluateAuthorization(labScope(), { ...base, mode: 'reject', actionKind: 'ask_no_execution' })
        .verdict,
    ).toBe('allow');
  });
});

describe('decidePolicyCase returns structured reasons', () => {
  it('POL-003 deceptive suffix carries HOST_NOT_IN_SCOPE', () => {
    const v = vectors.cases.find((c) => c.id === 'POL-003')!;
    const dec = decidePolicyCase(v.context, fixtureScope);
    expect(dec.verdict).toBe('deny');
    expect(dec.reasonCode).toBe('HOST_NOT_IN_SCOPE');
  });
});
