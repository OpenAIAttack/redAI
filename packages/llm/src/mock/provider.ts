/**
 * Deterministic, clearly-labelled mock provider. It replays a scripted
 * {@link MockFixture} as a stream or an aggregated result WITHOUT any network, so CI
 * needs no key or payment (docs/11 §1). The label makes its mock nature explicit and
 * `isMock` is stamped on every result so a release build can refuse to ship mock
 * output silently (AGENTS "release không được âm thầm fallback về mock").
 *
 * Payload-capture canary: on every call the mock records the EXACT
 * {@link ChatCompletionsBody} an OpenAI-compatible adapter would send for the same
 * request (built by the shared {@link buildChatCompletionsBody}). Tests assert on
 * that captured payload; the T14 privacy/redaction suite hangs its assertions on the
 * same hook. The mock performs no redaction itself — it captures what it is given.
 */
import { LlmCanceledError, LlmProtocolError } from '../errors.js';
import { assembleStream } from '../assemble.js';
import { buildChatCompletionsBody, type ChatCompletionsBody } from '../wire.js';
import type {
  GenerateRequest,
  GenerateResult,
  ModelProvider,
  ProviderCapabilities,
  ProviderInfo,
  StreamEvent,
} from '../types.js';
import { fixtureEventToStreamEvent, type MockFixture } from './fixtures.js';

/** The default mock label; deliberately unmistakable in any UI or log. */
export const MOCK_LABEL = 'MOCK — scripted (not a real model)';

/** Everything the canary records for one call. */
export interface CapturedPayload {
  /** The neutral request as received (messages/tools/dataMode/stream). */
  neutral: {
    messages: GenerateRequest['messages'];
    tools: GenerateRequest['tools'];
    dataMode: GenerateRequest['dataMode'];
    stream: boolean;
  };
  /** The exact wire body an OpenAI-compatible adapter would POST. */
  wire: ChatCompletionsBody;
  capturedAt: string;
}

export interface MockProviderOptions {
  fixtures: MockFixture[];
  /** Model id echoed into the captured wire payload. */
  model?: string;
  label?: string;
  capabilities?: Partial<ProviderCapabilities>;
  /** Overrides the default deterministic clock for `capturedAt`. */
  now?: () => Date;
  /** Extra hook invoked with each capture (T14 redaction assertions attach here). */
  onCapture?: (payload: CapturedPayload) => void;
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  text: true,
  tools: true,
  streaming: true,
  structuredOutput: true,
  vision: false,
};

/** A cancellable delay that rejects promptly with {@link LlmCanceledError} on abort. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) return Promise.reject(new LlmCanceledError());
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new LlmCanceledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new LlmCanceledError());
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export class MockProvider implements ModelProvider {
  public readonly info: ProviderInfo;
  private readonly fixtures: MockFixture[];
  private readonly model: string;
  private readonly now: () => Date;
  private readonly onCapture: ((payload: CapturedPayload) => void) | undefined;
  private readonly capturesInternal: CapturedPayload[] = [];

  public constructor(options: MockProviderOptions) {
    if (options.fixtures.length === 0) {
      throw new LlmProtocolError('MockProvider requires at least one fixture');
    }
    this.fixtures = options.fixtures;
    this.model = options.model ?? 'mock-model-v1';
    this.now = options.now ?? ((): Date => new Date());
    this.onCapture = options.onCapture;
    this.info = {
      kind: 'mock',
      label: options.label ?? MOCK_LABEL,
      isMock: true,
      capabilities: { ...DEFAULT_CAPABILITIES, ...options.capabilities },
    };
  }

  /** Every captured payload, in call order. */
  public get captures(): readonly CapturedPayload[] {
    return this.capturesInternal;
  }

  /** The most recent captured payload, or `undefined` before any call. */
  public lastCapture(): CapturedPayload | undefined {
    return this.capturesInternal.at(-1);
  }

  private select(request: GenerateRequest): MockFixture {
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user');
    const hasTools = (request.tools?.length ?? 0) > 0;
    const matched = this.fixtures.find((fixture) => {
      if (!fixture.match) return false;
      if (fixture.match.hasTools !== undefined && fixture.match.hasTools !== hasTools) return false;
      if (
        fixture.match.lastUserIncludes !== undefined &&
        !(lastUser?.content ?? '').includes(fixture.match.lastUserIncludes)
      ) {
        return false;
      }
      return true;
    });
    return matched ?? this.fixtures[0]!;
  }

  private capture(request: GenerateRequest, stream: boolean): void {
    const payload: CapturedPayload = {
      neutral: {
        messages: request.messages,
        tools: request.tools,
        dataMode: request.dataMode,
        stream,
      },
      wire: buildChatCompletionsBody(request, { model: this.model, stream }),
      capturedAt: this.now().toISOString(),
    };
    this.capturesInternal.push(payload);
    this.onCapture?.(payload);
  }

  private async *replay(request: GenerateRequest): AsyncIterable<StreamEvent> {
    const fixture = this.select(request);
    for (const event of fixture.events) {
      if (request.signal?.aborted) throw new LlmCanceledError();
      await sleep(fixture.chunkDelayMs ?? 0, request.signal);
      const mapped = fixtureEventToStreamEvent(event);
      if (mapped === 'interrupt') {
        throw new LlmProtocolError('scripted stream interruption (mock)');
      }
      yield mapped;
    }
  }

  public async *stream(request: GenerateRequest): AsyncIterable<StreamEvent> {
    this.capture(request, true);
    yield* this.replay(request);
  }

  public async generate(request: GenerateRequest): Promise<GenerateResult> {
    // Capture reflects the transport the caller asked for; internally the fixture is
    // always replayed as events so aggregate and streaming semantics — including
    // malformed handling — stay identical.
    this.capture(request, request.stream ?? false);
    return assembleStream(this.replay(request), {
      isMock: true,
      providerLabel: this.info.label,
    });
  }
}
