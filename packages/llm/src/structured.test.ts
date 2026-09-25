import { describe, expect, it, vi } from 'vitest';
import { CompatibleAdapter, type CompatibleConfig, type ModelRequest } from './index.js';
const config: CompatibleConfig = {
  baseUrl: 'https://model.example/v1',
  modelId: 'synthetic',
  allowedDataModes: ['redacted_cloud'],
  approvedLocalBaseUrls: [],
  toolsVerified: false,
  maxOutputTokens: 128,
  maxResponseBytes: 4096,
  timeoutMs: 500,
};
const request: ModelRequest = {
  messages: [{ role: 'user', content: 'synthetic' }],
  maxOutputTokens: 64,
  dataMode: 'redacted_cloud',
  structuredOutput: {
    name: 'probe',
    schema: {
      type: 'object',
      properties: { ok: { const: true } },
      required: ['ok'],
      additionalProperties: false,
    },
    validate: (value) => JSON.stringify(value) === '{"ok":true}',
  },
};
describe('strict structured provider output', () => {
  it.each(['not json', '{}', '{"ok":false}', '{"ok":true,"extra":1}'])(
    'rejects schema-invalid output %s',
    async (content) => {
      const transport = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          }),
        ),
      );
      await expect(
        new CompatibleAdapter(config, transport).complete(request),
      ).rejects.toMatchObject({ code: 'invalid_response' });
    },
  );
  it('sends only the declared response format and accepts valid JSON', async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '{"ok":true}' },
              finish_reason: 'stop',
            },
          ],
        }),
      ),
    );
    expect((await new CompatibleAdapter(config, transport).complete(request)).text).toBe(
      '{"ok":true}',
    );
    expect(JSON.parse(String(transport.mock.calls[0]![1]!.body)).response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'probe', strict: true, schema: request.structuredOutput!.schema },
    });
    expect(transport.mock.calls[0]![1]!.body).not.toContain('validate');
  });
});
