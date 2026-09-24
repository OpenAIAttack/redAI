import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Login + setup smoke and responsive screenshots at the three spec breakpoints
 * (docs/03 §10: 1440×900, 1024×768, 390×844), captured in dark and light. These
 * render real components + CSS (no HTML fixtures). The authenticated shell is not
 * exercised here because it needs a live API + session; those flows are T10b.
 */
const EVIDENCE = join(__dirname, '..', '..', '..', 'release-evidence', 'T10a', 'screens');
mkdirSync(EVIDENCE, { recursive: true });

const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1024', width: 1024, height: 768 },
  { name: '390', width: 390, height: 844 },
];

test('login renders and validates required fields', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: /Đăng nhập chủ sở hữu/ })).toBeVisible();
  // Send is disabled until both fields are filled.
  const submit = page.getByRole('button', { name: /Đăng nhập/ });
  await expect(submit).toBeDisabled();
  await page.getByLabel('Tên đăng nhập').fill('owner');
  await page.locator('input[name="password"]').fill('secret-password');
  await expect(submit).toBeEnabled();
});

test('setup explains the CLI bootstrap', async ({ page }) => {
  await page.goto('/setup');
  await expect(page.getByRole('heading', { name: /Thiết lập redAI/ })).toBeVisible();
  await expect(page.getByText('redai owner bootstrap')).toBeVisible();
});

for (const vp of VIEWPORTS) {
  for (const theme of ['dark', 'light'] as const) {
    test(`login responsive ${vp.name} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.addInitScript((t) => window.localStorage.setItem('redai.theme', t), theme);
      await page.goto('/login');
      await expect(page.getByRole('heading', { name: /Đăng nhập chủ sở hữu/ })).toBeVisible();
      await page.screenshot({
        path: join(EVIDENCE, `login-${vp.name}-${theme}.png`),
        fullPage: true,
      });
    });
  }
}

test('setup responsive 390 dark', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/setup');
  await page.screenshot({ path: join(EVIDENCE, 'setup-390-dark.png'), fullPage: true });
});
