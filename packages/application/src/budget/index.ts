/**
 * @redai/application/budget barrel — the budget-reservation ledger (docs/11 §7).
 * Reserve BEFORE a request, a shared per-run ledger, pricing-version-aware cost, and
 * unknown usage HELD (never recorded as 0). The runtime calls the reservation gateway;
 * the DB adapter's row lock keeps parallel reservations from over-committing.
 *
 * NOTE: the package `exports` map is wired by the coordinator (see the T14 report for
 * the exact subpath line to add). This file is the module's own public surface.
 */

export {
  BudgetService,
  type BudgetServiceDeps,
  type ReserveRequestInput,
  type ReconcileUsageInput,
  type IncreaseLimitRequest,
} from './service.js';

export { estimateReservation, observedCost, type ObservedCost } from './pricing.js';

export {
  createReservationGateway,
  type ReservationGateway,
  type ReserveForModelCallInput,
  type ReserveForModelCallResult,
  type ReconcileModelCallInput,
} from './reservationGateway.js';

export { createDbBudgetRepository } from './dbRepository.js';
export { InMemoryBudgetRepository, type BudgetAuditEntry } from './memoryRepository.js';

export {
  BudgetError,
  isBudgetError,
  BudgetExceededError,
  ReservationNotFoundError,
  RunNotFoundError,
  InvalidBudgetIncreaseError,
  InvalidPricingError,
  type BudgetErrorCode,
} from './errors.js';

export type {
  Clock,
  ReservationState,
  UsageBasis,
  PricingConfig,
  ReservationRecord,
  UsageEntryRecord,
  LedgerSnapshot,
  ReserveInput,
  ReserveOutcome,
  ReconcileInput,
  ReconcileOutcome,
  ReleaseInput,
  IncreaseLimitInput,
  IncreaseLimitOutcome,
  BudgetRepository,
} from './ports.js';
