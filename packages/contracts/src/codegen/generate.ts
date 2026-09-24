/**
 * Contract type + schema codegen.
 *
 * Reads the canonical JSON Schemas under `contracts/schemas/`, then emits three
 * generated modules into `packages/contracts/src/generated/`:
 *
 *   - `types.ts`      TypeScript types (via json-schema-to-typescript) built
 *                     from a single bundle whose cross-file `$ref`s are rewritten
 *                     to internal `#/$defs/*` pointers.
 *   - `schemas.ts`    The canonical schemas inlined verbatim (with original
 *                     `$id`s and refs) so the Ajv layer can resolve refs by id.
 *   - `validators.ts` One typed `validateX` / `parseX` pair per registry entry.
 *
 * Run with no args to (re)write the generated output. Run with `--check` to
 * regenerate in-memory and fail (exit 1) if the committed output is stale — this
 * is the CI drift guard. Generation is deterministic and idempotent.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compile } from 'json-schema-to-typescript';
import prettier from 'prettier';

import { CONTRACT_SCHEMAS } from '../registry.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..', '..');
const repoRoot = resolve(packageRoot, '..', '..');
const schemasDir = join(repoRoot, 'contracts', 'schemas');
const generatedDir = join(packageRoot, 'src', 'generated');

/** Canonical schema files in a stable, dependency-friendly order. */
const SCHEMA_FILES = [
  'common.schema.json',
  'api.schema.json',
  'run.schema.json',
  'scope.schema.json',
  'finding.schema.json',
  'reviewer.schema.json',
  'summary.schema.json',
  'event.schema.json',
  'export-manifest.schema.json',
  'tool-input.schema.json',
  'worker.schema.json',
] as const;

/** Whole-file `$ref` targets -> the bundle `$defs` name they collapse into. */
const ROOT_SCHEMA_DEFS: Record<string, string> = {
  'run.schema.json': 'Run',
  'scope.schema.json': 'Scope',
  'finding.schema.json': 'Finding',
  'reviewer.schema.json': 'Reviewer',
  'summary.schema.json': 'Summary',
  'event.schema.json': 'Event',
  'export-manifest.schema.json': 'ExportManifest',
};

/** camelCase export name for an inlined schema const (common -> commonSchema). */
function schemaConstName(file: string): string {
  const base = file.replace(/\.schema\.json$/, '');
  const camel = base.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
  return `${camel}Schema`;
}

type Json = unknown;

/** Rewrite every `$ref` in the tree from cross-file to internal bundle refs. */
function rewriteRefs(node: Json): Json {
  if (Array.isArray(node)) {
    return node.map(rewriteRefs);
  }
  if (node && typeof node === 'object') {
    const out: Record<string, Json> = {};
    for (const [key, value] of Object.entries(node as Record<string, Json>)) {
      if (key === '$ref' && typeof value === 'string') {
        out[key] = rewriteRef(value);
      } else {
        out[key] = rewriteRefs(value);
      }
    }
    return out;
  }
  return node;
}

function rewriteRef(ref: string): string {
  if (ref.startsWith('#')) return ref;
  const [file, fragment] = ref.split('#');
  if (fragment) {
    // e.g. common.schema.json#/$defs/UUID -> #/$defs/UUID
    return `#${fragment}`;
  }
  const rootName = ROOT_SCHEMA_DEFS[file];
  if (!rootName) {
    throw new Error(`unexpected whole-file $ref with no root mapping: ${ref}`);
  }
  return `#/$defs/${rootName}`;
}

interface LoadedSchema {
  file: string;
  raw: string;
  parsed: Record<string, Json>;
}

function loadSchemas(): LoadedSchema[] {
  const present = new Set(readdirSync(schemasDir).filter((f) => f.endsWith('.schema.json')));
  for (const f of SCHEMA_FILES) {
    if (!present.has(f)) throw new Error(`missing canonical schema: ${f}`);
  }
  if (present.size !== SCHEMA_FILES.length) {
    throw new Error(
      `schema set drift: dir has ${present.size} schemas, codegen knows ${SCHEMA_FILES.length}`,
    );
  }
  return SCHEMA_FILES.map((file) => {
    const raw = readFileSync(join(schemasDir, file), 'utf8');
    return { file, raw, parsed: JSON.parse(raw) as Record<string, Json> };
  });
}

/** Build the single bundle schema that json-schema-to-typescript consumes. */
function buildBundle(schemas: LoadedSchema[]): Record<string, Json> {
  const defs: Record<string, Json> = {};
  const put = (name: string, node: Json): void => {
    if (name in defs) throw new Error(`duplicate bundle def name: ${name}`);
    defs[name] = rewriteRefs(node);
  };

  for (const { file, parsed } of schemas) {
    const localDefs = (parsed.$defs ?? {}) as Record<string, Json>;
    for (const [name, node] of Object.entries(localDefs)) {
      put(name, node);
    }
    const rootName = ROOT_SCHEMA_DEFS[file];
    if (rootName) {
      const { $schema: _s, $id: _i, title: _t, $defs: _d, ...rootBody } = parsed;
      put(rootName, rootBody);
    }
  }

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://schemas.redai.invalid/v1/contracts.bundle.json',
    title: 'RedaiContracts',
    type: 'object',
    additionalProperties: false,
    $defs: defs,
  };
}

