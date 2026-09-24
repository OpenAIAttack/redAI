/**
 * @redai/domain — pure domain entities, invariants and state transitions.
 * MUST NOT import HTTP frameworks, UI, Docker, provider SDKs or the database.
 */

export const DOMAIN_PACKAGE = '@redai/domain';

export type { ReadinessStatus, ComponentCheck, ReadinessResult } from './health.js';
export { computeReadiness } from './health.js';
