/**
 * @redai/application — use cases and transaction orchestration.
 *
 * `auth` is exported flat from the package root. The T05/T06/T07/T15 modules
 * (settings, projects, artifacts, workerIdentity) are exposed as SUBPATH entry points
 * (`@redai/application/settings`, `/projects`, `/artifacts`, `/workerIdentity`) — see
 * the package `exports` map — so their overlapping helper names (`systemClock`,
 * `constantTimeEqual`, `Clock`, `RandomSource`) never collide at one barrel.
 */

export const APPLICATION_PACKAGE = '@redai/application';

export * from './auth/index.js';
