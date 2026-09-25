import type { FastifyRequest } from 'fastify';
import type { AuthHttpConfig } from './plugin.js';

/** An origin is scheme + host + port; matching host alone permits protocol downgrade. */
export function originAllowed(req: FastifyRequest, config: AuthHttpConfig): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !origin) return false;
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) return false;
    return (
      config.allowedOrigins.includes(origin) || origin === `${req.protocol}://${req.headers.host}`
    );
  } catch {
    return false;
  }
}
