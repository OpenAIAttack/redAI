/**
 * @redai/runtime Ask driver barrel. The durable Ask loop composes the
 * `@redai/application/messages` `AskService` (create/step/history) with this driver's
 * lease claim/release. Wiring the real pg pool + provider resolver is done by the
 * runtime entrypoint (and the API composes the same pieces for its create endpoint).
 */
export { AskRuntimeDriver, DEFAULT_LEASE_SECONDS } from './driver.js';
export type { AskRuntimeDriverDeps, TickResult, Clock } from './driver.js';
