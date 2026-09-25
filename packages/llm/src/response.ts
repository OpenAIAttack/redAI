import { ProviderError, type ModelRequest, type ModelResponse, type Usage } from './types.js';

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function invalid(): never {
  throw new ProviderError('invalid_response', 'possibly_sent');
}
function tokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Tool text is never executable. Only explicitly declared, schema-valid calls survive. */
export function parseResponse(value: unknown, request: ModelRequest): ModelResponse {
  if (!record(value) || !Array.isArray(value.choices) || value.choices.length !== 1) invalid();
  const choice: unknown = value.choices[0];
  if (!record(choice) || choice.index !== 0 || !record(choice.message)) invalid();
  const message = choice.message;
  if (message.role !== 'assistant') invalid();
  if (message.content !== null && typeof message.content !== 'string') invalid();
  if (message.refusal != null && typeof message.refusal !== 'string') invalid();
  const finish = choice.finish_reason;
  if (
    finish !== 'stop' &&
    finish !== 'tool_calls' &&
    finish !== 'length' &&
    finish !== 'content_filter'
  )
    invalid();
  const calls: ModelResponse['toolCalls'] = [];
  const ids = new Set<string>();
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls)) invalid();
    for (const raw of message.tool_calls as unknown[]) {
      if (
        !record(raw) ||
        raw.type !== 'function' ||
        typeof raw.id !== 'string' ||
        !raw.id ||
        ids.has(raw.id) ||
        !record(raw.function)
      )
        invalid();
      const fn = raw.function;
      if (typeof fn.name !== 'string' || typeof fn.arguments !== 'string') invalid();
      const tool = request.tools?.find((candidate) => candidate.name === fn.name);
      if (!tool) invalid();
      let args: unknown;
      try {
        args = JSON.parse(fn.arguments);
        if (!record(args) || !tool.validateArguments(args)) invalid();
      } catch {
        invalid();
      }
      ids.add(raw.id);
      calls.push({ id: raw.id, name: fn.name, arguments: args });
    }
  }
  if (calls.length > 0 !== (finish === 'tool_calls')) invalid();
  if (message.refusal && calls.length > 0) invalid();
  if (request.structuredOutput && !message.refusal) {
    try {
      if (
        finish !== 'stop' ||
        typeof message.content !== 'string' ||
        !request.structuredOutput.validate(JSON.parse(message.content))
      )
        invalid();
    } catch {
      invalid();
    }
  }
  let usage: Usage = { state: 'unknown' };
  if (
    record(value.usage) &&
    tokenCount(value.usage.prompt_tokens) &&
    tokenCount(value.usage.completion_tokens)
  ) {
    usage = {
      state: 'observed',
      inputTokens: value.usage.prompt_tokens,
      outputTokens: value.usage.completion_tokens,
    };
  }
  return {
    text: message.content ?? '',
    refusal: message.refusal ?? null,
    toolCalls: calls,
    finishReason: finish,
    usage,
  };
}
