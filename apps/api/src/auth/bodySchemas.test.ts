import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { LOGIN_REQUEST_SCHEMA, parseLoginRequest, BodyValidationError } from './bodySchemas.js';

const here = dirname(fileURLToPath(import.meta.url));
const canonical = JSON.parse(
  readFileSync(resolve(here, '../../../..', 'contracts/schemas/api.schema.json'), 'utf8'),
) as { $defs: { LoginRequest: unknown } };

describe('login body validation', () => {
  it('stays byte-identical to the canonical api.schema.json LoginRequest (no drift)', () => {
    expect(canonical.$defs.LoginRequest).toEqual(JSON.parse(JSON.stringify(LOGIN_REQUEST_SCHEMA)));
  });

  it('accepts a well-formed body', () => {
    expect(parseLoginRequest({ username: 'owner', password: 'correct-horse' })).toEqual({
      username: 'owner',
      password: 'correct-horse',
    });
  });

  it('rejects missing fields, wrong types and extra keys', () => {
    expect(() => parseLoginRequest({ username: 'owner' })).toThrow(BodyValidationError);
    expect(() => parseLoginRequest({ username: 1, password: 'x' })).toThrow(BodyValidationError);
    expect(() => parseLoginRequest({ username: 'o', password: 'x', extra: true })).toThrow(
      BodyValidationError,
    );
    expect(() => parseLoginRequest(undefined)).toThrow(BodyValidationError);
  });
});
