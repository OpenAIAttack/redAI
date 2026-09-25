import { describe, expect, it } from 'vitest';
import { createProviderTransport, publicV4 } from './transport.js';
describe('provider network boundary', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '198.18.0.1',
    '::1',
    '::ffff:127.0.0.1',
  ])('denies special address %s', (ip) => expect(publicV4(ip)).toBe(false));
  it('permits a public IPv4 address', () => expect(publicV4('8.8.8.8')).toBe(true));
  it('rejects ambient URLs and nonapproved loopback before connecting', async () => {
    const transport = createProviderTransport('https://127.0.0.1/v1', []);
    await expect(
      transport('https://127.0.0.1/v1/chat/completions', { method: 'POST', body: '{}' }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(
      transport('https://other.example/chat/completions', { method: 'POST', body: '{}' }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
  });
});

// Real sockets are exercised by the DB probe test; DNS rebinding is deterministic here.
