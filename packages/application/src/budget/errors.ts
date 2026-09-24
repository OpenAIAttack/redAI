/**
 * Typed budget errors. The service returns discriminated outcomes for the normal
 * "over budget" path (the runtime stops new requests without hiding the overrun,
 * docs/11 §7); these errors cover programmer/precondition failures.
 */

export type BudgetErrorCode =
  | 'BUDGET_EXCEEDED'
  | 'RESERVATION_NOT_FOUND'
  | 'RUN_NOT_FOUND'
  | 'INVALID_BUDGET_INCREASE'
  | 'INVALID_PRICING';

export class BudgetError extends Error {
  public readonly code: BudgetErrorCode;
  public constructor(code: BudgetErrorCode, message: string) {
    super(message);
    this.name = 'BudgetError';
    this.code = code;
  }
}

export function isBudgetError(err: unknown): err is BudgetError {
  return err instanceof BudgetError;
}

/** Thrown by the convenience gateway when a reservation would exceed the run budget. */
export class BudgetExceededError extends BudgetError {
  public readonly requestedMicroUsd: bigint;
  public readonly remainingMicroUsd: bigint;
  public constructor(requested: bigint, remaining: bigint) {
    super(
      'BUDGET_EXCEEDED',
      `reservation of ${requested} µUSD exceeds remaining run budget ${remaining} µUSD`,
    );
    this.name = 'BudgetExceededError';
    this.requestedMicroUsd = requested;
    this.remainingMicroUsd = remaining;
  }
}

export class ReservationNotFoundError extends BudgetError {
  public constructor() {
    super('RESERVATION_NOT_FOUND', 'reservation not found');
    this.name = 'ReservationNotFoundError';
  }
}

export class RunNotFoundError extends BudgetError {
  public constructor() {
    super('RUN_NOT_FOUND', 'run not found');
    this.name = 'RunNotFoundError';
  }
}

export class InvalidBudgetIncreaseError extends BudgetError {
  public constructor(message: string) {
    super('INVALID_BUDGET_INCREASE', message);
    this.name = 'InvalidBudgetIncreaseError';
  }
}

export class InvalidPricingError extends BudgetError {
  public constructor(message: string) {
    super('INVALID_PRICING', message);
    this.name = 'InvalidPricingError';
  }
}
