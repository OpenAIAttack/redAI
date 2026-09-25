import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, HAS_DB, insertBaseGraph, type TestDatabase } from './support.js';
import { SettingsService, StaticMasterKeyProvider, createDbSettingsRepository, createDbProbeStore, ProviderProbeService } from '../../../packages/application/src/settings/index.js';
import { ProviderError, createProviderTransport, type ProbeResult } from '../../../packages/llm/src/index.js';

const result: ProbeResult = { status: 'passed', supports_tools: true, supports_streaming: true, supports_structured_output: true, cancellation_observed: true, usage_observed: false, error_code: null, checked_at: new Date().toISOString() };
describe.skipIf(!HAS_DB)('durable provider probes', () => {
  let db: TestDatabase;
  let ws: string;
  let settings: SettingsService;
  const owner = randomUUID();
  beforeAll(async () => {
    db = await createTestDatabase();
    ws = (await insertBaseGraph(db.pool)).workspaceId;
    settings = new SettingsService({ repo: createDbSettingsRepository(db.pool), masterKeys: new StaticMasterKeyProvider(Buffer.alloc(32, 8)) });
  });
  afterAll(async () => db?.drop());
  async function fixture(base = 'https://model.example/v1') {
    const provider = await settings.createProviderConfig({ workspaceId: ws, displayName: 'synthetic', apiKey: 'PROBE_KEY_CANARY', config: { adapter_kind: 'chat_completions_compatible', base_url: base, model_id: 'synthetic', max_output_tokens: 128, allowed_data_modes: ['redacted_cloud'] } });
    const input = { workspaceId: ws, ownerId: owner, id: provider.id, expectedRevision: provider.revision, idempotencyKey: randomUUID(), confirmed: true as const };
    return { provider, input, store: createDbProbeStore(db.pool) };
  }
  it('serializes concurrent keys and durably replays completed responses', async () => {
    const { input, store } = await fixture();
    const attempts = await Promise.allSettled([store.claim(input), store.claim(input)]);
    expect(attempts.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(r => r.status === 'rejected')).toHaveLength(1);
    await expect(store.claim({ ...input, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'PROBE_IN_PROGRESS' });
    await store.finish(input, result);
    expect(await createDbProbeStore(db.pool).claim(input)).toEqual(result);
    expect((await settings.getProviderConfig(ws, input.id)).probe_result).toEqual(result);
    await expect(store.claim({ ...input, expectedRevision: 2 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const saved = await db.pool.query('SELECT response_json FROM idempotency_keys WHERE idempotency_key=$1', [input.idempotencyKey]);
    expect(JSON.stringify(saved.rows)).not.toContain('PROBE_KEY_CANARY');
  });
  it('does not replay an unresolved request after its deadline or restart', async () => {
    const { input, store } = await fixture();
    await store.claim(input);
    await db.pool.query("UPDATE idempotency_keys SET expires_at=now()-interval '1 minute' WHERE idempotency_key=$1", [input.idempotencyKey]);
    await expect(createDbProbeStore(db.pool).claim(input)).rejects.toMatchObject({ code: 'PROBE_IN_PROGRESS' });
  });
  it('fences a late completion after an explicitly requested replacement probe', async () => {
    const { input, store } = await fixture();
    await store.claim(input);
    await db.pool.query("UPDATE idempotency_keys SET expires_at=now()-interval '1 minute' WHERE idempotency_key=$1", [input.idempotencyKey]);
    const next = { ...input, idempotencyKey: randomUUID() };
    await store.claim(next);
    const failed = { ...result, status: 'failed' as const, supports_tools: false, error_code: 'timeout' };
    await store.finish(next, failed);
    await store.finish(input, result);
    expect((await settings.getProviderConfig(ws, input.id)).probe_result).toEqual(failed);
    expect(await store.claim(input)).toEqual(result);
  });
  it('stale/duplicate completion cannot validate a changed config', async () => {
    const { input, store } = await fixture();
    await store.claim(input);
    await settings.updateProviderConfig({ workspaceId: ws, id: input.id, expectedRevision: 1, displayName: 'changed' });
    await store.finish(input, result);
    await store.finish(input, result);
    expect(await settings.getProviderConfig(ws, input.id)).toMatchObject({ revision: 2, probe_status: 'not_tested', probe_result: null });
  });
  it('edits invalidate existing evidence and revoked keys cannot become verified', async () => {
    const { input, provider, store } = await fixture();
    await store.claim(input); await store.finish(input, result);
    await settings.updateProviderConfig({ workspaceId: ws, id: input.id, expectedRevision: 1, enabled: true });
    expect((await settings.getProviderConfig(ws, input.id)).probe_result).toBeNull();
    const next = { ...input, expectedRevision: 2, idempotencyKey: randomUUID() };
    await store.claim(next);
    await settings.revokeSecret(ws, provider.credential_ref!);
    await store.finish(next, result);
    expect((await settings.getProviderConfig(ws, input.id)).probe_status).toBe('not_tested');
  });
  it('rejects missing confirmation, stale revision, and wrong workspace before network', async () => {
    const { input, store } = await fixture();
    const factory = vi.fn();
    const service = new ProviderProbeService({ settings, store, approvedLocalBaseUrls: [], adapterFactory: factory });
    await expect(service.probe({ ...input, confirmed: false as true })).rejects.toMatchObject({ code: 'INVALID_SETTINGS' });
    await expect(service.probe({ ...input, expectedRevision: 9 })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await expect(service.probe({ ...input, workspaceId: randomUUID() })).rejects.toMatchObject({ code: 'PROVIDER_CONFIG_NOT_FOUND' });
    expect(factory).not.toHaveBeenCalled();
  });
  it('executes fixed synthetic requests through real local HTTP, persists and replays', async () => {
    let hits = 0;
    const bodies: string[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += String(chunk); });
      req.on('end', () => {
        hits++; bodies.push(body);
        expect(req.headers.authorization).toBe('Bearer PROBE_KEY_CANARY');
        const value = JSON.parse(body);
        if (value.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'redai_probe_ok' }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
        } else {
          const tools = value.tools ? [{ id: 'probe', type: 'function', function: { name: 'redai_probe', arguments: '{"ok":true}' } }] : undefined;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: tools ? 'tool_calls' : 'stop', message: { role: 'assistant', content: tools ? null : value.response_format ? '{"ok":true}' : 'redai_probe_ok', ...(tools ? { tool_calls: tools } : {}) } }] }));
        }
      });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('address');
    const base = `http://localhost:${address.port}/v1`;
    try {
      await expect(createProviderTransport(base, [])(`${base}/chat/completions`, { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'policy_denied' });
      expect(hits).toBe(0);
      const { input, store } = await fixture(base);
      const service = new ProviderProbeService({ settings, store, approvedLocalBaseUrls: [base] });
      const checked = await service.probe(input);
      expect(checked).toMatchObject({ status: 'passed', supports_tools: true, supports_streaming: true, supports_structured_output: true, cancellation_observed: true, usage_observed: false });
      expect(hits).toBe(5);
      expect(await service.probe(input)).toEqual(checked); expect(hits).toBe(5);
      expect(bodies.join('')).not.toContain('PROBE_KEY_CANARY');
      expect(bodies.every(body => body.toLowerCase().includes('synthetic'))).toBe(true);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('rechecks credential revocation before each synthetic request', async () => {
    const { input, store, provider } = await fixture();
    const complete = vi.fn(async () => {
      await settings.revokeSecret(ws, provider.credential_ref!);
      return { text: 'redai_probe_ok', refusal: null, toolCalls: [], finishReason: 'stop' as const, usage: { state: 'unknown' as const } };
    });
    const stream = vi.fn();
    const service = new ProviderProbeService({ settings, store, approvedLocalBaseUrls: [], adapterFactory: () => ({ complete, stream }) });
    expect(await service.probe(input)).toMatchObject({ status: 'failed', supports_tools: false });
    expect(complete).toHaveBeenCalledTimes(1); expect(stream).not.toHaveBeenCalled();
  });
  it('provider errors are safe and persisted without raw error content', async () => {
    const { input, store } = await fixture();
    const service = new ProviderProbeService({ settings, store, approvedLocalBaseUrls: [], adapterFactory: () => ({ complete: async () => { throw new Error('ERROR_SECRET_CANARY'); }, stream: async () => { throw new ProviderError('network_error', 'possibly_sent'); } }) });
    const checked = await service.probe(input);
    expect(checked).toMatchObject({ status: 'failed', error_code: 'provider_error' });
    expect(JSON.stringify(await settings.getProviderConfig(ws, input.id))).not.toContain('ERROR_SECRET_CANARY');
  });
});
