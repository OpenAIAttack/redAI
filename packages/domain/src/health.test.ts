import { describe, expect, it } from 'vitest';
import { computeReadiness, type ComponentCheck } from './index.js';

const db = (o: Partial<ComponentCheck> = {}): ComponentCheck => ({
  name: 'database',
  configured: true,
  healthy: true,
  required: true,
  ...o,
});
const provider = (o: Partial<ComponentCheck> = {}): ComponentCheck => ({
  name: 'model_provider',
  configured: false,
  healthy: false,
  required: false,
  ...o,
});

describe('computeReadiness', () => {
  it('is unconfigured when a required component is not configured', () => {
    expect(computeReadiness([db({ configured: false, healthy: false })]).status).toBe(
      'unconfigured',
    );
  });

  it('is ready when required components are configured & healthy and optional ones are absent', () => {
    // Owner can manage data before a model provider is configured.
    expect(computeReadiness([db(), provider()]).status).toBe('ready');
  });

  it('is degraded when a configured component is unhealthy', () => {
    expect(computeReadiness([db({ healthy: false })]).status).toBe('degraded');
  });

  it('optional-but-configured unhealthy component degrades readiness', () => {
    expect(computeReadiness([db(), provider({ configured: true, healthy: false })]).status).toBe(
      'degraded',
    );
  });
});
