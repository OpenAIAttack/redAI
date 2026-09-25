import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { CompatibleAdapter, type CompatibleConfig, type ModelRequest } from './index.js';

const config: CompatibleConfig = {
  baseUrl: 'https://model.example/v1',
  modelId: 'synthetic',
  allowedDataModes: ['redacted_cloud'],
  approvedLocalBaseUrls: [],
  toolsVerified: true,
  maxOutputTokens: 128,
  timeoutMs: 500,
  maxResponseBytes: 8192,
};
const request: ModelRequest = {
  messages: [{ role: 'user', content: 'synthetic' }],
  maxOutputTokens: 32,
  dataMode: 'redacted_cloud',
  tools: [
    {
      name: 'check',
      description: 'synthetic',
      parameters: { type: 'object' },
      validateArguments: (v) => JSON.stringify(v) === '{"ok":true}',
    },
  ],
};
const event = (delta: unknown, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const end = event({}, 'stop') + 'data: [DONE]\n\n';
function fixture(wire: string, options: Partial<CompatibleConfig> = {}, fragment = false) {
  const bytes = new TextEncoder().encode(wire);
  const transport = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      new ReadableStream({
        start(c) {
          if (fragment) for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
          else c.enqueue(bytes);
          c.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    ),
  );
  return { adapter: new CompatibleAdapter({ ...config, ...options }, transport), transport };
}
describe('compatible SSE', () => {
  it('decodes fragmented UTF-8/CRLF and observes trailing usage before DONE', async () => {
    const wire =
      ': heartbeat\n\n' +
      event({ role: 'assistant', content: 'Chào' }) +
      event({}, 'stop') +
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n' +
      'data: [DONE]\n\n';
    const { adapter, transport } = fixture(wire.replaceAll('\n', '\r\n'), {}, true);
    const delta = vi.fn();
    expect(await adapter.stream(request, delta)).toMatchObject({
      text: 'Chào',
      usage: { state: 'observed', inputTokens: 3, outputTokens: 2 },
    });
    expect(delta).toHaveBeenCalledWith({ type: 'text', text: 'Chào' });
    expect(JSON.parse(String(transport.mock.calls[0]![1]!.body))).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
  });
  it('assembles tool arguments but emits no tool fragments for execution', async () => {
    const wire =
      event({
        tool_calls: [
          {
            index: 0,
            id: 'c1',
            type: 'function',
            function: { name: 'check', arguments: '{"ok":' },
          },
        ],
      }) +
      event({ tool_calls: [{ index: 0, function: { arguments: 'true}' } }] }, 'tool_calls') +
      'data: [DONE]\n\n';
    const delta = vi.fn();
    expect(await fixture(wire).adapter.stream(request, delta)).toMatchObject({
      toolCalls: [{ id: 'c1', name: 'check', arguments: { ok: true } }],
      usage: { state: 'unknown' },
    });
    expect(delta).not.toHaveBeenCalled();
  });
  it.each([
    event({ content: 'partial' }),
    event({}, 'stop'),
    'data: [DONE]\n\n',
    'data: {bad}\n\n' + end,
    event({ content: 'a' }, 'stop') + event({ content: 'after finish' }) + 'data: [DONE]\n\n',
    event({ role: 'system' }) + end,
    event({
      tool_calls: [
        { index: 1, id: 'c', type: 'function', function: { name: 'check', arguments: '{}' } },
      ],
    }) + end,
    event({
      tool_calls: [
        { index: 0, id: 'c', type: 'function', function: { name: 'check', arguments: '' } },
        { index: 0, function: { arguments: '{}' } },
      ],
    }) + end,
    event({
      tool_calls: [
        { index: 0, id: 'c', type: 'function', function: { name: 'check', arguments: '{}' } },
      ],
    }) +
      event(
        { tool_calls: [{ index: 0, id: 'replacement', function: { arguments: '' } }] },
        'tool_calls',
      ) +
      'data: [DONE]\n\n',
    event(
      {
        tool_calls: [
          {
            index: 0,
            id: 'c',
            type: 'function',
            function: { name: 'check', arguments: '{"ok":false}' },
          },
        ],
      },
      'tool_calls',
    ) + 'data: [DONE]\n\n',
  ])('rejects malformed/truncated or ambiguous streams %#', async (wire) => {
    await expect(fixture(wire).adapter.stream(request, () => {})).rejects.toMatchObject({
      code: 'invalid_response',
      usage: { state: 'unknown' },
    });
  });
  it('bounds total bytes including comments', async () => {
    await expect(
      fixture(': ' + 'x'.repeat(100) + '\n\n' + end, { maxResponseBytes: 32 }).adapter.stream(
        request,
        () => {},
      ),
    ).rejects.toMatchObject({ code: 'response_too_large' });
  });
  it('rejects cancellation before sending', async () => {
    const { adapter, transport } = fixture(end);
    await expect(adapter.stream(request, () => {}, AbortSignal.abort())).rejects.toMatchObject({
      code: 'canceled',
      requestState: 'not_sent',
    });
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('stream transport lifecycle', () => {
  it.each(['timeout', 'canceled'] as const)('aborts a stalled body: %s', async (code) => {
    let canceled = false;
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(event({ content: 'partial' })));
          },
          cancel() {
            canceled = true;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    const controller = new AbortController();
    const adapter = new CompatibleAdapter({ ...config, timeoutMs: 30 }, transport);
    const result = adapter.stream(
      request,
      () => {
        if (code === 'canceled') controller.abort();
      },
      controller.signal,
    );
    await expect(result).rejects.toMatchObject({
      code,
      requestState: 'possibly_sent',
      usage: { state: 'unknown' },
    });
    expect(canceled).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('maps interrupted transport without retry or partial success', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream({
          pull(c) {
            c.error(new Error('PRIVATE_PROVIDER_DETAIL'));
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    await expect(
      new CompatibleAdapter(config, transport).stream(request, () => {}),
    ).rejects.toMatchObject({
      code: 'network_error',
      message: 'Model request failed: network_error',
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid UTF-8', async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(new Uint8Array([255]), { headers: { 'content-type': 'text/event-stream' } }),
      );
    await expect(
      new CompatibleAdapter(config, transport).stream(request, () => {}),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('terminates at DONE without waiting for a real HTTP socket to close', async () => {
    let hits = 0;
    const server = createServer((_req, res) => {
      hits++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(event({ content: 'synthetic' }) + end);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    try {
      const adapter = new CompatibleAdapter({
        ...config,
        baseUrl,
        approvedLocalBaseUrls: [baseUrl],
      });
      expect(await adapter.stream(request, () => {})).toMatchObject({
        text: 'synthetic',
        finishReason: 'stop',
      });
      expect(hits).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
