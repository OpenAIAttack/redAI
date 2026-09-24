/**
 * Pure readiness logic shared by API/runtime health endpoints.
 *
 * The health surface must distinguish "not configured yet" from "ready" so an
 * owner installing redAI can tell setup-incomplete apart from a real fault
 * (T01 acceptance). This module is pure: no I/O, no framework imports.
 */

export type ReadinessStatus = 'unconfigured' | 'degraded' | 'ready';

export interface ComponentCheck {
  /** Stable identifier, e.g. "database", "object_store", "model_provider". */
  readonly name: string;
  /** Whether the owner has configured this component at all. */
  readonly configured: boolean;
  /** Whether the component is reachable/healthy right now. */
  readonly healthy: boolean;
  /** If true, absence of configuration makes the whole system unconfigured. */
  readonly required: boolean;
}

export interface ReadinessResult {
  readonly status: ReadinessStatus;
  readonly components: readonly ComponentCheck[];
}

/**
 * Fold component checks into a single readiness status.
 *
 * - `unconfigured`: at least one REQUIRED component has not been configured.
 * - `degraded`: everything required is configured, but some configured
 *   component is currently unhealthy.
 * - `ready`: all required components configured and all configured components
 *   healthy.
 */
export function computeReadiness(components: readonly ComponentCheck[]): ReadinessResult {
  const anyRequiredUnconfigured = components.some((c) => c.required && !c.configured);
  if (anyRequiredUnconfigured) {
    return { status: 'unconfigured', components };
  }
  const anyConfiguredUnhealthy = components.some((c) => c.configured && !c.healthy);
  if (anyConfiguredUnhealthy) {
    return { status: 'degraded', components };
  }
  return { status: 'ready', components };
}
