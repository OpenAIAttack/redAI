import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerSettings, type SettingsServicePort } from './plugin.js';
import { parseProbeRequest, parseProbeResult } from '@redai/contracts';

const id = '11111111-1111-4111-8111-111111111111';
const key = '22222222-2222-4222-8222-222222222222';
const payload = { confirmed: true, expected_revision: 1 };
const result = {
  status: 'passed',
  supports_tools: true,
  supports_streaming: true,
  supports_structured_output: true,
  usage_observed: false,
  cancellation_observed: true,
  error_code: null,
  checked_at: new Date().toISOString(),
};
function fixture() {
  const app = Fastify({ logger: false });
  const probe = vi.fn().mockResolvedValue(result);
  registerSettings(app, {
    service: {} as SettingsServicePort,
    ownerAuth: {
      authenticate: async (req) =>
        req.headers['x-owner'] ? { ownerId: id, workspaceId: id } : null,
      authorizeMutation: (req) => req.headers['x-csrf'] === 'ok',
    },
    probeService: { probe },
  });
  return { app, probe };
}
describe('owner provider probe API', () => {
  it.each([
    { headers: {}, body: payload, status: 401 },
    { headers: { authorization: 'Bearer worker' }, body: payload, status: 401 },
    { headers: { 'x-owner': '1' }, body: payload, status: 403 },
    { headers: { 'x-owner': '1', 'x-csrf': 'ok' }, body: payload, status: 422 },
    {
      headers: { 'x-owner': '1', 'x-csrf': 'ok', 'idempotency-key': key },
      body: { ...payload, confirmed: false },
      status: 422,
    },
    {
      headers: { 'x-owner': '1', 'x-csrf': 'ok', 'idempotency-key': key },
      body: { ...payload, base_url: 'https://evil.example' },
      status: 422,
    },
  ])('rejects unauthorized or invalid input %#', async ({ headers, body, status }) => {
    const { app, probe } = fixture();
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/providers/${id}/probe`,
        headers,
        payload: body,
      });
      expect(res.statusCode).toBe(status);
      expect(probe).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('uses authenticated workspace and canonical request/response schemas', async () => {
    const { app, probe } = fixture();
    try {
      expect(parseProbeRequest(payload)).toEqual(payload);
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/providers/${id}/probe`,
        headers: { 'x-owner': '1', 'x-csrf': 'ok', 'idempotency-key': key },
        payload,
      });
      expect(res.statusCode).toBe(200);
      expect(parseProbeResult(res.json())).toEqual(result);
      expect(probe).toHaveBeenCalledWith({
        id,
        workspaceId: id,
        ownerId: id,
        expectedRevision: 1,
        idempotencyKey: key,
        confirmed: true,
      });
    } finally {
      await app.close();
    }
  });
  it('reports pending idempotency and mismatches as conflicts', async () => {
    const { app, probe } = fixture();
    try {
      for (const code of ['PROBE_IN_PROGRESS', 'IDEMPOTENCY_CONFLICT']) {
        probe.mockRejectedValueOnce(
          Object.assign(new Error('safe'), { code, isSettingsError: true }),
        );
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/providers/${id}/probe`,
          headers: { 'x-owner': '1', 'x-csrf': 'ok', 'idempotency-key': key },
          payload,
        });
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe(code);
      }
    } finally {
      await app.close();
    }
  });
});
