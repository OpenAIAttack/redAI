import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LlmCanceledError, LlmProtocolError } from '../errors.js';
import type { GenerateRequest, Message } from '../types.js';
import { MOCK_LABEL, MockProvider, type MockProviderOptions } from './provider.js';
import { loadFixtureDir, type MockFixture } from './fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(here, '../../../../tests/fixtures/models');

const ALL = loadFixtureDir(FIXTURES_DIR);
function fixture(id: string): MockFixture {
  const f = ALL.find((x) => x.id === id);
  if (!f) throw new Error(`missing fixture ${id}`);
  return f;
}

function providerFor(id: string, overrides: Partial<MockProviderOptions> = {}): MockProvider {
  return new MockProvider({
    fixtures: [fixture(id)],
    now: () => new Date('2026-09-24T00:00:00Z'),
    ...overrides,
  });
}

const HELLO: Message[] = [{ role: 'user', content: 'say READY' }];

describe('MockProvider — labelling & determinism', () => {
  it('is clearly labelled as mock and stamps isMock on results', async () => {
    const provider = providerFor('text-simple');
    expect(provider.info.isMock).toBe(true);
    expect(provider.info.label).toBe(MOCK_LABEL);
    const result = await provider.generate({ messages: HELLO });
    expect(result.isMock).toBe(true);
    expect(result.providerLabel).toContain('MOCK');
    expect(result.text).toBe('READY');
    expect(result.finishReason).toBe('stop');
  });

  it('is deterministic across repeated calls', async () => {
    const provider = providerFor('text-simple');
    const a = await provider.generate({ messages: HELLO });
    const b = await provider.generate({ messages: HELLO });
    expect(a).toEqual({ ...b });
  });

  it('records known usage, and unknown usage when the fixture omits it', async () => {
    const known = await providerFor('text-simple').generate({ messages: HELLO });
    expect(known.usage).toEqual({
      kind: 'known',
      inputTokens: 12,
      outputTokens: 2,
      totalTokens: 14,
    });
    const unknown = await providerFor('unknown-usage').generate({ messages: HELLO });
    expect(unknown.usage).toEqual({ kind: 'unknown' });
  });
});

describe('MockProvider — tool calls', () => {
  it('assembles a valid tool call whose arguments stream across deltas', async () => {
    const provider = providerFor('tool-call-sequence');
    const result = await provider.generate({
      messages: HELLO,
      tools: [{ name: 'file_read', parameters: {} }],
    });
    expect(result.finishReason).toBe('tool_calls');
    const call = result.toolCalls?.[0];
    expect(call?.id).toBe('call_read_1');
    expect(call?.name).toBe('file_read');
    expect(call?.arguments).toEqual({ path: '/repo/README.md', max_bytes: 4096 });
  });

  it('rejects malformed tool-call JSON with a protocol error', async () => {
    const provider = providerFor('malformed-tool-json');
    await expect(provider.generate({ messages: HELLO })).rejects.toBeInstanceOf(LlmProtocolError);
  });

  it('rejects duplicate tool-call indices with conflicting ids', async () => {
    const provider = providerFor('duplicate-tool-index');
    await expect(provider.generate({ messages: HELLO })).rejects.toBeInstanceOf(LlmProtocolError);
  });
});

describe('MockProvider — streaming & cancellation', () => {
  it('streams incremental text then a finish event', async () => {
    const provider = providerFor('stream-multi', { now: () => new Date('2026-09-24T00:00:00Z') });
    const texts: string[] = [];
    let finished = false;
    for await (const event of provider.stream({ messages: HELLO })) {
      if (event.type === 'text') texts.push(event.text);
      if (event.type === 'finish') finished = true;
    }
    expect(texts.join('')).toBe('one two three four');
    expect(finished).toBe(true);
  });

  it('throws a protocol error when the scripted stream is interrupted mid-frame', async () => {
    const provider = providerFor('interrupted-stream');
    await expect(
      (async () => {
        for await (const _ of provider.stream({ messages: HELLO })) void _;
      })(),
    ).rejects.toBeInstanceOf(LlmProtocolError);
  });

  it('aborts a stream promptly via AbortSignal', async () => {
    const provider = providerFor('stream-multi');
    const controller = new AbortController();
    const started = Date.now();
    const run = (async () => {
      const seen: string[] = [];
      for await (const event of provider.stream({ messages: HELLO, signal: controller.signal })) {
        if (event.type === 'text') {
          seen.push(event.text);
          controller.abort();
        }
      }
      return seen;
    })();
    await expect(run).rejects.toBeInstanceOf(LlmCanceledError);
    // Aborted well before the fixture's total delay (4 chunks * 20ms).
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const provider = providerFor('text-simple');
    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.generate({ messages: HELLO, signal: controller.signal }),
    ).rejects.toBeInstanceOf(LlmCanceledError);
  });
});

describe('MockProvider — payload-capture canary', () => {
  it('captures the EXACT OpenAI-compatible body that would be sent', async () => {
    const captured: unknown[] = [];
    const provider = new MockProvider({
      fixtures: [fixture('text-simple')],
      model: 'probe-model',
      now: () => new Date('2026-09-24T12:00:00Z'),
      onCapture: (p) => captured.push(p.wire),
    });
    const request: GenerateRequest = {
      messages: [
        { role: 'system', content: 'platform rules' },
        { role: 'user', content: 'say READY' },
      ],
      tools: [{ name: 'file_read', description: 'read a file', parameters: { type: 'object' } }],
      dataMode: 'redacted_cloud',
      maxOutputTokens: 256,
    };
    await provider.generate(request);

    const capture = provider.lastCapture();
    expect(capture).toBeDefined();
    expect(capture?.neutral.dataMode).toBe('redacted_cloud');
    // Exact wire body assertion — the hook T14 redaction checks build on.
    expect(capture?.wire).toEqual({
      model: 'probe-model',
      messages: [
        { role: 'system', content: 'platform rules' },
        { role: 'user', content: 'say READY' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'file_read',
            description: 'read a file',
            parameters: { type: 'object' },
          },
        },
      ],
      tool_choice: 'auto',
      max_tokens: 256,
    });
    expect(captured).toHaveLength(1);
  });

  it('marks stream=true in the captured body for a streamed generation', async () => {
    const provider = providerFor('text-simple');
    await provider.generate({ messages: HELLO, stream: true });
    expect(provider.lastCapture()?.wire.stream).toBe(true);
    expect(provider.lastCapture()?.wire.stream_options).toEqual({ include_usage: true });
  });
});
