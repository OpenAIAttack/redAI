/**
 * Minimal, dependency-free cookie parsing and serialization for the auth plugin.
 * The session cookie is HttpOnly (unreadable from JS); the CSRF cookie is not, so
 * the browser can echo it for the double-submit check. Both use `SameSite=Strict`,
 * `Path=/`, no `Domain`, and — when served over HTTPS — the `__Host-` prefix, which
 * the browser only honours with `Secure` + `Path=/` + no `Domain`.
 */

export interface CookieNames {
  session: string;
  csrf: string;
}

export function cookieNames(secure: boolean): CookieNames {
  const prefix = secure ? '__Host-' : '';
  return { session: `${prefix}redai_session`, csrf: `${prefix}redai_csrf` };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    const value = part.slice(eq + 1).trim();
    out[name] = decodeURIComponent(value);
  }
  return out;
}

export interface SerializeOptions {
  secure: boolean;
  httpOnly: boolean;
  maxAgeSeconds?: number;
}

export function serializeCookie(name: string, value: string, opts: SerializeOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Strict'];
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  if (opts.maxAgeSeconds !== undefined) parts.push(`Max-Age=${opts.maxAgeSeconds}`);
  return parts.join('; ');
}

/** A cookie that expires immediately (logout), keeping matching attributes. */
export function clearCookie(name: string, opts: SerializeOptions): string {
  return serializeCookie(name, '', { ...opts, maxAgeSeconds: 0 });
}
