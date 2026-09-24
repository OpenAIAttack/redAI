/**
 * Canonical registry of contract schemas exposed as typed validators.
 *
 * This is the single source of truth shared by the codegen script (which emits
 * one `validateX` / `parseX` pair per entry) and the runtime Ajv layer (which
 * resolves the `uri` to a compiled validate function). Keys are also used by the
 * `tests/contracts/contract-cases.json` manifest and by the Go parity test, so
 * they MUST stay stable across the TS and Go implementations.
 */

export const SCHEMA_BASE = 'https://schemas.redai.invalid/v1/' as const;

export interface ContractEntry {
  /** Fully-qualified Ajv schema URI (may include a JSON-pointer fragment). */
  readonly uri: string;
  /** Generated TypeScript type name (matches an export in generated/types.ts). */
  readonly type: string;
}

/**
 * Contract key -> { schema uri, generated TS type name }.
 * The key is what the contract-cases manifest and Go dispatch reference.
 */
export const CONTRACT_SCHEMAS = {
  // Top-level (root) schemas.
  run: { uri: `${SCHEMA_BASE}run.schema.json`, type: 'Run' },
  scope: { uri: `${SCHEMA_BASE}scope.schema.json`, type: 'Scope' },
  finding: { uri: `${SCHEMA_BASE}finding.schema.json`, type: 'Finding' },
  reviewer: { uri: `${SCHEMA_BASE}reviewer.schema.json`, type: 'Reviewer' },
  summary: { uri: `${SCHEMA_BASE}summary.schema.json`, type: 'Summary' },
  event: { uri: `${SCHEMA_BASE}event.schema.json`, type: 'Event' },
  'export-manifest': { uri: `${SCHEMA_BASE}export-manifest.schema.json`, type: 'ExportManifest' },

  // Tool input payloads (worker/runtime facing).
  'tool-input.HttpRequest': {
    uri: `${SCHEMA_BASE}tool-input.schema.json#/$defs/HttpRequest`,
    type: 'HttpRequest',
  },
  'tool-input.TerminalExecute': {
    uri: `${SCHEMA_BASE}tool-input.schema.json#/$defs/TerminalExecute`,
    type: 'TerminalExecute',
  },
  'tool-input.FileRead': {
    uri: `${SCHEMA_BASE}tool-input.schema.json#/$defs/FileRead`,
    type: 'FileRead',
  },
  'tool-input.FileWrite': {
    uri: `${SCHEMA_BASE}tool-input.schema.json#/$defs/FileWrite`,
    type: 'FileWrite',
  },
  'tool-input.BrowserNavigate': {
    uri: `${SCHEMA_BASE}tool-input.schema.json#/$defs/BrowserNavigate`,
    type: 'BrowserNavigate',
  },

  // Worker long-poll protocol messages.
  'worker.LeaseClaims': {
    uri: `${SCHEMA_BASE}worker.schema.json#/$defs/LeaseClaims`,
    type: 'LeaseClaims',
  },
  'worker.TaskEnvelope': {
    uri: `${SCHEMA_BASE}worker.schema.json#/$defs/TaskEnvelope`,
    type: 'TaskEnvelope',
  },
  'worker.WorkerResult': {
    uri: `${SCHEMA_BASE}worker.schema.json#/$defs/WorkerResult`,
    type: 'WorkerResult',
  },
  'worker.EnrollmentRequest': {
    uri: `${SCHEMA_BASE}worker.schema.json#/$defs/EnrollmentRequest`,
    type: 'EnrollmentRequest',
  },
  'worker.HeartbeatRequest': {
    uri: `${SCHEMA_BASE}worker.schema.json#/$defs/HeartbeatRequest`,
    type: 'HeartbeatRequest',
  },

  // Core public API resources.
  'api.Project': { uri: `${SCHEMA_BASE}api.schema.json#/$defs/Project`, type: 'Project' },
  'api.RunCreate': { uri: `${SCHEMA_BASE}api.schema.json#/$defs/RunCreate`, type: 'RunCreate' },
  'api.Snapshot': { uri: `${SCHEMA_BASE}api.schema.json#/$defs/Snapshot`, type: 'Snapshot' },
  'api.Message': { uri: `${SCHEMA_BASE}api.schema.json#/$defs/Message`, type: 'Message' },
  'api.Approval': { uri: `${SCHEMA_BASE}api.schema.json#/$defs/Approval`, type: 'Approval' },
} as const satisfies Record<string, ContractEntry>;

export type ContractKey = keyof typeof CONTRACT_SCHEMAS;

export const CONTRACT_KEYS = Object.keys(CONTRACT_SCHEMAS) as ContractKey[];
