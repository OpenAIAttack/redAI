import { parseResponse } from './response.js';
import {
  ProviderError,
  type ModelAdapter,
  type ModelRequest,
  type ModelResponse,
} from './types.js';

/** Explicit test/development adapter. Never selected as an automatic fallback. */
export class ScriptedMockAdapter implements ModelAdapter {
  readonly label = 'MOCK — scripted, no model inference';
  readonly captured: { messages: ModelRequest['messages']; dataMode: ModelRequest['dataMode'] }[] =
    [];
  readonly #script: unknown[];
  constructor(profile: 'test' | 'development', responses: readonly unknown[]) {
    if (profile !== 'test' && profile !== 'development')
      throw new ProviderError('policy_denied', 'not_sent');
    this.#script = structuredClone([...responses]);
  }
  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    if (signal?.aborted) throw new ProviderError('canceled', 'not_sent');
    if (!this.#script.length) throw new ProviderError('invalid_request', 'not_sent');
    this.captured.push(structuredClone({ messages: request.messages, dataMode: request.dataMode }));
    return parseResponse(this.#script.shift(), request);
  }
}
