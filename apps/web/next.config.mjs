import { URL } from 'node:url';
/** API origin is operator configuration, never a browser-supplied forwarding URL. */
const apiOrigin = process.env.REDAI_API_ORIGIN ?? 'http://127.0.0.1:8787';
const url = new URL(apiOrigin);
if (
  !['http:', 'https:'].includes(url.protocol) ||
  url.username ||
  url.password ||
  url.pathname !== '/' ||
  url.search ||
  url.hash
) {
  throw new Error('REDAI_API_ORIGIN must be an HTTP(S) origin without credentials');
}
export default {
  poweredByHeader: false,
  devIndicators: false,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${url.origin}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
    ];
  },
};
