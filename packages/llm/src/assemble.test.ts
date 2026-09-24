import { describe, expect, it } from 'vitest';

import { StreamAssembler, assembleStream } from './assemble.js';
import { LlmProtocolError } from './errors.js';
import type { StreamEvent } from './types.js';

async function* gen(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const e of events) yield e;
}

const ctx = { isMock: false, providerLabel: 'test' };

describe('StreamAssembler', () => {
  it('defaults usage to unknown and finish to unknown when neither is emitted', async () => {
    const result = await assembleStream(gen([{ type: 'text', text: 'hi' }]), ctx);
    expect(result.text).toBe('hi');
    expect(result.usage).toEqual({ kind: 'unknown' });
    expect(result.finishReason).toBe('unknown');
    expect(result.toolCalls).toBeUndefined();
  });

  it('infers tool_calls finish when tool calls exist but no finish arrived', async () => {
    const result = await assembleStream(
      gen([
        {
          type: 'tool_call',
          index: 0,
          id: 'a',
          name: 'file_read',
          argumentsDelta: '{"path":"/x","max_bytes":1}',
        },
      ]),
      ctx,
    );
    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCalls?.[0]?.arguments).toEqual({ path: '/x', max_bytes: 1 });
  });

  it('accumulates argument deltas at the same index without conflict', () => {
    const a = new StreamAssembler();
    a.push({ type: 'tool_call', index: 0, id: 'a', name: 'file_read', argumentsDelta: '{"p":' });
    a.push({ type: 'tool_call', index: 0, argumentsDelta: '1}' });
    const result = a.finalize(ctx);
    expect(result.toolCalls?.[0]?.argumentsRaw).toBe('{"p":1}');
  });

  it('throws on a conflicting id at an occupied index', () => {
    const a = new StreamAssembler();
    a.push({ type: 'tool_call', index: 0, id: 'a', name: 'file_read' });
    expect(() => a.push({ type: 'tool_call', index: 0, id: 'b' })).toThrow(LlmProtocolError);
  });

  it('throws on malformed JSON arguments at finalize', () => {
    const a = new StreamAssembler();
    a.push({ type: 'tool_call', index: 0, id: 'a', name: 'file_read', argumentsDelta: '{"p":' });
    expect(() => a.finalize(ctx)).toThrow(LlmProtocolError);
  });

  it('treats empty argument strings as an empty object', () => {
    const a = new StreamAssembler();
    a.push({ type: 'tool_call', index: 0, id: 'a', name: 'noop', argumentsDelta: '' });
    expect(a.finalize(ctx).toolCalls?.[0]?.arguments).toEqual({});
  });
});
