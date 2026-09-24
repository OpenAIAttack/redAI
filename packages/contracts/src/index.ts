/**
 * @redai/contracts — generated TS types + runtime validators derived from the
 * canonical JSON Schemas under `contracts/schemas/`. There is no hand-maintained
 * copy of the contract shapes: types come from json-schema-to-typescript and
 * validation from a strict Ajv 2020 instance loaded with the same schemas.
 *
 * Regenerate with `pnpm --filter @redai/contracts run codegen`; CI enforces that
 * the committed output is not stale (see `run codegen:check`).
 */

export const CONTRACTS_PACKAGE = '@redai/contracts';

// Generated TypeScript types for every schema definition.
export * from './generated/types.js';

// Generated typed validators: validateX (asserts) + parseX (returns X).
export * from './generated/validators.js';

// Runtime validation primitives.
export {
  ContractValidationError,
  assertValidFor,
  getValidator,
  isValidFor,
} from './validate.js';

// Contract registry (keys shared with the Go worker + contract-cases manifest).
export {
  CONTRACT_KEYS,
  CONTRACT_SCHEMAS,
  SCHEMA_BASE,
  type ContractEntry,
  type ContractKey,
} from './registry.js';
