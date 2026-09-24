/**
 * Secret / canary egress-surface scanning (docs/11 §5, §9 acceptance).
 *
 * A canary is a known secret value a test plants into a context source; the redaction
 * pipeline must turn it into a reference, so it must NOT survive to any egress
 * surface. {@link scanForSecret} deep-stringifies each surface — request headers, the
 * wire body, an HTML preview, error objects, log lines and the mock's payload capture
 * — and reports every surface where the needle (or its base64 echo) appears.
 * {@link assertNoSecretLeak} throws on any leak, WITHOUT putting the secret in the
 * error message (it names the surfaces only).
 */

/** Namespaced canary sentinel; unmistakable in any surface if a leak occurs. */
export const CANARY_PREFIX = 'REDAI_CANARY_';

/** Mint a unique canary value. Deterministic when `seed` is supplied (tests). */
export function makeCanary(seed?: string): string {
  if (seed !== undefined) return `${CANARY_PREFIX}${seed}`;
  const rand = Math.random().toString(36).slice(2) + Date.now().toString(36);
  return `${CANARY_PREFIX}${rand}`;
}

/** The egress surfaces a canary test inspects. All optional; absent ones are skipped. */
export interface EgressSurfaces {
  headers?: Record<string, string> | Headers | Map<string, string>;
  /** The wire request body (object or string). */
  body?: unknown;
  /** An HTML preview / attribute rendering. */
  html?: string;
  /** Error objects or messages surfaced to the user / logs. */
  errors?: unknown[];
  /** Log lines. */
  logs?: string[];
  /** The mock provider's captured payload (CapturedPayload or any object). */
  payloadCapture?: unknown;
}

function stringifySurface(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`;
  if (value instanceof Map) {
    return JSON.stringify(Object.fromEntries(value.entries()));
  }
  if (typeof Headers !== 'undefined' && value instanceof Headers) {
    const obj: Record<string, string> = {};
    value.forEach((v, k) => {
      obj[k] = v;
    });
    return JSON.stringify(obj);
  }
  try {
    return JSON.stringify(value, (_k, v) => {
      if (v instanceof Error) return `${v.name}: ${v.message}`;
      if (v instanceof Map) return Object.fromEntries(v.entries());
      return v;
    });
  } catch {
    return String(value);
  }
}

/** Every needle to search for: the raw value and its base64 echo. */
function needles(secret: string): string[] {
  const b64 = Buffer.from(secret, 'utf8').toString('base64');
  return secret === b64 ? [secret] : [secret, b64];
}

/** Return the list of surfaces where `secret` (or its base64 echo) appears. */
export function scanForSecret(surfaces: EgressSurfaces, secret: string): string[] {
  const found = new Set<string>();
  if (secret.length === 0) return [];
  const ns = needles(secret);
  const check = (name: string, value: unknown): void => {
    const hay = stringifySurface(value);
    if (hay.length === 0) return;
    if (ns.some((n) => hay.includes(n))) found.add(name);
  };

  check('headers', surfaces.headers);
  check('body', surfaces.body);
  check('html', surfaces.html);
  if (surfaces.errors) surfaces.errors.forEach((e, i) => check(`errors[${i}]`, e));
  if (surfaces.logs) check('logs', surfaces.logs.join('\n'));
  check('payloadCapture', surfaces.payloadCapture);

  return [...found];
}

/** Throw if `secret` appears in any surface. The error names surfaces, never the secret. */
export function assertNoSecretLeak(surfaces: EgressSurfaces, secret: string): void {
  const leaks = scanForSecret(surfaces, secret);
  if (leaks.length > 0) {
    throw new Error(`secret/canary leaked into egress surface(s): ${leaks.join(', ')}`);
  }
}
