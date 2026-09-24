import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the web smoke/responsive checks. Deliberately NOT part of
 * `pnpm run test` (the default Vitest run stays fast and browserless); run it with
 * `pnpm --filter @redai/web run test:e2e`. Chromium is preinstalled at
 * PLAYWRIGHT_BROWSERS_PATH (do not run `playwright install`). The web server is a
 * production `next start` on an offline build.
 */
const PORT = Number(process.env.PORT ?? 3123);

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  reporter: [['list'], ['json', { outputFile: 'e2e/results.json' }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `next start -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
