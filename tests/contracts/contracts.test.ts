import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONTRACT_KEYS,
  CONTRACT_SCHEMAS,
  ContractValidationError,
  isValidFor,
  parseRun,
  validateRun,
  type ContractKey,
} from '../../packages/contracts/src/index.js';
import { findDrift } from '../../packages/contracts/src/codegen/generate.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const examplesDir = join(repoRoot, 'contracts', 'examples');

interface Case {
  file: string;
  schema: string;
  expected: 'valid' | 'invalid';
}

const manifest = JSON.parse(
  readFileSync(join(here, 'contract-cases.json'), 'utf8'),
) as { cases: Case[] };

function readExample(file: string): unknown {
  return JSON.parse(readFileSync(join(examplesDir, file), 'utf8'));
}

describe('contract-cases manifest', () => {
  it('references only known contract schema keys', () => {
    for (const c of manifest.cases) {
      expect(CONTRACT_KEYS).toContain(c.schema as ContractKey);
    }
  });

  it('covers every fixture in contracts/examples/', () => {
    const onDisk = readdirSync(examplesDir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    const inManifest = manifest.cases.map((c) => c.file).sort();
    expect(inManifest).toEqual(onDisk);
  });

  it('has no duplicate fixture entries', () => {
    const files = manifest.cases.map((c) => c.file);
    expect(new Set(files).size).toBe(files.length);
  });

  it('expectation agrees with the fixture filename convention', () => {
    for (const c of manifest.cases) {
      const looksInvalid = /invalid/.test(c.file);
      expect(c.expected).toBe(looksInvalid ? 'invalid' : 'valid');
    }
  });
});

describe('Ajv validation of every fixture', () => {
  for (const c of manifest.cases) {
    it(`${c.file} is ${c.expected} against ${c.schema}`, () => {
      const data = readExample(c.file);
      const ok = isValidFor(c.schema as ContractKey, data);
      expect(ok).toBe(c.expected === 'valid');
    });
  }
});

describe('typed validate/parse helpers', () => {
  it('parseRun returns the payload when valid', () => {
    const data = readExample('run-valid.json');
    const run = parseRun(data);
    expect(run.mode).toBe('agent');
    expect(run.state).toBe('running');
    expect(run.limits.max_steps).toBe(40);
  });

  it('validateRun throws ContractValidationError with schema + errors on invalid', () => {
    const bad = readExample('run-invalid-state.json');
    expect(() => {
      validateRun(bad);
    }).toThrow(ContractValidationError);
    try {
      validateRun(bad);
      throw new Error('expected validateRun to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ContractValidationError);
      const e = err as ContractValidationError;
      expect(e.schema).toBe('run');
      expect(e.errors.length).toBeGreaterThan(0);
    }
  });

  it('rejects unknown fields where additionalProperties is false', () => {
    const withExtra = { ...(readExample('summary-valid.json') as Record<string, unknown>) };
    expect(isValidFor('summary', withExtra)).toBe(true);
    withExtra.not_a_real_field = 1;
    expect(isValidFor('summary', withExtra)).toBe(false);
  });

  it('enforces string formats (uuid / date-time)', () => {
    const run = readExample('run-valid.json') as Record<string, unknown>;
    expect(isValidFor('run', run)).toBe(true);
    expect(isValidFor('run', { ...run, id: 'not-a-uuid' })).toBe(false);
    expect(isValidFor('run', { ...run, created_at: 'not-a-timestamp' })).toBe(false);
  });

  it('exposes a validator for every registered contract key', () => {
    for (const key of CONTRACT_KEYS) {
      expect(CONTRACT_SCHEMAS[key].uri).toMatch(/^https:\/\/schemas\.redai\.invalid\/v1\//);
      // Getting the validator compiles the schema; throws if the uri is wrong.
      expect(isValidFor(key, {})).toBe(false);
    }
  });
});

describe('generated enums match SPEC_LOCK.json', () => {
  const specLock = JSON.parse(readFileSync(join(repoRoot, 'SPEC_LOCK.json'), 'utf8')) as {
    approval_modes: string[];
    run_states: string[];
    attempt_states: string[];
    effect_classes: string[];
  };
  const common = JSON.parse(
    readFileSync(join(repoRoot, 'contracts', 'schemas', 'common.schema.json'), 'utf8'),
  ) as { $defs: Record<string, { enum?: string[] }> };
  const types = readFileSync(
    join(repoRoot, 'packages', 'contracts', 'src', 'generated', 'types.ts'),
    'utf8',
  );

  const pairs: [string, keyof typeof specLock][] = [
    ['ApprovalMode', 'approval_modes'],
    ['RunState', 'run_states'],
    ['AttemptState', 'attempt_states'],
    ['EffectClass', 'effect_classes'],
  ];

  for (const [def, lockKey] of pairs) {
    it(`${def} enum equals SPEC_LOCK.${lockKey} and appears in generated types`, () => {
      const schemaEnum = common.$defs[def]?.enum ?? [];
      expect(schemaEnum).toEqual(specLock[lockKey]);
      for (const value of schemaEnum) {
        // Generated types are prettier-formatted with single quotes.
        expect(types).toContain(`'${value}'`);
      }
    });
  }
});

describe('codegen drift guard', () => {
  it('committed generated output is not stale', async () => {
    const stale = await findDrift();
    expect(stale).toEqual([]);
  });
});
