import { describe, expect, it, vi } from 'vitest';

import { LlmNoProviderError, LlmServerError } from './errors.js';
import {
  assertDataModeAllowed,
  generateWithFallback,
  isCandidateEligible,
  selectProvider,
  type ProviderCandidate,
} from './routing.js';
import type { GenerateRequest, GenerateResult, ModelProvider } from './types.js';

function stubProvider(label: string, impl?: () => Promise<GenerateResult>): ModelProvider {
  return {
    info: {
      kind: 'openai_compatible',
      label,
      isMock: false,
      capabilities: {
        text: true,
        tools: true,
        streaming: true,
        structuredOutput: true,
        vision: false,
      },
    },
    generate: impl ? vi.fn(impl) : vi.fn(async () => okResult(label)),
    // eslint-disable-next-line require-yield
    async *stream(): AsyncIterable<never> {
      throw new Error('not used');
    },
  };
}

function okResult(label: string): GenerateResult {
  return {
    text: 'ok',
    usage: { kind: 'unknown' },
    finishReason: 'stop',
    isMock: false,
    providerLabel: label,
  };
}

const request: GenerateRequest = { messages: [{ role: 'user', content: 'hi' }] };

describe('data-mode routing', () => {
  it('local_only excludes a cloud endpoint from the eligible set', () => {
    const cloud: ProviderCandidate = {
      provider: stubProvider('cloud'),
      allowedDataModes: ['local_only', 'redacted_cloud'],
      isLocalEndpoint: false,
    };
    expect(isCandidateEligible(cloud, 'local_only')).toBe(false);
    expect(isCandidateEligible(cloud, 'redacted_cloud')).toBe(true);
  });

  it('local_only never hits the compatible (cloud) adapter — no cloud fallback', async () => {
    const localGenerate = vi.fn(async () => okResult('local'));
    const cloudGenerate = vi.fn(async () => okResult('cloud'));
    const local: ProviderCandidate = {
      provider: stubProvider('local', localGenerate),
      allowedDataModes: ['local_only'],
      isLocalEndpoint: true,
    };
    const cloud: ProviderCandidate = {
      provider: stubProvider('cloud', cloudGenerate),
      allowedDataModes: ['local_only', 'redacted_cloud', 'cloud_full'],
      isLocalEndpoint: false,
    };

    const result = await generateWithFallback([local, cloud], {
      ...request,
      dataMode: 'local_only',
    });
    expect(result.providerLabel).toBe('local');
    expect(localGenerate).toHaveBeenCalledTimes(1);
    // The whole point: the cloud adapter is never invoked under local_only.
    expect(cloudGenerate).not.toHaveBeenCalled();
  });

  it('local_only with ONLY a cloud provider throws (never falls back to cloud)', async () => {
    const cloudGenerate = vi.fn(async () => okResult('cloud'));
    const cloud: ProviderCandidate = {
      provider: stubProvider('cloud', cloudGenerate),
      allowedDataModes: ['local_only', 'redacted_cloud'],
      isLocalEndpoint: false,
    };
    await expect(
      generateWithFallback([cloud], { ...request, dataMode: 'local_only' }),
    ).rejects.toBeInstanceOf(LlmNoProviderError);
    expect(cloudGenerate).not.toHaveBeenCalled();
    expect(() => selectProvider([cloud], 'local_only')).toThrow(LlmNoProviderError);
  });

  it('assertDataModeAllowed fails closed for a local_only cloud egress', () => {
    const cloud: ProviderCandidate = {
      provider: stubProvider('cloud'),
      allowedDataModes: ['local_only'],
      isLocalEndpoint: false,
    };
    expect(() => assertDataModeAllowed(cloud, 'local_only')).toThrow(/local endpoint/);
  });

  it('falls back to the next eligible provider only on a retryable error', async () => {
    const failing = vi.fn(async () => {
      throw new LlmServerError(503);
    });
    const primary: ProviderCandidate = {
      provider: stubProvider('primary', failing),
      allowedDataModes: ['redacted_cloud'],
      isLocalEndpoint: false,
    };
    const backup: ProviderCandidate = {
      provider: stubProvider('backup'),
      allowedDataModes: ['redacted_cloud'],
      isLocalEndpoint: false,
    };
    const result = await generateWithFallback([primary, backup], {
      ...request,
      dataMode: 'redacted_cloud',
    });
    expect(result.providerLabel).toBe('backup');
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('does NOT fall back on a non-retryable error', async () => {
    const { LlmAuthError } = await import('./errors.js');
    const failing = vi.fn(async () => {
      throw new LlmAuthError(401);
    });
    const backupGenerate = vi.fn(async () => okResult('backup'));
    const primary: ProviderCandidate = {
      provider: stubProvider('primary', failing),
      allowedDataModes: ['redacted_cloud'],
      isLocalEndpoint: false,
    };
    const backup: ProviderCandidate = {
      provider: stubProvider('backup', backupGenerate),
      allowedDataModes: ['redacted_cloud'],
      isLocalEndpoint: false,
    };
    await expect(
      generateWithFallback([primary, backup], { ...request, dataMode: 'redacted_cloud' }),
    ).rejects.toMatchObject({ code: 'LLM_AUTH' });
    expect(backupGenerate).not.toHaveBeenCalled();
  });
});
