import { describe, expect, it, vi } from 'vitest';
import { probeCapabilities } from './probe.js';
import { ProviderError } from './types.js';
import type { ModelResponse } from './types.js';
const response: ModelResponse = {
  text: 'redai_probe_ok',
  refusal: null,
  toolCalls: [],
  finishReason: 'stop',
  usage: { state: 'unknown' },
};
describe('synthetic capability probe', () => {
  it('uses fixed synthetic input, validates tools, and does not invent usage', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce({
        ...response,
        text: '',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'p', name: 'redai_probe', arguments: { ok: true } }],
      })
      .mockResolvedValueOnce({ ...response, text: '{"ok":true}' });
    const stream = vi
      .fn()
      .mockResolvedValueOnce(response)
      .mockImplementationOnce(async (_request, emit) => {
        emit({ type: 'text', text: 'x' });
        throw new ProviderError('canceled', 'possibly_sent');
      });
    const result = await probeCapabilities({ complete, stream }, 'redacted_cloud', new Date(0));
    expect(result).toMatchObject({
      status: 'passed',
      supports_tools: true,
      supports_streaming: true,
      usage_observed: false,
      supports_structured_output: true,
      cancellation_observed: true,
    });
    expect(complete).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(complete.mock.calls)).toContain('synthetic');
  });
  it('never turns prose or malformed tools into supported tools', async () => {
    const complete = vi.fn().mockResolvedValue(response);
    const stream = vi.fn().mockRejectedValue(new ProviderError('timeout', 'possibly_sent'));
    expect(
      await probeCapabilities({ complete, stream }, 'redacted_cloud', new Date(0)),
    ).toMatchObject({
      status: 'failed',
      supports_tools: false,
      supports_streaming: false,
      error_code: 'invalid_response',
    });
  });
  it('sanitizes unexpected errors and stops on authentication failure', async () => {
    const complete = vi
      .fn()
      .mockRejectedValue(new ProviderError('authentication', 'possibly_sent'));
    const stream = vi.fn();
    expect(
      await probeCapabilities({ complete, stream }, 'redacted_cloud', new Date(0)),
    ).toMatchObject({ status: 'failed', error_code: 'authentication' });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(stream).not.toHaveBeenCalled();
  });
});
