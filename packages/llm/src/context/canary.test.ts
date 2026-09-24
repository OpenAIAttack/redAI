/**
 * Canary / egress-surface tests (docs/11 §5, §9). A planted canary secret must be
 * redacted to a reference and must NOT survive to ANY egress surface: request
 * headers, the wire body, an HTML preview, error text, log lines, or the mock
 * provider's payload capture. Also asserts the data-mode rule: local_only never
 * switches to a cloud provider, and there is no silent provider/full-cloud switch.
 */
import { describe, expect, it } from 'vitest';
import { buildContextManifest } from './manifest.js';
import { makeCanary, scanForSecret, assertNoSecretLeak } from './canary.js';
import type { ContextSource, TokenCaps } from './types.js';
import { MockProvider } from '../mock/provider.js';
import type { CapturedPayload } from '../mock/provider.js';
import { selectProvider, isCandidateEligible } from '../routing.js';
import type { ProviderCandidate } from '../routing.js';
import { LlmNoProviderError } from '../errors.js';

const CAPS: TokenCaps = { total: 500, notes: 200, summary: 80, history: 120, evidence: 80 };

const textFixture = {
  id: 'text',
  events: [{ text: 'ok' }, { finish: 'stop' }],
};

describe('canary redaction across egress surfaces', () => {
  it('a planted canary never reaches the wire body / payload capture', async () => {
    const canary = makeCanary('leak-test');
    const sources: ContextSource[] = [
      {
        id: 'platform',
        layer: 'platform',
        role: 'system',
        version: 'v1',
        classification: 'internal',
        text: 'system',
      },
      {
        id: 'note',
        layer: 'notes',
        role: 'system',
        version: 'v1',
        classification: 'sensitive',
        text: `the target reflected the secret ${canary} into its response`,
        untrusted: true,
      },
      {
        id: 'goal',
        layer: 'goal',
        role: 'user',
        version: 'v1',
        classification: 'internal',
        text: 'summarise',
      },
    ];

    const manifest = buildContextManifest(sources, CAPS, {
      runId: 'run-1',
      // The canary is registered as a secret to redact; a leak means it survived.
      secretRefs: [{ ref: 'canary', value: canary }],
    });

    // The manifest messages already carry a reference, not the value.
    expect(JSON.stringify(manifest.messages)).not.toContain(canary);

    let captured: CapturedPayload | undefined;
    const provider = new MockProvider({
      fixtures: [textFixture],
      model: 'mock-model-v1',
      onCapture: (p) => {
        captured = p;
      },
    });

    const result = await provider.generate({
      messages: manifest.messages,
      tools: [],
      dataMode: 'redacted_cloud',
    });

    // Simulate the full egress fan-out a request would produce.
    const headers = {
      authorization: 'Bearer [SECRET_REF_provider]',
      'content-type': 'application/json',
    };
    const html = `<div data-preview="${manifest.messages.map((m) => m.content).join(' ')}"></div>`;
    const logs = [`generated ${result.text} for run-1`, `provider=${provider.info.label}`];
    const errors = [new Error(`model returned ${result.finishReason}`)];

    const surfaces = {
      headers,
      body: captured!.wire,
      html,
      logs,
      errors,
      payloadCapture: captured,
    };

    expect(scanForSecret(surfaces, canary)).toEqual([]);
    expect(() => assertNoSecretLeak(surfaces, canary)).not.toThrow();
  });

  it('scanForSecret flags EVERY surface when a raw secret does leak', () => {
    const canary = makeCanary('positive');
    const surfaces = {
      headers: { authorization: `Bearer ${canary}` },
      body: { messages: [{ content: canary }] },
      html: `<a title="${canary}">x</a>`,
      logs: [`oops ${canary}`],
      errors: [new Error(`failed with ${canary}`)],
      payloadCapture: { wire: { messages: [{ content: canary }] } },
    };
    const leaks = scanForSecret(surfaces, canary);
    expect(leaks).toEqual(
      expect.arrayContaining(['headers', 'body', 'html', 'logs', 'errors[0]', 'payloadCapture']),
    );
    expect(() => assertNoSecretLeak(surfaces, canary)).toThrow(/egress surface/);
  });

  it('the leak error names surfaces but never the secret itself', () => {
    const canary = makeCanary('quiet');
    try {
      assertNoSecretLeak({ logs: [canary] }, canary);
      throw new Error('expected a throw');
    } catch (err) {
      expect((err as Error).message).not.toContain(canary);
      expect((err as Error).message).toContain('logs');
    }
  });
});

describe('no automatic provider / full-cloud switch (T08 data-mode rule)', () => {
  function candidate(
    local: boolean,
    modes: ProviderCandidate['allowedDataModes'],
  ): ProviderCandidate {
    return {
      provider: new MockProvider({ fixtures: [textFixture] }),
      allowedDataModes: modes,
      isLocalEndpoint: local,
    };
  }

  it('local_only never selects a cloud candidate (no silent switch)', () => {
    const cloud = candidate(false, ['redacted_cloud', 'cloud_full', 'local_only']);
    expect(isCandidateEligible(cloud, 'local_only')).toBe(false);
    expect(() => selectProvider([cloud], 'local_only')).toThrow(LlmNoProviderError);
  });

  it('a redacted_cloud-only provider is not silently upgraded to cloud_full', () => {
    const c = candidate(false, ['redacted_cloud']);
    expect(isCandidateEligible(c, 'cloud_full')).toBe(false);
    expect(() => selectProvider([c], 'cloud_full')).toThrow(LlmNoProviderError);
  });
});
