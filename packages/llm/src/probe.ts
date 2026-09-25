import {
  ProviderError,
  type DataMode,
  type ModelAdapter,
  type ModelDelta,
  type ModelRequest,
} from './types.js';

export interface ProbeAdapter extends ModelAdapter {
  stream(
    request: ModelRequest,
    emit: (delta: ModelDelta) => void,
    signal?: AbortSignal,
  ): ReturnType<ModelAdapter['complete']>;
}
export interface ProbeResult {
  status: 'passed' | 'failed';
  supports_tools: boolean;
  supports_streaming: boolean;
  supports_structured_output: boolean;
  usage_observed: boolean;
  cancellation_observed: boolean;
  error_code: string | null;
  checked_at: string;
}

/** Fixed synthetic payloads only. No Project context or executable tool dispatch. */
export async function probeCapabilities(
  adapter: ProbeAdapter,
  dataMode: DataMode,
  now: Date,
  maxTokens = 64,
): Promise<ProbeResult> {
  const result: ProbeResult = {
    status: 'failed',
    supports_tools: false,
    supports_streaming: false,
    supports_structured_output: false,
    usage_observed: false,
    cancellation_observed: false,
    error_code: null,
    checked_at: now.toISOString(),
  };
  const request: ModelRequest = {
    messages: [
      {
        role: 'user',
        content: 'This is a synthetic redAI capability probe. Reply exactly redai_probe_ok.',
      },
    ],
    maxOutputTokens: Math.min(64, maxTokens),
    dataMode,
  };
  const fail = (error: unknown) => {
    result.error_code ??= error instanceof ProviderError ? error.code : 'provider_error';
  };
  try {
    const text = await adapter.complete(request);
    if (text.text.trim() !== 'redai_probe_ok' || text.refusal || text.finishReason !== 'stop')
      throw new ProviderError('invalid_response', 'possibly_sent');
    result.usage_observed ||= text.usage.state === 'observed';
  } catch (error) {
    fail(error);
    return result;
  }
  try {
    const tool = await adapter.complete({
      ...request,
      messages: [
        {
          role: 'user',
          content:
            'Synthetic redAI probe: call redai_probe exactly once with {"ok":true}. Do not execute anything.',
        },
      ],
      tools: [
        {
          name: 'redai_probe',
          description: 'Synthetic capability check; never executed.',
          parameters: {
            type: 'object',
            properties: { ok: { type: 'boolean', const: true } },
            required: ['ok'],
            additionalProperties: false,
          },
          validateArguments: (value) =>
            typeof value === 'object' &&
            value !== null &&
            !Array.isArray(value) &&
            Object.keys(value).length === 1 &&
            'ok' in value &&
            value.ok === true,
        },
      ],
    });
    if (
      tool.finishReason !== 'tool_calls' ||
      tool.toolCalls.length !== 1 ||
      tool.toolCalls[0]?.name !== 'redai_probe' ||
      JSON.stringify(tool.toolCalls[0].arguments) !== '{"ok":true}'
    )
      throw new ProviderError('invalid_response', 'possibly_sent');
    result.supports_tools = true;
    result.usage_observed ||= tool.usage.state === 'observed';
  } catch (error) {
    fail(error);
  }
  try {
    const streamed = await adapter.stream(request, () => {});
    if (
      streamed.text.trim() !== 'redai_probe_ok' ||
      streamed.refusal ||
      streamed.finishReason !== 'stop'
    )
      throw new ProviderError('invalid_response', 'possibly_sent');
    result.supports_streaming = true;
    result.usage_observed ||= streamed.usage.state === 'observed';
  } catch (error) {
    fail(error);
  }
  try {
    const structured = await adapter.complete({
      ...request,
      messages: [{ role: 'user', content: 'Synthetic redAI probe: return JSON with ok true.' }],
      structuredOutput: {
        name: 'redai_probe',
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean', const: true } },
          required: ['ok'],
          additionalProperties: false,
        },
        validate: (value) => JSON.stringify(value) === '{"ok":true}',
      },
    });
    if (
      structured.finishReason !== 'stop' ||
      structured.refusal ||
      JSON.stringify(JSON.parse(structured.text)) !== '{"ok":true}'
    )
      throw new ProviderError('invalid_response', 'possibly_sent');
    result.supports_structured_output = true;
    result.usage_observed ||= structured.usage.state === 'observed';
  } catch (error) {
    fail(error);
  }
  const controller = new AbortController();
  try {
    await adapter.stream(request, () => controller.abort(), controller.signal);
    fail(new ProviderError('unsupported_capability', 'possibly_sent'));
  } catch (error) {
    if (controller.signal.aborted && error instanceof ProviderError && error.code === 'canceled')
      result.cancellation_observed = true;
    else fail(error);
  }
  // Cancellation observes the client transport, not remote compute/billing termination.
  result.status = result.error_code === null ? 'passed' : 'failed';
  return result;
}
