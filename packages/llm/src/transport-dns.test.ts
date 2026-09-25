import { describe, expect, it, vi } from 'vitest';
const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns', () => ({ lookup }));
import { createProviderTransport } from './transport.js';

describe('provider DNS safety', () => {
  it.each(
    [
      [{ address: '127.0.0.1', family: 4 }],
      [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ],
      [],
    ].map((addresses) => ({ addresses })),
  )('rejects private/mixed/empty resolution before connection %#', async ({ addresses }) => {
    lookup.mockImplementation((_host, _options, callback) => callback(null, addresses));
    await expect(
      createProviderTransport('https://model.example/v1', [])(
        'https://model.example/v1/chat/completions',
        { method: 'POST', body: '{}' },
      ),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    expect(lookup).toHaveBeenLastCalledWith(
      'model.example',
      { family: 4, all: true },
      expect.any(Function),
    );
  });
  it('aborts while DNS resolution is stalled', async () => {
    lookup.mockImplementation(() => {});
    const controller = new AbortController();
    const pending = createProviderTransport('https://model.example/v1', [])(
      'https://model.example/v1/chat/completions',
      { method: 'POST', body: '{}', signal: controller.signal },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
