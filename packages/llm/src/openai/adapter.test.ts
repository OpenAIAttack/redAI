import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  LlmAuthError,
  LlmBadRequestError,
  LlmCanceledError,
  LlmConfigError,
  LlmProtocolError,
  LlmRateLimitedError,
  LlmServerError,
  LlmTimeoutError,
} from '../errors.js';
import type { GenerateRequest } from '../types.js';
import { OpenAiCompatibleProvider } from './adapter.js';

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
  ctx: { count: number },
) => void;

let server: Server | undefined;
const sockets = new Set<Socket>();

async function start(handler: Handler): Promise<string> {
  const ctx = { count: 0 };
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('error', () => undefined);
    req.on('end', () => {
      ctx.count += 1;
      handler(req, res, body, ctx);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/v1`;
}

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

function jsonResponse(res: ServerResponse, status: number, payload: unknown): void {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function sse(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

const request: GenerateRequest = {
  messages: [{ role: 'user', content: 'hello' }],
};

function providerFor(
  baseUrl: string,
  opts: Partial<ConstructorParameters<typeof OpenAiCompatibleProvider>[0]> = {},
) {
  return new OpenAiCompatibleProvider({
    baseUrl,
    model: 'test-model',
    label: 'test-endpoint',
    ...opts,
  });
}

describe('OpenAiCompatibleProvider — construction', () => {
  it('rejects a non-http base URL', () => {
    expect(() => providerFor('ftp://example.invalid')).toThrow(LlmConfigError);
    expect(() => providerFor('not a url')).toThrow(LlmConfigError);
  });
});

describe('OpenAiCompatibleProvider — non-streaming', () => {
  it('maps a text completion with usage', async () => {
    const baseUrl = await start((_req, res) => {
      jsonResponse(res, 200, {
        choices: [{ message: { role: 'assistant', content: 'hi there' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });
    });
    const result = await providerFor(baseUrl).generate(request);
    expect(result.text).toBe('hi there');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({
      kind: 'known',
      inputTokens: 5,
      outputTokens: 2,
      totalTokens: 7,
    });
    expect(result.isMock).toBe(false);
  });

  it('records unknown usage when the provider omits it', async () => {
    const baseUrl = await start((_req, res) => {
      jsonResponse(res, 200, {
        choices: [{ message: { role: 'assistant', content: 'no usage' }, finish_reason: 'stop' }],
      });
    });
    const result = await providerFor(baseUrl).generate(request);
    expect(result.usage).toEqual({ kind: 'unknown' });
  });

  it('maps a tool call', async () => {
    const baseUrl = await start((_req, res) => {
      jsonResponse(res, 200, {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'file_read', arguments: '{"path":"/x","max_bytes":10}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
      });
    });
    const result = await providerFor(baseUrl).generate(request);
    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls?.[0]).toMatchObject({ id: 'call_1', name: 'file_read' });
    expect(result.toolCalls?.[0]?.arguments).toEqual({ path: '/x', max_bytes: 10 });
  });

  it('sends a Bearer token and never leaks it in errors', async () => {
    let authHeader: string | undefined;
    const baseUrl = await start((req, res) => {
      authHeader = req.headers['authorization'];
      jsonResponse(res, 401, { error: 'bad key sk-secret-xyz' });
    });
    const provider = providerFor(baseUrl, { apiKey: 'sk-secret-xyz' });
    const err = await provider.generate(request).catch((e) => e);
    expect(authHeader).toBe('Bearer sk-secret-xyz');
    expect(err).toBeInstanceOf(LlmAuthError);
    expect(JSON.stringify({ msg: err.message, name: err.name })).not.toContain('sk-secret-xyz');
  });

  it('maps a non-JSON body to a protocol error', async () => {
    const baseUrl = await start((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('<html>not json</html>');
    });
    await expect(providerFor(baseUrl).generate(request)).rejects.toBeInstanceOf(LlmProtocolError);
  });
});

describe('OpenAiCompatibleProvider — error taxonomy', () => {
  it('maps 429 to a rate-limit error with Retry-After', async () => {
    const baseUrl = await start((_req, res) => {
      res.writeHead(429, { 'retry-after': '2', 'content-type': 'application/json' });
      res.end('{"error":"slow down"}');
    });
    const err = await providerFor(baseUrl)
      .generate(request)
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmRateLimitedError);
    expect(err.retryAfterMs).toBe(2000);
    expect(err.retryable).toBe(true);
  });

  it('maps 401/403 to auth, 400 to bad-request, 5xx to server', async () => {
    for (const [status, ctor] of [
      [401, LlmAuthError],
      [403, LlmAuthError],
      [400, LlmBadRequestError],
      [503, LlmServerError],
    ] as const) {
      const baseUrl = await start((_req, res) => jsonResponse(res, status, { error: 'x' }));
      await expect(providerFor(baseUrl).generate(request)).rejects.toBeInstanceOf(ctor);
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it('maps a slow response to a timeout error', async () => {
    const baseUrl = await start((_req, res) => {
      // Never respond; the client-side timeout must fire.
      setTimeout(() => res.end(), 5000).unref();
    });
    const err = await providerFor(baseUrl, { timeoutMs: 100 })
      .generate(request)
      .catch((e) => e);
    expect(err).toBeInstanceOf(LlmTimeoutError);
  });
});

describe('OpenAiCompatibleProvider — retries are explicit and bounded', () => {
  it('performs exactly ONE request by default (no hidden retries)', async () => {
    let count = 0;
    const baseUrl = await start((_req, res, _body, ctx) => {
      count = ctx.count;
      jsonResponse(res, 503, { error: 'unavailable' });
    });
    await expect(providerFor(baseUrl).generate(request)).rejects.toBeInstanceOf(LlmServerError);
    expect(count).toBe(1);
  });

  it('retries up to the configured attempt count on a retryable error', async () => {
    let count = 0;
    const baseUrl = await start((_req, res, _body, ctx) => {
      count = ctx.count;
      if (ctx.count < 2) {
        jsonResponse(res, 503, { error: 'unavailable' });
        return;
      }
      jsonResponse(res, 200, {
        choices: [{ message: { role: 'assistant', content: 'recovered' }, finish_reason: 'stop' }],
      });
    });
    const result = await providerFor(baseUrl, { retry: { maxAttempts: 2, backoffMs: 0 } }).generate(
      request,
    );
    expect(result.text).toBe('recovered');
    expect(count).toBe(2);
  });
});

describe('OpenAiCompatibleProvider — streaming', () => {
  it('assembles a streamed text + usage + finish', async () => {
    const baseUrl = await start((_req, res) => {
      sse(res);
      res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      res.write(
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const result = await providerFor(baseUrl).generate({ ...request, stream: true });
    expect(result.text).toBe('Hello');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({
      kind: 'known',
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
    });
  });

  it('assembles a streamed tool call across argument deltas', async () => {
    const baseUrl = await start((_req, res) => {
      sse(res);
      res.write(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"file_read","arguments":"{\\"path\\":"}}]}}]}\n\n',
      );
      res.write(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"/y\\",\\"max_bytes\\":8}"}}]}}]}\n\n',
      );
      res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const result = await providerFor(baseUrl).generate({ ...request, stream: true });
    expect(result.toolCalls?.[0]?.name).toBe('file_read');
    expect(result.toolCalls?.[0]?.arguments).toEqual({ path: '/y', max_bytes: 8 });
  });

  it('throws a protocol error when the stream ends mid-frame', async () => {
    const baseUrl = await start((_req, res) => {
      sse(res);
      // A partial, unterminated data frame, then a clean EOF.
      res.write('data: {"choices":[{"delta":{"content":"par');
      res.end();
    });
    await expect(
      providerFor(baseUrl).generate({ ...request, stream: true }),
    ).rejects.toBeInstanceOf(LlmProtocolError);
  });

  it('throws a protocol error on a malformed SSE data frame', async () => {
    const baseUrl = await start((_req, res) => {
      sse(res);
      res.write('data: {not json}\n\n');
      res.end();
    });
    await expect(
      providerFor(baseUrl).generate({ ...request, stream: true }),
    ).rejects.toBeInstanceOf(LlmProtocolError);
  });

  it('aborts a stream promptly via AbortSignal', async () => {
    const timers: NodeJS.Timeout[] = [];
    const baseUrl = await start((_req, res) => {
      sse(res);
      res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
      // Would keep sending, but the client aborts after the first frame.
      timers.push(
        setTimeout(() => res.write('data: {"choices":[{"delta":{"content":"second"}}]}\n\n'), 500),
      );
      res.on('error', () => undefined);
    });
    const controller = new AbortController();
    const started = Date.now();
    const run = (async () => {
      for await (const event of providerFor(baseUrl).stream({
        ...request,
        signal: controller.signal,
      })) {
        if (event.type === 'text') controller.abort();
      }
    })();
    await expect(run).rejects.toBeInstanceOf(LlmCanceledError);
    expect(Date.now() - started).toBeLessThan(500);
    for (const t of timers) clearTimeout(t);
  });
});
