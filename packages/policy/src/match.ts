/**
 * Pure scope-rule matching: host rules (exact / subdomains with apex control and
 * deceptive-suffix defense), scheme/port/path/method membership, and CIDR
 * containment for declared lab IP ranges. No rule here relaxes a check; a rule that
 * cannot be applied unambiguously simply does not match.
 */
import { isPublicSuffix, normalizeHost, type NormalizedAddress } from './normalize.js';

/** One origin/exclusion rule, shaped exactly like the `scope.schema.json` rule. */
export interface OriginRule {
  rule_id: string;
  host: string;
  match: 'exact' | 'subdomains';
  include_apex: boolean;
  schemes: string[];
  ports: number[];
  path_prefixes: string[];
  methods: string[];
  zone: string;
  lab_ip_ranges?: string[];
}

/**
 * Host-level match with strict label-boundary semantics. This is the deceptive-suffix
 * defense: `example.com` never matches `evil-example.com` (exact inequality) nor
 * `example.com.attacker.com` (the rule root is not a label-aligned suffix). A
 * `subdomains` rule matches a strict descendant, and the apex only when
 * `include_apex` is true (POL-027/028). A rule whose root is a bare public suffix is
 * rejected — it can never be an organizational root (docs/10 §2).
 */
export function hostMatchesRule(rule: OriginRule, targetHost: string): boolean {
  const root = normalizeHost(rule.host);
  const host = normalizeHost(targetHost);
  if (!root || !host) return false;
  if (isPublicSuffix(root)) return false;

  if (rule.match === 'exact') {
    return host === root;
  }
  // subdomains
  if (host === root) return rule.include_apex === true;
  // Strict descendant: must end with ".<root>" at a label boundary.
  return host.endsWith(`.${root}`);
}

export function schemeMatchesRule(rule: OriginRule, scheme: string): boolean {
  return rule.schemes.includes(scheme.toLowerCase());
}

export function portMatchesRule(rule: OriginRule, port: number): boolean {
  return rule.ports.includes(port);
}

export function methodMatchesRule(rule: OriginRule, method: string): boolean {
  return rule.methods.includes(method.toUpperCase());
}

/**
 * Boundary-aware path-prefix match: a prefix authorizes the target when the target
 * equals the prefix or continues it at a segment boundary. So prefix `/api/`
 * authorizes `/api/health` but NOT `/api2/health` (POL-007), and prefix `/api`
 * authorizes `/api` and `/api/...` but not `/apix`.
 */
export function pathMatchesRule(rule: OriginRule, path: string): boolean {
  return rule.path_prefixes.some((prefix) => pathHasPrefix(path, prefix));
}

function pathHasPrefix(path: string, prefix: string): boolean {
  if (path === prefix) return true;
  if (path.startsWith(prefix)) {
    // Exact-boundary or the prefix already ends in a separator.
    return prefix.endsWith('/') || path[prefix.length] === '/';
  }
  return false;
}

/** True when every component (host, scheme, port, path, method) of the target
 * matches this single rule. Address/zone are validated separately by the engine. */
export function ruleMatchesRequest(
  rule: OriginRule,
  req: { host: string; scheme: string; port: number; path: string; method: string },
): boolean {
  return (
    hostMatchesRule(rule, req.host) &&
    schemeMatchesRule(rule, req.scheme) &&
    portMatchesRule(rule, req.port) &&
    pathMatchesRule(rule, req.path) &&
    methodMatchesRule(rule, req.method)
  );
}

/** Host-only exclusion overlap: an exclusion applies if its host pattern covers the
 * target host, independent of scheme/port/path (an exclusion is a broad deny). */
export function exclusionCoversHost(rule: OriginRule, targetHost: string): boolean {
  return hostMatchesRule(rule, targetHost);
}

// --------------------------------------------------------------------- CIDR

/** True when the normalized address falls inside the given CIDR string. Supports
 * IPv4 and IPv6 CIDRs. A malformed CIDR never matches (fail closed). */
export function addressInCidr(addr: NormalizedAddress, cidr: string): boolean {
  const slash = cidr.indexOf('/');
  if (slash < 0) {
    // Bare address: exact match on canonical form.
    return addr.canonical === cidr.trim().toLowerCase();
  }
  const base = cidr.slice(0, slash).trim().toLowerCase();
  const bits = Number(cidr.slice(slash + 1));
  if (!Number.isInteger(bits) || bits < 0) return false;

  if (addr.family === 4 && !base.includes(':')) {
    if (bits > 32) return false;
    const a = ipv4ToInt(addr.canonical);
    const b = ipv4ToInt(base);
    if (a === null || b === null) return false;
    if (bits === 0) return true;
    const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
    return (a & mask) >>> 0 === (b & mask) >>> 0;
  }
  if (addr.family === 6 && base.includes(':')) {
    if (bits > 128) return false;
    const a = ipv6ToBytes(addr.canonical);
    const b = ipv6ToBytes(base);
    if (!a || !b) return false;
    let remaining = bits;
    for (let i = 0; i < 16; i += 1) {
      if (remaining <= 0) break;
      const take = Math.min(8, remaining);
      const m = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff;
      if ((a[i]! & m) !== (b[i]! & m)) return false;
      remaining -= take;
    }
    return true;
  }
  return false;
}

/** True when the address is contained in ANY of the rule's declared lab ranges. */
export function addressInAnyLabRange(addr: NormalizedAddress, rule: OriginRule): boolean {
  const ranges = rule.lab_ip_ranges ?? [];
  return ranges.some((cidr) => addressInCidr(addr, cidr));
}

function ipv4ToInt(text: string): number | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let v = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    v = (v << 8) | n;
  }
  return v >>> 0;
}

function ipv6ToBytes(text: string): number[] | null {
  // `text` is the canonical (already-expanded-then-compressed) lowercase form from
  // normalizeAddress; re-expand defensively.
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  let groups: number[];
  if (halves.length === 2) {
    const head = toGroups(halves[0]!);
    const tail = toGroups(halves[1]!);
    if (!head || !tail) return null;
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array<number>(fill).fill(0), ...tail];
  } else {
    const g = toGroups(text);
    if (!g || g.length !== 8) return null;
    groups = g;
  }
  const bytes: number[] = [];
  for (const grp of groups) {
    bytes.push((grp >> 8) & 0xff, grp & 0xff);
  }
  return bytes;
}
