/**
 * Boundary validation for the auth request bodies.
 *
 * The canonical `contracts/schemas/api.schema.json` defines `LoginRequest`, but the
 * T03 `@redai/contracts` registry did not export a generated validator for it (only
 * the resource schemas later tasks consume were registered), and this task must not
 * edit `packages/contracts`. So we compile the *same* canonical sub-schema with a
 * local Ajv here — real JSON-Schema validation at the boundary, never a TS cast. A
 * drift-guard test (`bodySchemas.test.ts`) asserts this literal stays byte-identical
 * to the canonical `$defs.LoginRequest`.
 */
import { createRequire } from 'node:module';
import type { ValidateFunction } from 'ajv';
import type { LoginRequest } from '@redai/contracts';

const nodeRequire = createRequire(import.meta.url);
const { default: Ajv } = nodeRequire('ajv') as typeof import('ajv');

/** Byte-for-byte copy of `api.schema.json#/$defs/LoginRequest` (guarded against drift). */
export const LOGIN_REQUEST_SCHEMA = {
  type: 'object',
  properties: {
    username: { type: 'string', minLength: 1, maxLength: 120 },
    password: { type: 'string', minLength: 1, maxLength: 1024, writeOnly: true },
  },
  required: ['username', 'password'],
  additionalProperties: false,
} as const;

const ajv = new Ajv({ strict: true, allErrors: true });
const validateLogin: ValidateFunction = ajv.compile(LOGIN_REQUEST_SCHEMA);

export class BodyValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'BodyValidationError';
  }
}

/** Validate an untrusted body against the canonical LoginRequest schema. */
export function parseLoginRequest(body: unknown): LoginRequest {
  if (validateLogin(body) !== true) {
    const detail = (validateLogin.errors ?? [])
      .map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}`)
      .join('; ');
    throw new BodyValidationError(`invalid login body: ${detail || 'unknown error'}`);
  }
  return body as LoginRequest;
}
