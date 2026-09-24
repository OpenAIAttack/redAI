/**
 * Boundary validation for the settings request bodies — real JSON-Schema validation
 * with a local Ajv (never a TS cast). These schemas are self-contained to this task
 * (the T03 `@redai/contracts` registry does not yet export settings validators and
 * this task must not edit `packages/contracts`). Secret material carried inbound
 * (`api_key`) is marked `writeOnly` and is never echoed back by any route.
 */
import { createRequire } from 'node:module';
import type { ValidateFunction } from 'ajv';

const nodeRequire = createRequire(import.meta.url);
const { default: Ajv } = nodeRequire('ajv') as typeof import('ajv');

const ajv = new Ajv({ strict: true, allErrors: true });

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

export const CREATE_PROVIDER_CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    display_name: { type: 'string', minLength: 1, maxLength: 120 },
    config: { type: 'object' },
    enabled: { type: 'boolean' },
    api_key: { type: 'string', minLength: 1, maxLength: 8192, writeOnly: true },
    credential_ref: { type: ['string', 'null'], pattern: UUID_PATTERN },
  },
  required: ['display_name', 'config'],
  additionalProperties: false,
} as const;

export const UPDATE_PROVIDER_CONFIG_SCHEMA = {
  type: 'object',
  properties: {
    expected_revision: { type: 'integer', minimum: 1 },
    display_name: { type: 'string', minLength: 1, maxLength: 120 },
    config: { type: 'object' },
    enabled: { type: 'boolean' },
  },
  required: ['expected_revision'],
  additionalProperties: false,
} as const;

export const UPDATE_SETTINGS_SCHEMA = {
  type: 'object',
  properties: {
    expected_revision: { type: 'integer', minimum: 1 },
    settings: { type: 'object' },
  },
  required: ['expected_revision', 'settings'],
  additionalProperties: false,
} as const;

export interface CreateProviderConfigBody {
  display_name: string;
  config: Record<string, unknown>;
  enabled?: boolean;
  api_key?: string;
  credential_ref?: string | null;
}

export interface UpdateProviderConfigBody {
  expected_revision: number;
  display_name?: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export interface UpdateSettingsBody {
  expected_revision: number;
  settings: Record<string, unknown>;
}

export class BodyValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'BodyValidationError';
  }
}

function makeParser<T>(validate: ValidateFunction, label: string): (body: unknown) => T {
  return (body: unknown): T => {
    if (validate(body) !== true) {
      const detail = (validate.errors ?? [])
        .map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}`)
        .join('; ');
      throw new BodyValidationError(`invalid ${label}: ${detail || 'unknown error'}`);
    }
    return body as T;
  };
}

export const parseCreateProviderConfig = makeParser<CreateProviderConfigBody>(
  ajv.compile(CREATE_PROVIDER_CONFIG_SCHEMA),
  'provider config',
);
export const parseUpdateProviderConfig = makeParser<UpdateProviderConfigBody>(
  ajv.compile(UPDATE_PROVIDER_CONFIG_SCHEMA),
  'provider config update',
);
export const parseUpdateSettings = makeParser<UpdateSettingsBody>(
  ajv.compile(UPDATE_SETTINGS_SCHEMA),
  'settings',
);
