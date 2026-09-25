import { parseResponse, record } from './response.js';
import { ProviderError, type ModelRequest, type ModelResponse, type ModelDelta } from './types.js';

function invalid(): never {
  throw new ProviderError('invalid_response', 'possibly_sent');
}

/** Incremental parser; caller bounds total wire bytes before feeding it.
 * Only text/refusal are provisional. Tools are exposed after terminal validation.
 */
export class CompletionStream {
  #pending = '';
  #data: string[] = [];
  #text = '';
  #refusal = '';
  #finish: string | null = null;
  #done = false;
  #usage: unknown;
  #calls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] = [];

  constructor(
    private readonly request: ModelRequest,
    private readonly emit: (delta: ModelDelta) => void,
  ) {}

  get done(): boolean {
    return this.#done;
  }

  feed(text: string): void {
    this.#pending += text;
    while (true) {
      const match = /[\r\n]/.exec(this.#pending);
      if (!match) return;
      const at = match.index;
      // Retain terminal CR until we know whether the next byte is LF.
      if (this.#pending[at] === '\r' && at === this.#pending.length - 1) return;
      const line = this.#pending.slice(0, at);
      const width = this.#pending.slice(at, at + 2) === '\r\n' ? 2 : 1;
      this.#pending = this.#pending.slice(at + width);
      if (line === '') {
        if (this.#data.length) this.#event(this.#data.join('\n'));
        this.#data = [];
      } else if (line.startsWith('data:')) {
        const value = line.slice(5);
        this.#data.push(value.startsWith(' ') ? value.slice(1) : value);
      } else if (line === 'data') this.#data.push('');
    }
  }

  #event(data: string): void {
    if (this.#done) invalid();
    if (data === '[DONE]') {
      if (this.#finish === null) invalid();
      this.#done = true;
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      invalid();
    }
    if (!record(raw) || !Array.isArray(raw.choices)) invalid();
    if (raw.usage != null) {
      if (this.#usage !== undefined) invalid();
      this.#usage = raw.usage;
    }
    if (raw.choices.length === 0) {
      if (this.#finish === null || raw.usage == null) invalid();
      return;
    }
    if (raw.choices.length !== 1 || this.#finish !== null) invalid();
    const choice: unknown = raw.choices[0];
    if (!record(choice) || choice.index !== 0 || !record(choice.delta)) invalid();
    const delta = choice.delta;
    if (delta.role !== undefined && delta.role !== 'assistant') invalid();
    for (const field of ['content', 'refusal'] as const) {
      const value = delta[field];
      if (value == null) continue;
      if (typeof value !== 'string') invalid();
      if (field === 'content') this.#text += value;
      else this.#refusal += value;
      if (value) this.emit({ type: field === 'content' ? 'text' : 'refusal', text: value });
    }
    if (delta.tool_calls != null) {
      if (!Array.isArray(delta.tool_calls)) invalid();
      const indices = new Set<number>();
      for (const part of delta.tool_calls as unknown[]) {
        if (
          !record(part) ||
          typeof part.index !== 'number' ||
          !Number.isSafeInteger(part.index) ||
          part.index < 0 ||
          indices.has(part.index) ||
          !record(part.function)
        )
          invalid();
        indices.add(part.index);
        const fn = part.function;
        const existing = this.#calls[part.index];
        if (!existing) {
          if (
            part.index !== this.#calls.length ||
            part.type !== 'function' ||
            typeof part.id !== 'string' ||
            !part.id ||
            typeof fn.name !== 'string' ||
            !fn.name
          )
            invalid();
          this.#calls.push({
            id: part.id,
            type: 'function',
            function: { name: fn.name, arguments: '' },
          });
        } else if (part.id !== undefined || part.type !== undefined || fn.name !== undefined) {
          // Identity may only be declared once; repeated index fragments carry arguments.
          invalid();
        }
        if (fn.arguments !== undefined) {
          if (typeof fn.arguments !== 'string') invalid();
          this.#calls[part.index]!.function.arguments += fn.arguments;
        }
      }
    }
    if (choice.finish_reason != null) {
      if (
        !['stop', 'tool_calls', 'length', 'content_filter'].includes(String(choice.finish_reason))
      )
        invalid();
      this.#finish = String(choice.finish_reason);
    }
  }

  result(): ModelResponse {
    if (!this.#done || this.#data.length || this.#pending.trim()) invalid();
    return parseResponse(
      {
        choices: [
          {
            index: 0,
            finish_reason: this.#finish,
            message: {
              role: 'assistant',
              content: this.#text,
              refusal: this.#refusal || null,
              ...(this.#calls.length ? { tool_calls: this.#calls } : {}),
            },
          },
        ],
        usage: this.#usage,
      },
      this.request,
    );
  }
}
