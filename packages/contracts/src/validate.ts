/**
 * Runtime JSON Schema validation layer.
 *
 * Wraps a single Ajv 2020 instance loaded with every canonical redAI schema.
 * All cross-file `$ref`s resolve by `$id`, so the schemas are added verbatim.
 * Validation is strict (`strict: true`), rejects unknown fields wherever a
 * schema sets `additionalProperties: false`, and enforces declared `format`s
 * via ajv-formats. This is the ONLY place a contract payload is trusted, and it
 * never relies on a TypeScript cast to stand in for runtime checking.
 */
import { createRequire } from 'node:module';
import type { AnySchemaObject, ErrorObject, ValidateFunction } from 'ajv';

import { allSchemas } from './generated/schemas.js';
import { CONTRACT_SCHEMAS, type ContractKey } from './registry.js';

// ajv and ajv-formats ship as CommonJS with a `default` export. Under the repo's
// NodeNext/ESM resolution a top-level default import is typed as the module
// namespace rather than the class/function, so we load them through a scoped
// CommonJS require and pull the real default. This keeps types and runtime in
// agreement without an unchecked `as` over any payload.
const nodeRequire = createRequire(import.meta.url);
const { default: Ajv2020 } = nodeRequire('ajv/dist/2020') as typeof import('ajv/dist/2020.js');
const { default: addFormats } = nodeRequire('ajv-formats') as typeof import('ajv-formats');
type Ajv2020Instance = InstanceType<typeof Ajv2020>;

/** Error thrown when a payload fails contract validation. */
export class ContractValidationError extends Error {
  public readonly schema: string;
  public readonly errors: ErrorObject[];

  public constructor(schema: string, errors: ErrorObject[] | null | undefined) {
    const list = errors ?? [];
    const detail = list
      .map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}`)
      .join('; ');
    super(`contract ${schema} validation failed: ${detail || 'unknown error'}`);
    this.name = 'ContractValidationError';
    this.schema = schema;
    this.errors = list;
  }
}

function buildAjv(): Ajv2020Instance {
  const ajv = new Ajv2020({
    strict: true,
    // The canonical schemas author some `if`/`then` conditionals (e.g. the
    // worker TaskEnvelope network_profile rule) without a redundant `type`
    // keyword. That trips Ajv's strictTypes analysis, which is a performance
    // lint, not a validation relaxation. We must not edit the frozen schemas,
    // so strictTypes is disabled while all real strictness (unknown keywords,
    // additionalProperties:false, format enforcement) stays on.
    strictTypes: false,
    allErrors: true,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  for (const schema of allSchemas) {
    ajv.addSchema(schema as unknown as AnySchemaObject);
  }
  return ajv;
}

const ajv: Ajv2020Instance = buildAjv();

const validatorCache = new Map<string, ValidateFunction>();

function validatorFor(uri: string): ValidateFunction {
  const cached = validatorCache.get(uri);
  if (cached) return cached;
  const fn = ajv.getSchema(uri);
  if (!fn) {
    throw new Error(`no compiled validator for schema uri: ${uri}`);
  }
  validatorCache.set(uri, fn);
  return fn;
}

/** Return the raw Ajv validate function for a contract key. */
export function getValidator(key: ContractKey): ValidateFunction {
  return validatorFor(CONTRACT_SCHEMAS[key].uri);
}

/** True when `data` conforms to the schema for `key` (no throw). */
export function isValidFor(key: ContractKey, data: unknown): boolean {
  return validatorFor(CONTRACT_SCHEMAS[key].uri)(data) === true;
}

/**
 * Assert that `data` conforms to the schema for `key`, throwing
 * ContractValidationError otherwise. Generated `validateX` helpers wrap this
 * with a concrete `asserts data is X` signature.
 */
export function assertValidFor(key: ContractKey, data: unknown): void {
  const fn = validatorFor(CONTRACT_SCHEMAS[key].uri);
  if (fn(data) !== true) {
    throw new ContractValidationError(key, fn.errors);
  }
}
