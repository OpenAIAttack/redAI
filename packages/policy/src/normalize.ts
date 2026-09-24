/**
 * Host, address and path canonicalization — the single place a target is turned
 * into its comparison form before any scope rule is applied (docs/10 §4:
 * "canonicalize target" happens once, exclusions before includes).
 *
 * Everything here is PURE: no DNS, no sockets, no globals. Callers pass the raw
 * host / resolved addresses / request path and receive a normalized shape or a
 * typed "ambiguous → fail closed" signal. The engine never trusts a value it
 * could not canonicalize unambiguously.
 */

/** A small, explicit public-suffix denylist (docs/10 §2: a public suffix such as
 * `com` / `co.uk` must never be used as an organizational root). This is a
 * deliberately minimal list covering the suffixes the fixtures and common
 * personal-use roots touch; it is a fail-closed guard, not a full PSL. */
export const PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  'com',
  'net',
  'org',
  'io',
  'dev',
  'app',
  'co',
  'test',
  'co.uk',
  'org.uk',
  'gov.uk',
  'ac.uk',
  'com.au',
  'com.br',
  'co.jp',
]);

/**
 * Normalize a DNS host for comparison: strip a single trailing dot, lowercase
 * (ASCII), and reject anything that still contains characters a hostname may not
 * have. Returns null when the host is empty or structurally invalid — the caller
 * treats null as "no match" (fail closed), never as a wildcard.
 *
 * IDNA note: inputs are expected already in A-label (ASCII/punycode) form
 * (`xn--…`). We do NOT attempt Unicode→ASCII conversion here (that belongs to the
 * trusted authoring/validation layer); a host containing non-ASCII letters is
 * rejected so a homograph can never silently match an ASCII rule.
 */
export function normalizeHost(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let h = raw.trim();
  if (h.length === 0) return null;
  // Strip exactly one trailing dot (the DNS root label), if present.
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h.length === 0 || h.length > 253) return null;
  h = h.toLowerCase();
  // Labels: 1..63 chars, alphanumeric or hyphen, not leading/trailing hyphen.
  const labels = h.split('.');
  if (labels.length < 1) return null;
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return null;
    if (!/^[a-z0-9-]+$/.test(label)) return null;
    if (label.startsWith('-') || label.endsWith('-')) return null;
  }
  return h;
}

/** True when `host` is exactly a known public suffix (an invalid organizational root). */
export function isPublicSuffix(host: string): boolean {
  return PUBLIC_SUFFIXES.has(host);
}

export type AddressClass =
  | 'public'
  | 'loopback'
  | 'link_local'
  | 'metadata'
  | 'private'
  | 'unique_local'
  | 'unspecified'
  | 'multicast'
  | 'invalid';

export interface NormalizedAddress {
  /** Canonical text form: IPv4 dotted-quad, or lowercase IPv6 (mapped IPv4 unwrapped). */
  canonical: string;
  family: 4 | 6;
  klass: AddressClass;
}

function parseIpv4(text: string): number[] | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function classifyIpv4(octets: number[]): AddressClass {
  const [a, b] = octets as [number, number, number, number];
  if (a === 127) return 'loopback';
  if (a === 0) return 'unspecified';
  if (a === 169 && b === 254) {
    // 169.254.169.254 is the cloud metadata address; still link-local, called out.
    if (octets[2] === 169 && octets[3] === 254) return 'metadata';
    return 'link_local';
  }
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 100 && b >= 64 && b <= 127) return 'private'; // CGNAT 100.64.0.0/10
  if (a >= 224 && a <= 239) return 'multicast';
  return 'public';
}

/**
 * Normalize a resolved address. Handles IPv4, IPv6, and IPv4-mapped IPv6
 * (`::ffff:127.0.0.1` and `::ffff:7f00:1`) by unwrapping to the IPv4 form BEFORE
 * classification, so a mapped loopback is caught (POL-012). Returns klass
 * `'invalid'` for anything unparseable — the caller fails closed on it.
 */
