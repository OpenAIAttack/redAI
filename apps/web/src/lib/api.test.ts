// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { apiRequest, setCsrfToken, ApiError } from './api';

/**
 * API client contract: mutations carry the CSRF header + credentials, error
 * envelopes are parsed into a typed ApiError (with code + retry-after), and a 204
 * yields no body. `fetch` is mocked; no network is touched.
 */
function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('apiRequest', () => {
  beforeEach(() => {
    setCsrfToken(null);
    // jsdom sets document.cookie; ensure no CSRF cookie leaks between tests.
    Object.defineProperty(document, 'cookie', { writable: true, value: '' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends credentials and no CSRF header on GET', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await apiRequest('/api/v1/thing');
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('attaches the in-memory CSRF token on a mutation', async () => {
    setCsrfToken('csrf-abc');
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    await apiRequest('/api/v1/thing', { method: 'POST', body: { a: 1 } });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-abc');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    vi.unstubAllGlobals();
  });

  it('prefers the CSRF cookie over the in-memory token', async () => {
    setCsrfToken('memory-token');
    Object.defineProperty(document, 'cookie', { writable: true, value: 'csrf_token=cookie-token' });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(204, null));
    vi.stubGlobal('fetch', fetchMock);
    await apiRequest('/api/v1/thing', { method: 'DELETE' });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('cookie-token');
    vi.unstubAllGlobals();
  });

  it('parses the error envelope into a typed ApiError', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          429,
          { error: { code: 'RATE_LIMITED', message: 'Too many', retryable: true } },
          { 'retry-after': '30' },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      apiRequest('/api/v1/auth/login', { method: 'POST', body: {} }),
    ).rejects.toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      retryAfterSeconds: 30,
    });
    vi.unstubAllGlobals();
  });

  it('returns undefined for a 204 No Content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(204, null));
    vi.stubGlobal('fetch', fetchMock);
    const result = await apiRequest('/api/v1/thing', { method: 'POST', body: {} });
    expect(result).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('surfaces a non-JSON failure as an ApiError with an HTTP code', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
    const err = await apiRequest('/api/v1/thing').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    vi.unstubAllGlobals();
  });
});