const BANNER = [
  '/**',
  ' * AUTO-GENERATED by packages/contracts/src/codegen/generate.ts — DO NOT EDIT.',
  ' * Source of truth: contracts/schemas/*.schema.json. Run `pnpm --filter',
  ' * @redai/contracts run codegen` to regenerate.',
  ' */',
  '',
].join('\n');

async function format(source: string, parser: 'typescript'): Promise<string> {
  // Resolve the repo prettier config against a real file path inside the package
  // so the generated output matches what `prettier --write` would produce.
  const options = await prettier.resolveConfig(join(generatedDir, 'types.ts'));
  return prettier.format(source, { ...(options ?? {}), parser });
}

async function buildTypesModule(schemas: LoadedSchema[]): Promise<string> {
  const bundle = buildBundle(schemas);
  const compiled = await compile(bundle as never, 'RedaiContracts', {
    additionalProperties: false,
    bannerComment: '',
    format: false,
    declareExternallyReferenced: true,
    unreachableDefinitions: true,
    enableConstEnums: false,
  });
  // Generated shapes include `{}` object types from `{type:object}` schemas;
  // eslint's no-empty-object-type rule flags those, so the whole module opts out.
  return format(`${BANNER}/* eslint-disable */\n${compiled}`, 'typescript');
}

async function buildSchemasModule(schemas: LoadedSchema[]): Promise<string> {
  const lines: string[] = [
    BANNER,
    '// Canonical schemas inlined verbatim (original $id + $ref) for Ajv.',
    '',
  ];
  const names: string[] = [];
  for (const { file, parsed } of schemas) {
    const name = schemaConstName(file);
    names.push(name);
    lines.push(
      `export const ${name}: Record<string, unknown> = ${JSON.stringify(parsed)};`,
      '',
    );
  }
  lines.push(
    'export const allSchemas: readonly Record<string, unknown>[] = [',
    ...names.map((n) => `  ${n},`),
    '];',
    '',
  );
  return format(lines.join('\n'), 'typescript');
}

async function buildValidatorsModule(): Promise<string> {
  const entries = Object.entries(CONTRACT_SCHEMAS);
  const typeNames = [...new Set(entries.map(([, v]) => v.type))].sort();
  const lines: string[] = [
    BANNER,
    `import type {`,
    ...typeNames.map((t) => `  ${t},`),
    `} from './types.js';`,
    `import { assertValidFor } from '../validate.js';`,
    '',
  ];
  for (const [key, { type }] of entries) {
    const fn = `validate${type}`;
    const parse = `parse${type}`;
    lines.push(
      `/** Assert \`data\` is a valid ${type} (contract key: ${key}). */`,
      `export function ${fn}(data: unknown): asserts data is ${type} {`,
      `  assertValidFor(${JSON.stringify(key)}, data);`,
      `}`,
      `/** Validate and return \`data\` typed as ${type}, or throw. */`,
      `export function ${parse}(data: unknown): ${type} {`,
      `  ${fn}(data);`,
      `  return data;`,
      `}`,
      '',
    );
  }
  return format(lines.join('\n'), 'typescript');
}

/** Regenerate every output module in-memory (filename -> formatted content). */
export async function buildOutputs(): Promise<Map<string, string>> {
  const schemas = loadSchemas();
  const outputs = new Map<string, string>();
  outputs.set('types.ts', await buildTypesModule(schemas));
  outputs.set('schemas.ts', await buildSchemasModule(schemas));
  outputs.set('validators.ts', await buildValidatorsModule());
  return outputs;
}

/** Absolute path of the generated output directory. */
export const GENERATED_DIR = generatedDir;

/** Compare freshly generated output against disk. Returns the stale filenames. */
export async function findDrift(): Promise<string[]> {
  const outputs = await buildOutputs();
  const stale: string[] = [];
  for (const [name, content] of outputs) {
    let current = '';
    try {
      current = readFileSync(join(generatedDir, name), 'utf8');
    } catch {
      current = '';
    }
    if (current !== content) stale.push(name);
  }
  return stale;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const outputs = await buildOutputs();
  let stale = 0;
  for (const [name, content] of outputs) {
    const path = join(generatedDir, name);
    if (check) {
      let current = '';
      try {
        current = readFileSync(path, 'utf8');
      } catch {
        current = '';
      }
      if (current !== content) {
        stale += 1;
        process.stderr.write(`DRIFT: ${name} is stale (regenerate with codegen)\n`);
      }
    } else {
      writeFileSync(path, content);
      process.stdout.write(`wrote src/generated/${name}\n`);
    }
  }
  if (check) {
    if (stale > 0) {
      process.stderr.write(`codegen drift check FAILED: ${stale} file(s) stale\n`);
      process.exit(1);
    }
    process.stdout.write('codegen drift check OK: generated output is current\n');
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    process.stderr.write(`${String(err instanceof Error ? err.stack : err)}\n`);
    process.exit(1);
  });
}
