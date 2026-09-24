/**
 * Capability probe (docs/11 §2). When the owner saves a provider config, an optional
 * probe exercises the endpoint with SYNTHETIC data only — never a real target or any
 * Project content — to learn what it can actually do: text, streaming termination, a
 * typed tool call, structured JSON, cancellation, and usage metadata. It records
 * capability flags + timestamps + explicit parse errors; it never executes a real
 * tool.
 *
 * Two hard rules from the spec are enforced here:
 *  - The probe is OWNER-ONLY (endpoint routing is owner-configured, docs/11 §1).
 *  - A provider that fails the tool check must NOT be used to run an Agent by parsing
 *    tools out of prose — {@link ensureAgentCapable} rejects that (docs/11 §2).
 */
import { LlmCanceledError, LlmCapabilityError, LlmConfigError, isLlmError } from './errors.js';
import type {
  GenerateRequest,
  Message,
  ModelProvider,
  ProviderCapabilities,
  ToolDefinition,
} from './types.js';

/** Fixed synthetic conversation — contains NO Project data (docs/11 §1). */
export const SYNTHETIC_PROBE_MESSAGES: readonly Message[] = Object.freeze([
  {
    role: 'system',
    content: 'You are a capability probe. Respond exactly as asked with no extra text.',
  },
  { role: 'user', content: 'Reply with the single word: READY' },
]);

/** Synthetic tool used to test typed tool-calling. Its schema mirrors a trivial echo. */
export const SYNTHETIC_PROBE_TOOL: ToolDefinition = Object.freeze({
  name: 'redai_probe_echo',
  description: 'Echo the provided marker back. Used only for capability probing.',
  parameters: {
    type: 'object',
    properties: { marker: { type: 'string', minLength: 1, maxLength: 64 } },
    required: ['marker'],
    additionalProperties: false,
  },
});

export interface CapabilityProbeResult {
  probedAt: string;
  capabilities: ProviderCapabilities;
  /** True when at least one probed call reported known token usage. */
  usageReported: boolean;
  /** True when an aborted request/stream failed closed with LLM_CANCELED. */
  cancellation: boolean;
  /** Per-check failures with a safe message (never a secret or Project data). */
  errors: { check: string; message: string }[];
}

export interface ProbeOptions {
  /** Owner gate — the probe is owner-only endpoint routing (docs/11 §1). */
  isOwner: boolean;
  now?: () => Date;
}

function safeMessage(err: unknown): string {
  if (isLlmError(err)) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.name;
  return 'unknown error';
}

/**
 * Run the capability probe against `provider`. Never throws for a *provider*
 * shortfall — a failed check lands in `errors` and lowers a capability flag — but
 * DOES throw {@link LlmConfigError} when the caller is not the owner.
 */
export async function probeProvider(
  provider: ModelProvider,
  options: ProbeOptions,
): Promise<CapabilityProbeResult> {
  if (!options.isOwner) {
    throw new LlmConfigError('capability probe is owner-only');
  }
  const now = options.now ?? ((): Date => new Date());
  const capabilities: ProviderCapabilities = {
    text: false,
    tools: false,
    streaming: false,
    structuredOutput: false,
    vision: false,
  };
  const errors: { check: string; message: string }[] = [];
  let usageReported = false;
  let cancellation = false;

  const textRequest: GenerateRequest = {
    messages: [...SYNTHETIC_PROBE_MESSAGES],
    dataMode: 'redacted_cloud',
  };

  // 1) Text
  try {
    const result = await provider.generate(textRequest);
    capabilities.text = result.text.length > 0 || result.finishReason === 'stop';
    if (result.usage.kind === 'known') usageReported = true;
  } catch (err) {
    errors.push({ check: 'text', message: safeMessage(err) });
  }

  // 2) Streaming termination
  try {
    let sawFinish = false;
    for await (const event of provider.stream(textRequest)) {
      if (event.type === 'usage' && event.usage.kind === 'known') usageReported = true;
      if (event.type === 'finish') sawFinish = true;
    }
    capabilities.streaming = sawFinish;
  } catch (err) {
    errors.push({ check: 'streaming', message: safeMessage(err) });
  }

  // 3) Typed tool call + 4) structured JSON
  try {
    const result = await provider.generate({
      messages: [
        ...SYNTHETIC_PROBE_MESSAGES,
        { role: 'user', content: 'Call redai_probe_echo with marker "probe".' },
      ],
      tools: [SYNTHETIC_PROBE_TOOL],
      dataMode: 'redacted_cloud',
    });
    const call = result.toolCalls?.[0];
    if (call) {
      capabilities.tools = true;
      // Structured output = the arguments parsed to a JSON object (assembler already
      // parsed argumentsRaw; a malformed argument string would have thrown).
      capabilities.structuredOutput = typeof call.arguments === 'object' && call.arguments !== null;
    }
    if (result.usage.kind === 'known') usageReported = true;
  } catch (err) {
    errors.push({ check: 'tools', message: safeMessage(err) });
  }

  // 5) Cancellation — abort before reading; must fail closed with LLM_CANCELED.
  try {
    const controller = new AbortController();
    controller.abort();
    await provider.generate({ ...textRequest, stream: true, signal: controller.signal });
    errors.push({ check: 'cancellation', message: 'request was not canceled' });
  } catch (err) {
    if (err instanceof LlmCanceledError) {
      cancellation = true;
    } else {
      errors.push({ check: 'cancellation', message: safeMessage(err) });
    }
  }

  return {
    probedAt: now().toISOString(),
    capabilities,
    usageReported,
    cancellation,
    errors,
  };
}

/**
 * Guard used before starting an Agent run: if the run needs tools but the provider
 * cannot do native tool calling, reject — the system must NOT parse tools out of
 * prose (docs/11 §2). `requiresTools` is true for any Agent (Ask has an empty
 * toolset and passes with tools=false).
 */
export function ensureAgentCapable(
  capabilities: ProviderCapabilities,
  requiresTools: boolean,
): void {
  if (requiresTools && !capabilities.tools) {
    throw new LlmCapabilityError(
      'provider does not support tool calling; refusing to run an Agent via prose tool-parsing',
    );
  }
}
