import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LlmCapabilityError, LlmConfigError } from './errors.js';
import { MockProvider } from './mock/provider.js';
import { loadFixtureDir, type MockFixture } from './mock/fixtures.js';
import {
  ensureAgentCapable,
  probeProvider,
  SYNTHETIC_PROBE_MESSAGES,
  type CapabilityProbeResult,
} from './probe.js';
import type { CapturedPayload } from './mock/provider.js';

const here = dirname(fileURLToPath(import.meta.url));
const ALL = loadFixtureDir(join(here, '../../../tests/fixtures/models'));
function fixture(id: string): MockFixture {
  const f = ALL.find((x) => x.id === id);
  if (!f) throw new Error(`missing fixture ${id}`);
  return f;
}

describe('capability probe', () => {
  it('is owner-only', async () => {
    const provider = new MockProvider({ fixtures: [fixture('text-simple')] });
    await expect(probeProvider(provider, { isOwner: false })).rejects.toBeInstanceOf(
      LlmConfigError,
    );
  });

  it('detects full capabilities on a tool-capable provider using synthetic data only', async () => {
    const captures: CapturedPayload[] = [];
    const provider = new MockProvider({
      fixtures: [fixture('text-simple'), fixture('structured-json')],
      onCapture: (p) => captures.push(p),
    });
    const result: CapabilityProbeResult = await probeProvider(provider, { isOwner: true });

    expect(result.capabilities.text).toBe(true);
    expect(result.capabilities.streaming).toBe(true);
    expect(result.capabilities.tools).toBe(true);
    expect(result.capabilities.structuredOutput).toBe(true);
    expect(result.usageReported).toBe(true);
    expect(result.cancellation).toBe(true);
    expect(result.errors).toEqual([]);

    // Synthetic-data guarantee: the very first probe turn is the fixed synthetic
    // system prompt — no Project content ever reaches the endpoint.
    const firstWire = captures[0]?.wire;
    expect(firstWire?.messages[0]?.content).toBe(SYNTHETIC_PROBE_MESSAGES[0]?.content);
    // No capture carries anything but the synthetic markers.
    const dump = JSON.stringify(captures);
    expect(dump).toContain('capability probe');
    expect(dump).not.toContain('PROJECT');
  });

  it('flags a provider that cannot do native tool calling', async () => {
    // Only a text fixture: a tool request falls back to text (no tool call emitted).
    const provider = new MockProvider({ fixtures: [fixture('text-simple')] });
    const result = await probeProvider(provider, { isOwner: true });
    expect(result.capabilities.tools).toBe(false);

    // The Agent-capability guard must then REJECT running an Agent (no prose parsing).
    expect(() => ensureAgentCapable(result.capabilities, true)).toThrow(LlmCapabilityError);
    // Ask (empty toolset) is fine.
    expect(() => ensureAgentCapable(result.capabilities, false)).not.toThrow();
  });
});
