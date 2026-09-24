/**
 * Next.js config for @redai/web.
 *
 * Constraints baked in:
 *  - Offline, reproducible build: no remote `next/font`, no image optimization
 *    service, telemetry disabled. All fonts are system fonts (see globals.css).
 *  - `@redai/ui` is a workspace package consumed as compiled output; it is listed
 *    in `transpilePackages` so its source stays type-checked with the app.
 *  - Security headers approximate the production CSP posture (docs/13 §6). The
 *    reverse proxy owns the authoritative CSP in deployment; these are a safe
 *    baseline so the dev/build surface is never laxer than production intent.
 *  - `NEXT_PUBLIC_API_BASE_URL` (optional) points the browser at the API origin.
 *    Default is same-origin ('' ), which keeps the session cookie + CSRF
 *    double-submit working behind a single reverse proxy.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@redai/ui'],
  images: { unoptimized: true },
  // The app's own TypeScript is the web typecheck (run in `pnpm run check` via the
  // build). ESLint is not wired here to keep the build offline and deterministic;
  // linting for the repo runs through the root pipeline.
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // Next injects small inline bootstrap scripts/styles; keep them same-origin.
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self'",
              "connect-src 'self'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
