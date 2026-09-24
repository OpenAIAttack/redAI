/**
 * Production {@link ProviderResolver}: composes a T08 model provider for a run from
 * the run's provider config + the T05 `resolveCredential` key. The runtime wires this
 * (the unit tests inject a resolver returning the labelled mock instead).
 *
 * Data-mode routing lives in T08 (`selectProvider`): this resolver hands back the
 * candidate plus its `allowedDataModes`/`isLocalEndpoint`, and the service's
 * `selectProvider` makes the binding decision BEFORE any call, so a `local_only` run
 * never reaches a cloud endpoint. The resolved key is used only to build the provider
 * (the adapter puts it in the auth header) and is never logged or checkpointed.
 */
import { OpenAiCompatibleProvider } from '@redai/llm';
import type { DataMode, ProviderCandidate } from '@redai/llm';
import { ProviderConfigNotFoundError } from './errors.js';
import type { ProviderResolver, RunRecord } from './ports.js';

/** Minimal read port onto a provider config (subset of T05 `ProviderConfigView`). */
export interface ProviderConfigReader {
  get(
    workspaceId: string,
    id: string,
  ): Promise<{
    displayName: string;
    config: Record<string, unknown>;
    credentialRef: string | null;
    enabled: boolean;
  } | null>;
}

/** Resolves a secret to plaintext (T05 `resolveCredential` trusted-executor path). */
export interface CredentialResolver {
  resolve(input: {
    workspaceId: string;
    secretId: string;
    projectId?: string | null;
    origin?: string;
  }): Promise<string>;
}

export interface ProviderResolverDeps {
  configs: ProviderConfigReader;
  credentials: CredentialResolver;
  /** Injected fetch for the cloud adapter (defaults to global fetch). */
  fetch?: typeof globalThis.fetch;
}

function readString(obj: Record<string, unknown>, key: string, fallback = ''): string {
  const v = obj[key];
  return typeof v === 'string' ? v : fallback;
}

function readDataModes(obj: Record<string, unknown>): DataMode[] {
  const v = obj['allowed_data_modes'];
  if (!Array.isArray(v)) return ['redacted_cloud', 'cloud_full'];
  const modes = v.filter(
    (x): x is DataMode => x === 'local_only' || x === 'redacted_cloud' || x === 'cloud_full',
  );
  return modes.length > 0 ? modes : ['redacted_cloud', 'cloud_full'];
}

export function createProviderResolver(deps: ProviderResolverDeps): ProviderResolver {
  return {
    async resolve(run: RunRecord) {
      const cfg = await deps.configs.get(run.workspaceId, run.providerConfigId);
      if (!cfg || !cfg.enabled) throw new ProviderConfigNotFoundError();

      const dataMode =
        (run.configSnapshot['data_mode'] as DataMode | undefined) ?? 'redacted_cloud';
      const baseUrl = readString(cfg.config, 'base_url');
      const model = readString(cfg.config, 'model_id', 'default');
      const isLocalEndpoint = cfg.config['is_local_endpoint'] === true;
      const allowedDataModes = readDataModes(cfg.config);

      let apiKey: string | undefined;
      if (cfg.credentialRef) {
        apiKey = await deps.credentials.resolve({
          workspaceId: run.workspaceId,
          secretId: cfg.credentialRef,
          projectId: run.projectId,
          ...(baseUrl ? { origin: baseUrl } : {}),
        });
      }

      const provider = new OpenAiCompatibleProvider({
        baseUrl,
        model,
        label: cfg.displayName,
        ...(apiKey !== undefined ? { apiKey } : {}),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });

      const candidate: ProviderCandidate = {
        provider,
        allowedDataModes,
        isLocalEndpoint,
      };
      return { candidates: [candidate], dataMode };
    },
  };
}
