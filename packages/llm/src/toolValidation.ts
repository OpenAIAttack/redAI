/**
 * Tool-call argument validation against the canonical `@redai/contracts` schemas.
 * A tool call surfaced by a model is UNTRUSTED (docs/11 §6): its arguments are
 * validated with the generated Ajv validators — never a TypeScript cast — before
 * the runtime dispatches the effect. A missing required field means "do not
 * dispatch" (docs/11 §9), surfaced here as an invalid result rather than a throw so
 * the caller can decide (reject the call, ask the model to retry, etc.).
 */
import { ContractValidationError, isValidFor, type ContractKey } from '@redai/contracts';

import type { ToolCall } from './types.js';

export type ToolValidation = { ok: true } | { ok: false; message: string };

/** True when `args` conforms to the contract schema for `key`. */
export function isToolArgsValid(key: ContractKey, args: unknown): boolean {
  return isValidFor(key, args);
}

/**
 * Validate a parsed tool call's arguments against a contract schema. Returns a
 * discriminated result; the caller must NOT dispatch when `ok` is false.
 */
export function validateToolCall(key: ContractKey, call: ToolCall): ToolValidation {
  try {
    if (isValidFor(key, call.arguments)) return { ok: true };
    return { ok: false, message: `tool "${call.name}" arguments failed contract ${key}` };
  } catch (err) {
    if (err instanceof ContractValidationError) return { ok: false, message: err.message };
    // An unknown contract key or Ajv wiring problem is a programming error, re-throw.
    throw err;
  }
}
