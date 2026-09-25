import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CompatibleAdapter,
  type CompatibleConfig,
  type ModelRequest,
  ProviderError,
  ScriptedMockAdapter,
} from './index.js';

const config: CompatibleConfig = {
  baseUrl: 'https://model.example/v1',
  modelId: 'configured-model',
  apiKey: 'KEY_CANARY',
  allowedDataModes: ['redacted_cloud', 'local_only'],
  approvedLocalBaseUrls: [],
  toolsVerified: true,
  maxOutputTokens: 128,
  timeoutMs: 500,
  maxResponseBytes: 4096,
};
const request: ModelRequest = {
  messages: [{ role: 'user', content: 'synthetic' }],
  maxOutputTokens: 32,
  dataMode: 'redacted_cloud',
};
const tool = {
  name: 'synthetic',
  description: 'Does not execute',
  parameters: { type: 'object' },
  validateArguments: (v: unknown) =>
    typeof v === 'object' && v !== null && 'ok' in v && v.ok === true,
};
function response(
  message: Record<string, unknown> = { content: 'hello' },
  finish = 'stop',
  usage: unknown = { prompt_tokens: 3, completion_tokens: 2 },
) {
  return {
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }],
    usage,
  };
}
function call(args = '{"ok":true}', name = 'synthetic', id = 'call-1') {
  return { type: 'function', id, function: { name, arguments: args } };
}
function fixture(value: unknown) {
  return vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(value)));
}
afterEach(() => vi.restoreAllMocks());