export function normalizeAddress(raw: string): NormalizedAddress {
  const text = (raw ?? '').trim().toLowerCase();
  if (text.length === 0) return { canonical: text, family: 4, klass: 'invalid' };

  // Pure IPv4.
  if (!text.includes(':')) {
    const octets = parseIpv4(text);
    if (!octets) return { canonical: text, family: 4, klass: 'invalid' };
    return { canonical: octets.join('.'), family: 4, klass: classifyIpv4(octets) };
  }

  // IPv6. Detect an IPv4-mapped/embedded tail and unwrap it.
  const mapped = unwrapMappedIpv4(text);
  if (mapped) {
    const octets = parseIpv4(mapped);
    if (!octets) return { canonical: text, family: 6, klass: 'invalid' };
    // Report as IPv4 so lab-range (CIDR) checks compare on the real address.
    return { canonical: octets.join('.'), family: 4, klass: classifyIpv4(octets) };
  }

  const groups = expandIpv6(text);
  if (!groups) return { canonical: text, family: 6, klass: 'invalid' };
  const canonical = groups.map((g) => g.toString(16)).join(':');
  return { canonical, family: 6, klass: classifyIpv6(groups) };
}

/** Return the trailing dotted-quad of an IPv4-mapped/compat IPv6, or null. */
function unwrapMappedIpv4(text: string): string | null {
  // Forms: ::ffff:a.b.c.d  |  ::ffff:7f00:0001  |  ::a.b.c.d
  const dotted = text.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  const prefix = text.slice(0, text.length - (dotted?.[1]?.length ?? 0));
  if (dotted && (prefix === '::ffff:' || prefix === '::')) {
    return dotted[1] ?? null;
  }
  // Hex-encoded mapped form ::ffff:xxxx:xxxx
  const hex = text.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return null;
}

/** Expand an IPv6 text form to exactly 8 numeric groups, or null if malformed. */
function expandIpv6(text: string): number[] | null {
  if (text === '::') return [0, 0, 0, 0, 0, 0, 0, 0];
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const g of s.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  if (halves.length === 2) {
    const head = parse(halves[0]!);
    const tail = parse(halves[1]!);
    if (!head || !tail) return null;
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    return [...head, ...Array<number>(fill).fill(0), ...tail];
  }
  const only = parse(text);
  if (!only || only.length !== 8) return null;
  return only;
}

function classifyIpv6(groups: number[]): AddressClass {
  const [g0] = groups as number[];
  const first = g0 ?? 0;
  if (groups.every((g) => g === 0)) return 'unspecified';
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return 'loopback'; // ::1
  if ((first & 0xffc0) === 0xfe80) return 'link_local'; // fe80::/10
  if ((first & 0xfe00) === 0xfc00) return 'unique_local'; // fc00::/7
  if ((first & 0xff00) === 0xff00) return 'multicast'; // ff00::/8
  return 'public';
}

/** Address classes that are ALWAYS denied regardless of scope (SSRF-sensitive). */
const HARD_DENY_CLASSES: ReadonlySet<AddressClass> = new Set<AddressClass>([
  'loopback',
  'link_local',
  'metadata',
  'unspecified',
  'multicast',
  'invalid',
]);

export function isHardDeniedAddress(a: NormalizedAddress): boolean {
  return HARD_DENY_CLASSES.has(a.klass);
}

export interface NormalizedPath {
  path: string;
  /** True when the raw path is ambiguous (encoded traversal / parser disagreement). */
  ambiguous: boolean;
}

/**
 * Canonicalize a request path for prefix comparison. If the path still contains a
 * percent-encoded segment that could decode to a path separator or dot-segment
 * (`%2e`, `%2f`, `%5c`) the canonical form is AMBIGUOUS — two parsers may disagree —
 * so we flag it and the engine fails closed (POL-025). We do not attempt to "fix"
 * such a path; ambiguity is a denial, not a normalization.
 */
export function normalizePath(raw: string): NormalizedPath {
  const path = typeof raw === 'string' && raw.length > 0 ? raw : '/';
  const lower = path.toLowerCase();
  const ambiguous =
    /%2e/.test(lower) || /%2f/.test(lower) || /%5c/.test(lower) || path.includes('\\');
  return { path, ambiguous };
}
