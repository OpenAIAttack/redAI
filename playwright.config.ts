import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  reporter: 'list',
  outputDir: '.local/playwright-results',
  use: { baseURL: 'http://127.0.0.1:3008', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } },
  ],
  webServer: [
    {
      command: 'pnpm exec tsx tests/browser/server.ts',
      url: 'http://127.0.0.1:8789/api/health/live',
      timeout: 60000,
      reuseExistingServer: false,
    },
    {
      command: 'pnpm --filter @redai/web exec next dev --hostname 127.0.0.1 --port 3008',
      url: 'http://127.0.0.1:3008',
      timeout: 60000,
      reuseExistingServer: false,
      env: { REDAI_API_ORIGIN: 'http://127.0.0.1:8789', NEXT_TELEMETRY_DISABLED: '1' },
    },
  ],
});