describe('compatible adapter', () => {
  it('projects payload fields, uses one pinned endpoint and observes usage', async () => {
    const transport = fixture(response());
    const adapter = new CompatibleAdapter(config, transport);
    const result = await adapter.complete({
      ...request,
      secret: 'METADATA_CANARY',
    } as ModelRequest);
    expect(result).toMatchObject({
      text: 'hello',
      toolCalls: [],
      usage: { state: 'observed', inputTokens: 3, outputTokens: 2 },
    });
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe('https://model.example/v1/chat/completions');
    expect(init?.redirect).toBe('error');
    expect(init?.body).not.toContain('CANARY');
    expect(init?.headers).toMatchObject({ authorization: 'Bearer KEY_CANARY' });
  });
  it.each([
    null,
    {},
    { prompt_tokens: -1, completion_tokens: 2 },
    { prompt_tokens: 1.5, completion_tokens: 2 },
  ])('keeps absent or invalid usage unknown: %j', async (usage) => {
    expect(
      (
        await new CompatibleAdapter(config, fixture(response(undefined, 'stop', usage))).complete(
          request,
        )
      ).usage,
    ).toEqual({ state: 'unknown' });
  });
  it('does not confuse zero observed usage with unknown', async () => {
    const result = await new CompatibleAdapter(
      config,
      fixture(response(undefined, 'stop', { prompt_tokens: 0, completion_tokens: 0 })),
    ).complete(request);
    expect(result.usage.state).toBe('observed');
  });
  it('accepts only declared schema-valid tool arguments', async () => {
    const result = await new CompatibleAdapter(
      config,
      fixture(response({ content: null, tool_calls: [call()] }, 'tool_calls')),
    ).complete({ ...request, tools: [tool] });
    expect(result.toolCalls).toEqual([
      { id: 'call-1', name: 'synthetic', arguments: { ok: true } },
    ]);
  });
  it.each([
    [call('{')],
    [call('[]')],
    [call('{"ok":false}')],
    [call('{}', 'undeclared')],
    [call(), call()],
  ])('rejects malformed, wrong-schema, undeclared or duplicate calls: %j', async (...calls) => {
    await expect(
      new CompatibleAdapter(
        config,
        fixture(response({ content: null, tool_calls: calls }, 'tool_calls')),
      ).complete({ ...request, tools: [tool] }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it.each(['length', 'stop', 'content_filter'])(
    'never exposes tool calls with finish %s',
    async (finish) => {
      await expect(
        new CompatibleAdapter(
          config,
          fixture(response({ content: null, tool_calls: [call()] }, finish)),
        ).complete({ ...request, tools: [tool] }),
      ).rejects.toMatchObject({ code: 'invalid_response' });
    },
  );
  it('does not parse prose as tools and preserves refusal', async () => {
    const result = await new CompatibleAdapter(
      config,
      fixture(response({ content: '{"tool":"synthetic"}', refusal: 'declined' })),
    ).complete(request);
    expect(result.toolCalls).toEqual([]);
    expect(result.refusal).toBe('declined');
  });
  it('rejects duplicate choice indices', async () => {
    const value = response();
    value.choices.push(value.choices[0]!);
    await expect(
      new CompatibleAdapter(config, fixture(value)).complete(request),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('rejects Agent tools before send when capability is unverified', async () => {
    const transport = fixture(response());
    await expect(
      new CompatibleAdapter({ ...config, toolsVerified: false }, transport).complete({
        ...request,
        tools: [tool],
      }),
    ).rejects.toMatchObject({ code: 'unsupported_capability', requestState: 'not_sent' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('fails local_only closed without fallback; config snapshot cannot be mutated', async () => {
    const mutable = { ...config, allowedDataModes: [...config.allowedDataModes] };
    const transport = fixture(response());
    const adapter = new CompatibleAdapter(mutable, transport);
    mutable.approvedLocalBaseUrls = [config.baseUrl];
    await expect(adapter.complete({ ...request, dataMode: 'local_only' })).rejects.toMatchObject({
      code: 'policy_denied',
      requestState: 'not_sent',
    });
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([
    'https://user:pass@model.example',
    'https://model.example?key=secret',
    'file:///tmp/model',
    'http://cloud.example/v1',
  ])('rejects unsafe base URL %s', (baseUrl) => {
    expect(() => new CompatibleAdapter({ ...config, baseUrl })).toThrow(ProviderError);
  });
  it.each([401, 403, 429, 500])(
    'maps HTTP %s with no retry or raw error leakage',
    async (status) => {
      const transport = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('BODY_CANARY', { status }));
      const error = await new CompatibleAdapter(config, transport)
        .complete(request)
        .catch((e: unknown) => e);
      expect(error).toMatchObject({
        code:
          status === 429 ? 'rate_limited' : status === 500 ? 'provider_error' : 'authentication',
        usage: { state: 'unknown' },
        requestState: 'possibly_sent',
      });
      expect(JSON.stringify(error)).not.toContain('CANARY');
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it('bounds response bytes', async () => {
    await expect(
      new CompatibleAdapter({ ...config, maxResponseBytes: 10 }, fixture(response())).complete(
        request,
      ),
    ).rejects.toMatchObject({ code: 'response_too_large' });
  });
  it('maps malformed JSON and interrupted bodies without leaking provider text', async () => {
    const broken = vi.fn<typeof fetch>().mockResolvedValue(new Response('CANARY{'));
    await expect(new CompatibleAdapter(config, broken).complete(request)).rejects.toMatchObject({
      code: 'invalid_response',
    });
    const interrupted = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            c.error(new Error('CANARY'));
          },
        }),
      ),
    );
    await expect(
      new CompatibleAdapter(config, interrupted).complete(request),
    ).rejects.toMatchObject({ code: 'network_error' });
  });
  it('does not send a pre-canceled request', async () => {
    const transport = fixture(response());
    await expect(
      new CompatibleAdapter(config, transport).complete(request, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: 'canceled', requestState: 'not_sent' });
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(['timeout', 'canceled'] as const)('aborts an in-flight request: %s', async (code) => {
    const controller = new AbortController();
    const transport = vi.fn<typeof fetch>().mockImplementation(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('TRANSPORT_CANARY')), {
            once: true,
          });
          if (code === 'canceled') controller.abort();
        }),
    );
    await expect(
      new CompatibleAdapter({ ...config, timeoutMs: 10 }, transport).complete(
        request,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code, usage: { state: 'unknown' }, requestState: 'possibly_sent' });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('keeps tool declarations fixed while awaiting the response', async () => {
    const mutable = { ...tool };
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => {
      mutable.name = 'injected';
      return new Response(
        JSON.stringify(
          response({ content: null, tool_calls: [call('{}', 'injected')] }, 'tool_calls'),
        ),
      );
    });
    await expect(
      new CompatibleAdapter(config, transport).complete({ ...request, tools: [mutable] }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('rejects output limits before network activity', async () => {
    const transport = fixture(response());
    await expect(
      new CompatibleAdapter(config, transport).complete({ ...request, maxOutputTokens: 129 }),
    ).rejects.toMatchObject({ code: 'invalid_request', requestState: 'not_sent' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('uses a real synthetic HTTP endpoint and blocks redirects', async () => {
    let count = 0;
    const server = createServer((req, res) => {
      count++;
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response()));
      } else if (req.url === '/stall/chat/completions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{');
      } else {
        res.writeHead(302, { location: '/v1/chat/completions' });
        res.end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing listener');
      const baseUrl = `http://127.0.0.1:${address.port}/v1`;
      const local = { ...config, baseUrl, approvedLocalBaseUrls: [baseUrl], timeoutMs: 2000 };
      expect(
        (await new CompatibleAdapter(local).complete({ ...request, dataMode: 'local_only' })).text,
      ).toBe('hello');
      const redirectBase = baseUrl.replace('/v1', '/redirect');
      await expect(
        new CompatibleAdapter({
          ...local,
          baseUrl: redirectBase,
          approvedLocalBaseUrls: [redirectBase],
        }).complete(request),
      ).rejects.toMatchObject({ code: 'network_error' });
      const stallBase = baseUrl.replace('/v1', '/stall');
      await expect(
        new CompatibleAdapter({
          ...local,
          baseUrl: stallBase,
          approvedLocalBaseUrls: [stallBase],
          timeoutMs: 50,
        }).complete(request),
      ).rejects.toMatchObject({ code: 'timeout', usage: { state: 'unknown' } });
      expect(count).toBe(3);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

describe('scripted mock', () => {
  it('captures a detached payload and has no fallback when the script is exhausted', async () => {
    const mock = new ScriptedMockAdapter('test', [response()]);
    expect(mock.label).toContain('MOCK');
    await mock.complete(request);
    expect(mock.captured).toEqual([{ messages: request.messages, dataMode: request.dataMode }]);
    expect(mock.captured[0]!.messages).not.toBe(request.messages);
    await expect(mock.complete(request)).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it('rejects production profile even when called without TypeScript', () => {
    expect(() => new ScriptedMockAdapter('production' as 'test', [])).toThrow(ProviderError);
  });
});
