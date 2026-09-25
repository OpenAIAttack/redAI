import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { originAllowed } from './origin.js';
describe('owner origin boundary', () => {
  it.each([
    ['http://localhost', true],
    ['https://localhost', false],
    ['ftp://localhost', false],
    ['http://localhost/evil', false],
    ['null', false],
    ['http://evil.test', false],
    ['http://localhost:3000', true],
  ])('checks complete origin %s', async (origin, allowed) => {
    const app = Fastify();
    app.post('/', async (req) => ({
      allowed: originAllowed(req, {
        cookieSecure: false,
        allowedOrigins: ['http://localhost:3000'],
      }),
    }));
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/',
        headers: { origin, host: 'localhost' },
      });
      expect(res.json().allowed).toBe(allowed);
    } finally {
      await app.close();
    }
  });
});
