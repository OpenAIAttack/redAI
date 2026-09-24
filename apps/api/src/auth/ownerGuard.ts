/**
 * Shared owner-auth guard adapter (coordinator wiring).
 *
 * The T05/T06/T15 plugins each accept an injected owner-auth surface
 * (`authenticate` + `authorizeMutation` / `resolveOwner`). This adapts the T04
 * `AuthService` + HTTP config to that shape, reusing the SAME rules as the auth
 * plugin: session resolved from the session cookie ONLY (a worker bearer is
 * never accepted), and mutations require an allowed Origin plus a session-bound
 * CSRF double-submit. The full `SessionContext` is cached per-request (WeakMap)
 * so `authorizeMutation` can check CSRF without a second DB round-trip.
 */
import type { FastifyRequest } from 'fastify';
import {
  AuthService,
  SessionInvalidError,
  constantTimeEqual,
  hashToken,
  type SessionContext,
} from '@redai/application';
import { cookieNames, parseCookies } from './cookies.js';
import type { AuthHttpConfig } from './plugin.js';

export interface OwnerGuardContext {
  ownerId: string;
  workspaceId: string;
}

export interface OwnerGuard {
  authenticate(req: FastifyRequest): Promise<OwnerGuardContext | null>;
  authorizeMutation(req: FastifyRequest, ctx: OwnerGuardContext): boolean;
}

function originAllowed(req: FastifyRequest, config: AuthHttpConfig): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '') return false;
  if (config.allowedOrigins.includes(origin)) return true;
  const host = req.headers.host;
  try {
    return typeof host === 'string' && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function createOwnerGuard(auth: AuthService, config: AuthHttpConfig): OwnerGuard {
  const names = cookieNames(config.cookieSecure);
  const sessions = new WeakMap<FastifyRequest, SessionContext>();

  return {
    async authenticate(req) {
      const token = parseCookies(req.headers.cookie)[names.session];
      if (!token) return null;
      try {
        const ctx = await auth.validateSession(token);
        sessions.set(req, ctx);
        return { ownerId: ctx.ownerId, workspaceId: ctx.workspaceId };
      } catch (err) {
        if (err instanceof SessionInvalidError) return null;
        throw err;
      }
    },
    authorizeMutation(req) {
      if (!originAllowed(req, config)) return false;
      const ctx = sessions.get(req);
      if (!ctx) return false;
      const header = req.headers['x-csrf-token'];
      if (typeof header !== 'string' || header === '') return false;
      const cookie = parseCookies(req.headers.cookie)[names.csrf];
      // Double-submit (header == cookie) AND session-bound (hash matches).
      if (typeof cookie !== 'string' || cookie !== header) return false;
      return constantTimeEqual(hashToken(header), ctx.csrfHash);
    },
  };
}
