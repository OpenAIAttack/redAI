/**
 * Shared stream state machine. Both the OpenAI-compatible adapter and the mock
 * emit the same provider-neutral {@link StreamEvent} stream; this assembler folds
 * that stream into a {@link GenerateResult}. Keeping ONE assembler means malformed
 * handling — malformed tool-call JSON, duplicate/conflicting tool indices, a
 * missing finish event — is identical on both paths and tested once.
 */
import { LlmProtocolError } from './errors.js';
import type { FinishReason, GenerateResult, StreamEvent, ToolCall, Usage } from './types.js';
import { UNKNOWN_USAGE } from './types.js';

interface PartialToolCall {
  index: number;
  id: string | undefined;
  name: string | undefined;
  args: string;
}

/**
 * Accumulates {@link StreamEvent}s into the fields of a {@link GenerateResult}.
 * Call {@link push} per event and {@link finalize} once the stream ends.
 */
export class StreamAssembler {
  private text = '';
  private readonly toolCalls = new Map<number, PartialToolCall>();
  private usage: Usage = UNKNOWN_USAGE;
  private finishReason: FinishReason | undefined;

  public push(event: StreamEvent): void {
    switch (event.type) {
      case 'text':
        this.text += event.text;
        return;
      case 'usage':
        this.usage = event.usage;
        return;
      case 'finish':
        this.finishReason = event.finishReason;
        return;
      case 'tool_call':
        this.pushToolCall(event);
        return;
    }
  }

  private pushToolCall(event: Extract<StreamEvent, { type: 'tool_call' }>): void {
    const existing = this.toolCalls.get(event.index);
    if (existing === undefined) {
      this.toolCalls.set(event.index, {
        index: event.index,
        id: event.id,
        name: event.name,
        args: event.argumentsDelta ?? '',
      });
      return;
    }
    // A second event at the same index is normal (arguments streamed in pieces)
    // ONLY when it does not re-declare a *different* id or name. A conflicting id
    // at an occupied index is a malformed/duplicate-index frame — fail closed.
    if (event.id !== undefined && existing.id !== undefined && event.id !== existing.id) {
      throw new LlmProtocolError(
        `duplicate tool-call index ${event.index} with conflicting call ids`,
      );
    }
    if (event.name !== undefined && existing.name !== undefined && event.name !== existing.name) {
      throw new LlmProtocolError(
        `duplicate tool-call index ${event.index} with conflicting tool names`,
      );
    }
    if (existing.id === undefined && event.id !== undefined) existing.id = event.id;
    if (existing.name === undefined && event.name !== undefined) existing.name = event.name;
    if (event.argumentsDelta !== undefined) existing.args += event.argumentsDelta;
  }

  /** True when at least one tool call has been observed. */
  public get hasToolCalls(): boolean {
    return this.toolCalls.size > 0;
  }

  /**
   * Produce the final result. Tool-call argument strings are parsed to JSON here;
   * a non-parseable string is a protocol error (never a silent empty-args dispatch).
   * When a finish event never arrived, the reason is `unknown` (honest, not `stop`).
   */
  public finalize(context: { isMock: boolean; providerLabel: string }): GenerateResult {
    const calls: ToolCall[] = [];
    for (const partial of [...this.toolCalls.values()].sort((a, b) => a.index - b.index)) {
      if (partial.id === undefined || partial.name === undefined) {
        throw new LlmProtocolError(`tool call at index ${partial.index} is missing an id or name`);
      }
      const raw = partial.args;
      let parsed: unknown;
      try {
        parsed = raw.trim() === '' ? {} : JSON.parse(raw);
      } catch {
        // NOTE: the raw argument string is not echoed — it may carry redacted
        // tokens the caller has not yet re-hydrated. The index locates the fault.
        throw new LlmProtocolError(
          `tool call "${partial.name}" (index ${partial.index}) has malformed JSON arguments`,
        );
      }
      calls.push({
        id: partial.id,
        index: partial.index,
        name: partial.name,
        argumentsRaw: raw,
        arguments: parsed,
      });
    }

    const finishReason: FinishReason =
      this.finishReason ?? (calls.length > 0 ? 'tool_calls' : 'unknown');

    const result: GenerateResult = {
      text: this.text,
      usage: this.usage,
      finishReason,
      isMock: context.isMock,
      providerLabel: context.providerLabel,
    };
    if (calls.length > 0) result.toolCalls = calls;
    return result;
  }
}

/** Fold an async stream of events into a single {@link GenerateResult}. */
export async function assembleStream(
  events: AsyncIterable<StreamEvent>,
  context: { isMock: boolean; providerLabel: string },
): Promise<GenerateResult> {
  const assembler = new StreamAssembler();
  for await (const event of events) assembler.push(event);
  return assembler.finalize(context);
}
