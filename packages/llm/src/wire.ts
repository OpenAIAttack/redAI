/**
 * OpenAI-compatible Chat Completions wire mapping (docs/11 §1 — "Chat-Completions
 * compatible adapter"; contract per the official API reference [SRC12]). Pure,
 * dependency-free translation between the neutral gateway types and the wire JSON.
 *
 * This module is shared by the real adapter AND by the mock's payload-capture
 * canary, so a test can assert the EXACT request body that WOULD be sent for a
 * given context — the hook the T14 privacy/redaction checks build on. It performs
 * NO redaction of its own: the runtime redacts context before it reaches here.
 */
import { LlmProtocolError } from './errors.js';
import type {
  FinishReason,
  GenerateRequest,
  Message,
  StreamEvent,
  ToolDefinition,
  Usage,
} from './types.js';

/** The JSON body POSTed to `/v1/chat/completions`. Deterministic key order. */
export interface ChatCompletionsBody {
  model: string;
  messages: WireMessage[];
  tools?: WireTool[];
  tool_choice?: 'auto';
  stream?: boolean;
  stream_options?: { include_usage: true };
  max_tokens?: number;
}

interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
  name?: string;
}

interface WireTool {
  type: 'function';
  function: { name: string; description?: string; parameters: Record<string, unknown> };
}

function toWireMessage(message: Message): WireMessage {
  if (message.role === 'tool') {
    const wire: WireMessage = { role: 'tool', content: message.content };
    if (message.toolCallId !== undefined) wire.tool_call_id = message.toolCallId;
    if (message.name !== undefined) wire.name = message.name;
    return wire;
  }
  if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content === '' ? null : message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.argumentsRaw },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function toWireTool(tool: ToolDefinition): WireTool {
  const fn: WireTool['function'] = { name: tool.name, parameters: tool.parameters };
  if (tool.description !== undefined) fn.description = tool.description;
  return { type: 'function', function: fn };
}

/**
 * Build the exact Chat Completions request body for a generation. `stream`
 * overrides `request.stream` (the adapter's streaming path sets it true and adds
 * `stream_options.include_usage` so usage still arrives on the final SSE frame).
 */
export function buildChatCompletionsBody(
  request: GenerateRequest,
  options: { model: string; stream: boolean },
): ChatCompletionsBody {
  const body: ChatCompletionsBody = {
    model: options.model,
    messages: request.messages.map(toWireMessage),
  };
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map(toWireTool);
    body.tool_choice = 'auto';
  }
  if (options.stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens;
  return body;
}

function mapFinishReason(raw: unknown): FinishReason | undefined {
  switch (raw) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'content_filter':
      return 'content_filter';
    case null:
    case undefined:
      return undefined;
    default:
      return 'unknown';
  }
}

function mapUsage(raw: unknown): Usage | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const input = u['prompt_tokens'];
  const output = u['completion_tokens'];
  const total = u['total_tokens'];
  if (typeof input !== 'number' || typeof output !== 'number') return undefined;
  return {
    kind: 'known',
    inputTokens: input,
    outputTokens: output,
    totalTokens: typeof total === 'number' ? total : input + output,
  };
}

function asObject(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    throw new LlmProtocolError(`expected an object for ${context}`);
  }
  return value as Record<string, unknown>;
}

/**
 * Map a *non-streaming* Chat Completions response body to gateway events. Feeding
 * the shared assembler keeps result construction identical to the streaming path.
 */
export function chatCompletionToEvents(body: unknown): StreamEvent[] {
  const root = asObject(body, 'chat completion response');
  const events: StreamEvent[] = [];

  const choices = root['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new LlmProtocolError('chat completion response has no choices');
  }
  const choice = asObject(choices[0], 'choice');
  const message = asObject(choice['message'], 'choice.message');

  const content = message['content'];
  if (typeof content === 'string' && content.length > 0) {
    events.push({ type: 'text', text: content });
  }

  const toolCalls = message['tool_calls'];
  if (Array.isArray(toolCalls)) {
    toolCalls.forEach((rawCall, i) => {
      const call = asObject(rawCall, 'tool_call');
      const fn = asObject(call['function'], 'tool_call.function');
      const index = typeof call['index'] === 'number' ? (call['index'] as number) : i;
      const event: Extract<StreamEvent, { type: 'tool_call' }> = { type: 'tool_call', index };
      if (typeof call['id'] === 'string') event.id = call['id'];
      if (typeof fn['name'] === 'string') event.name = fn['name'];
      if (typeof fn['arguments'] === 'string') event.argumentsDelta = fn['arguments'];
      events.push(event);
    });
  }

  const usage = mapUsage(root['usage']);
  if (usage) events.push({ type: 'usage', usage });

  const finishReason = mapFinishReason(choice['finish_reason']);
  events.push({ type: 'finish', finishReason: finishReason ?? 'stop' });
  return events;
}

/**
 * Map a single streaming Chat Completions chunk (the JSON after `data: `) to zero
 * or more gateway events. A `[DONE]` sentinel is handled by the caller.
 */
export function streamChunkToEvents(chunk: unknown): StreamEvent[] {
  const root = asObject(chunk, 'stream chunk');
  const events: StreamEvent[] = [];

  const choices = root['choices'];
  if (Array.isArray(choices) && choices.length > 0) {
    const choice = asObject(choices[0], 'stream choice');
    const delta = choice['delta'];
    if (delta !== null && typeof delta === 'object') {
      const d = delta as Record<string, unknown>;
      if (typeof d['content'] === 'string' && d['content'].length > 0) {
        events.push({ type: 'text', text: d['content'] });
      }
      const toolCalls = d['tool_calls'];
      if (Array.isArray(toolCalls)) {
        for (const rawCall of toolCalls) {
          const call = asObject(rawCall, 'stream tool_call');
          if (typeof call['index'] !== 'number') {
            throw new LlmProtocolError('streaming tool_call is missing its index');
          }
          const event: Extract<StreamEvent, { type: 'tool_call' }> = {
            type: 'tool_call',
            index: call['index'] as number,
          };
          if (typeof call['id'] === 'string') event.id = call['id'];
          const fn = call['function'];
          if (fn !== null && typeof fn === 'object') {
            const f = fn as Record<string, unknown>;
            if (typeof f['name'] === 'string') event.name = f['name'];
            if (typeof f['arguments'] === 'string') event.argumentsDelta = f['arguments'];
          }
          events.push(event);
        }
      }
    }
    const finishReason = mapFinishReason(choice['finish_reason']);
    if (finishReason !== undefined) events.push({ type: 'finish', finishReason });
  }

  const usage = mapUsage(root['usage']);
  if (usage) events.push({ type: 'usage', usage });
  return events;
}
