/**
 * Default tool registry (docs/07 §1, §4). The registry is the SERVER-authoritative
 * source of a tool's contract schema and effect class — the model NEVER declares its
 * own effect. Tool definitions handed to the provider carry the exact `@redai/contracts`
 * tool-input JSON-Schema, and the runtime validates a requested call against that schema
 * before it is ever a candidate for dispatch (docs/11 §6).
 *
 * This is a fixed, minimal v1 set (no `execute_anything` on the host — docs/07 §4). The
 * `target` extractors read only already-validated arguments and feed the loop-detection
 * fingerprint (docs/07 §9).
 */
import { getValidator } from '@redai/contracts';
import type { ContractKey } from '@redai/contracts';
import type { EffectClass, ToolRegistry, ToolRegistryEntry } from './ports.js';

function schemaFor(key: ContractKey): Record<string, unknown> {
  // The compiled Ajv validator carries its source schema object; hand that to the
  // provider as the tool parameters so native tool calling sees the exact contract.
  const s = getValidator(key).schema;
  return typeof s === 'object' && s !== null ? (s as Record<string, unknown>) : {};
}

function str(obj: unknown, key: string): string | null {
  if (typeof obj !== 'object' || obj === null) return null;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}

const ENTRIES: ToolRegistryEntry[] = [
  {
    name: 'http.request',
    contractKey: 'tool-input.HttpRequest',
    effectClass: 'external_read',
    description: 'Perform a single scoped HTTP request against an authorized target.',
    parameters: schemaFor('tool-input.HttpRequest'),
    target(args: unknown): string | null {
      const host = str(args, 'host');
      const scheme = str(args, 'scheme');
      if (!host) return null;
      return `${scheme ?? 'https'}://${host}`;
    },
  },
  {
    name: 'file.read',
    contractKey: 'tool-input.FileRead',
    effectClass: 'sandbox_write',
    description: 'Read a file from the run sandbox workspace.',
    parameters: schemaFor('tool-input.FileRead'),
    target(args: unknown): string | null {
      return str(args, 'path') ?? str(args, 'artifact_id');
    },
  },
  {
    name: 'terminal.execute',
    contractKey: 'tool-input.TerminalExecute',
    effectClass: 'sandbox_write',
    description: 'Execute a command inside the isolated run sandbox.',
    parameters: schemaFor('tool-input.TerminalExecute'),
    target(args: unknown): string | null {
      return str(args, 'cwd');
    },
  },
];

const BY_NAME = new Map<string, ToolRegistryEntry>(ENTRIES.map((e) => [e.name, e]));

export const DEFAULT_TOOL_REGISTRY: ToolRegistry = {
  definitions() {
    return ENTRIES.map((e) => ({
      name: e.name,
      description: e.description,
      parameters: e.parameters,
    }));
  },
  lookup(name: string): ToolRegistryEntry | undefined {
    return BY_NAME.get(name);
  },
};

/** Re-export the effect-class type for callers wiring a custom registry. */
export type { EffectClass };
