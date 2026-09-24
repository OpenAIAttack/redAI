/**
 * Fastify owner-auth plugin: login / logout / session routes with a secure session
 * cookie, CSRF double-submit + Origin allowlist on state-changing requests, login
 * rate limiting, and a guard that only ever consults the owner session cookie — a
 * worker bearer credential is never accepted on an owner endpoint.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AuthService,
  InvalidCredentialsError,
  SessionInvalidError,
  constantTimeEqual,
  hashToken,
  type Clock,
  type SessionContext,
} from '@redai/application';
import { clearCookie, cookieNames, parseCookies, serializeCookie } from './cookies.js';
import { sendError } from './errors.js';
import { BodyValidationError, parseLoginRequest } from './bodySchemas.js';
import { DEFAULT_RATE_LIMIT, LoginRateLimiter, type RateLimitConfig } from './rateLimit.js';

const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

export interface AuthHttpConfig {
  /** Serve `Secure` cookies with the `__Host-` prefix (HTTPS). */
  cookieSecure: boolean;
  /** Extra exact origins allowed for mutations, on top of same-origin. */
  allowedOrigins: string[];
  rateLimit?: RateLimitConfig;
  /** Cookie Max-Age; the server still enforces idle+absolute expiry server-side. */
  sessionCookieMaxAgeSeconds?: number;
}

export interface AuthPluginDeps {
  auth: AuthService;
  clock: Clock;
  config: AuthHttpConfig;
}

function originAllowed(req: FastifyRequest, config: AuthHttpConfig): boolean {
  const origin = req.headers.origin;
  // A state-changing request MUST carry an Origin we recognise (OWASP; docs/13 §2).
  if (typeof origin !== 'string' || origin === '') return false;
  if (config.allowedOrigins.includes(origin)) return true;
  const host = req.headers.host;
  try {
    return typeof host === 'string' && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function registerAuth(app: FastifyInstance, deps: AuthPluginDeps): void {
  const { auth, config } = deps;
  const limiter = new LoginRateLimiter(deps.clock, config.rateLimit ?? DEFAULT_RATE_LIMIT);
  const names = cookieNames(config.cookieSecure);
  const maxAge = config.sessionCookieMaxAgeSeconds ?? SEVEN_DAYS_SECONDS;

  const setSessionCookies = (reply: FastifyReply, token: string, csrfToken: string): void => {
    reply.header('set-cookie', [
      serializeCookie(names.session, token, {
        secure: config.cookieSecure,
        httpOnly: true,
        maxAgeSeconds: maxAge,
      }),
      serializeCookie(names.csrf, csrfToken, {
        secure: config.cookieSecure,
        httpOnly: false,
        maxAgeSeconds: maxAge,
      }),
    ]);
  };

  /**
   * Resolve the owner session from the session cookie ONLY. The `Authorization`
   * header (where a worker bearer credential would live) is deliberately ignored,
   * so a worker credential can never authenticate an owner endpoint.
   */
  const authenticate = async (req: FastifyRequest): Promise<SessionContext | null> => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[names.session];
    if (!token) return null;
    try {
      return await auth.validateSession(token);
    } catch (err) {
      if (err instanceof SessionInvalidError) return null;
      throw err;
    }
  };

  const csrfValid = (req: FastifyRequest, ctx: SessionContext): boolean => {
    const header = req.headers['x-csrf-token'];
    if (typeof header !== 'string' || header === '') return false;
    const cookies = parseCookies(req.headers.cookie);
    const cookie = cookies[names.csrf];
    // Double-submit: header must equal the CSRF cookie...
    if (typeof cookie !== 'string' || cookie !== header) return false;
    // ...and be the token bound to THIS session (compared as hashes, constant time).
    return constantTimeEqual(hashToken(header), ctx.csrfHash);
  };

  app.post('/api/v1/auth/login', async (req, reply) => {
    if (!originAllowed(req, config)) {
      return sendError(reply, 403, 'FORBIDDEN_ORIGIN', 'Origin not allowed.');
    }
    let body;
    try {
      body = parseLoginRequest(req.body);
    } catch (err) {
      if (err instanceof BodyValidationError) {
        return sendError(reply, 422, 'INVALID_BODY', 'Invalid request body.');
      }
      throw err;
    }

    const key = LoginRateLimiter.key(req.ip, body.username);
    const decision = limiter.check(key);
    if (!decision.allowed) {
      return sendError(reply, 429, 'RATE_LIMITED', 'Too many login attempts.', {
        retryable: true,
        details: { retry_after: decision.retryAfterSeconds },
        headers: { 'retry-after': String(decision.retryAfterSeconds) },
      });
    }

    try {
      const result = await auth.login({ username: body.username, password: body.password });
      limiter.recordSuccess(key);
      setSessionCookies(reply, result.secrets.token, result.secrets.csrfToken);
      return reply.code(200).send(result.profile);
    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        limiter.recordFailure(key);
        // Generic message: never reveal whether the username exists.
        return sendError(reply, 401, 'INVALID_CREDENTIALS', 'Invalid credentials.');
      }
      throw err;
    }
  });

  app.get('/api/v1/auth/session', async (req, reply) => {
    const ctx = await authenticate(req);
    if (!ctx) return sendError(reply, 401, 'UNAUTHENTICATED', 'No valid session.');

    const cookies = parseCookies(req.headers.cookie);
    const csrfCookie = cookies[names.csrf];
    let csrfToken: string;
    if (
      typeof csrfCookie === 'string' &&
      csrfCookie !== '' &&
      constantTimeEqual(hashToken(csrfCookie), ctx.csrfHash)
    ) {
      csrfToken = csrfCookie;
    } else {
      // Cold-load without the CSRF cookie: mint and persist a fresh bound token.
      csrfToken = await auth.rotateSessionCsrf(ctx.sessionId);
      reply.header(
        'set-cookie',
        serializeCookie(names.csrf, csrfToken, {
          secure: config.cookieSecure,
          httpOnly: false,
          maxAgeSeconds: maxAge,
        }),
      );
    }
    return reply.code(200).send(auth.profileFromContext(ctx, csrfToken));
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    if (!originAllowed(req, config)) {
      return sendError(reply, 403, 'FORBIDDEN_ORIGIN', 'Origin not allowed.');
    }
    const ctx = await authenticate(req);
    if (!ctx) return sendError(reply, 401, 'UNAUTHENTICATED', 'No valid session.');
    if (!csrfValid(req, ctx)) {
      return sendError(reply, 403, 'CSRF_INVALID', 'Missing or invalid CSRF token.');
    }

    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[names.session];
    if (token) await auth.logout(token);
    reply.header('set-cookie', [
      clearCookie(names.session, { secure: config.cookieSecure, httpOnly: true }),
      clearCookie(names.csrf, { secure: config.cookieSecure, httpOnly: false }),
    ]);
    return reply.code(204).send();
  });
}
