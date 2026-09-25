import {
  ProviderError,
  CompatibleAdapter,
  createProviderTransport,
  probeCapabilities,
  type CompatibleConfig,
  type ProbeAdapter,
  type ProbeResult,
  type DataMode,
} from '@redai/llm';
import type { SettingsService } from './service.js';
import type { ProbeIdentity, ProbeStore } from './probeStore.js';
import { InvalidSettingsError, RevisionConflictError, isSettingsError } from './errors.js';

export interface ProviderProbeDeps {
  settings: SettingsService;
  store: ProbeStore;
  /** Installation-owned exact local endpoint allowlist, not request/model input. */
  approvedLocalBaseUrls: readonly string[];
  adapterFactory?: (config: CompatibleConfig) => ProbeAdapter;
  now?: () => Date;
}
export class ProviderProbeService {
  constructor(private readonly deps: ProviderProbeDeps) {}
  async probe(input: ProbeIdentity): Promise<ProbeResult> {
    if (
      input.confirmed !== true ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1
    )
      throw new InvalidSettingsError('Explicit confirmation and config revision are required.');
    const saved = await this.deps.store.claim(input);
    if (saved) return saved;
    let result: ProbeResult;
    try {
      const row = await this.deps.settings.getProviderConfig(input.workspaceId, input.id);
      if (row.revision !== input.expectedRevision)
        throw new RevisionConflictError(input.expectedRevision, row.revision);
      const c = row.config;
      if (
        !row.enabled ||
        c.adapter_kind !== 'chat_completions_compatible' ||
        typeof c.base_url !== 'string' ||
        typeof c.model_id !== 'string' ||
        !Number.isSafeInteger(c.max_output_tokens) ||
        Number(c.max_output_tokens) < 1 ||
        !Array.isArray(c.allowed_data_modes) ||
        !c.allowed_data_modes.length
      )
        throw new InvalidSettingsError('Provider must have a complete compatible config.');
      const modes = c.allowed_data_modes.filter(
        (m): m is DataMode => m === 'local_only' || m === 'redacted_cloud' || m === 'cloud_full',
      );
      if (modes.length !== c.allowed_data_modes.length)
        throw new InvalidSettingsError('Invalid provider data modes.');
      const apiKey = row.credential_ref
        ? await this.deps.settings.resolveCredential({
            workspaceId: input.workspaceId,
            secretId: row.credential_ref,
            origin: new URL(c.base_url).origin,
          })
        : undefined;
      const config: CompatibleConfig = {
        baseUrl: c.base_url,
        modelId: c.model_id,
        ...(apiKey ? { apiKey } : {}),
        allowedDataModes: modes,
        approvedLocalBaseUrls: this.deps.approvedLocalBaseUrls,
        toolsVerified: true,
        maxOutputTokens: Number(c.max_output_tokens),
        timeoutMs: 5000,
        maxResponseBytes: 65536,
      };
      // toolsVerified applies solely to this synthetic probe, never a runtime Agent.
      const adapter = this.deps.adapterFactory
        ? this.deps.adapterFactory(config)
        : new CompatibleAdapter(
            config,
            createProviderTransport(config.baseUrl, config.approvedLocalBaseUrls),
          );
      const checkLive = async () => {
        const current = await this.deps.settings.getProviderConfig(input.workspaceId, input.id);
        if (current.revision !== input.expectedRevision || !current.enabled)
          throw new InvalidSettingsError('Provider changed during probe.');
        if (current.credential_ref)
          await this.deps.settings.resolveCredential({
            workspaceId: input.workspaceId,
            secretId: current.credential_ref,
            origin: new URL(config.baseUrl).origin,
          });
      };
      const guarded: ProbeAdapter = {
        complete: async (request, signal) => {
          await checkLive();
          return adapter.complete(request, signal);
        },
        stream: async (request, emit, signal) => {
          await checkLive();
          return adapter.stream(request, emit, signal);
        },
      };
      result = await probeCapabilities(
        guarded,
        modes[0]!,
        (this.deps.now ?? (() => new Date()))(),
        config.maxOutputTokens,
      );
    } catch (error) {
      result = {
        status: 'failed',
        supports_tools: false,
        supports_streaming: false,
        supports_structured_output: false,
        usage_observed: false,
        cancellation_observed: false,
        error_code:
          isSettingsError(error) || error instanceof ProviderError ? error.code : 'PROBE_FAILED',
        checked_at: (this.deps.now ?? (() => new Date()))().toISOString(),
      };
    }
    await this.deps.store.finish(input, result);
    return result;
  }
}
