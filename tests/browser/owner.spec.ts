import { test, expect } from '@playwright/test';

test('owner login, projects, notes, vault settings and logout persist through reload', async ({
  page,
}, testInfo) => {
  const suffix = testInfo.project.name;
  await page.goto('/setup');
  await expect(page.getByRole('heading', { name: 'Thiết lập chủ sở hữu' })).toBeVisible();
  await page.getByLabel('Tên đăng nhập', { exact: true }).fill('browser-owner');
  await page.getByLabel('Mật khẩu', { exact: true }).fill('incorrect-test-password');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Mật khẩu', { exact: true }).fill('synthetic-browser-password');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dự án của bạn' })).toBeVisible();
  await page.getByText('Tạo dự án', { exact: true }).first().click();
  await page.getByLabel('Tên dự án', { exact: true }).fill(`Dự án ${suffix}`);
  await page.getByLabel('Mô tả', { exact: true }).fill('Synthetic browser fixture');
  await page.getByRole('button', { name: 'Tạo dự án', exact: true }).click();
  await expect(page.getByRole('heading', { name: `Dự án ${suffix}`, exact: true })).toBeVisible();
  await page.getByLabel('Hội thoại mới').fill(`Hội thoại ${suffix}`);
  await page.getByRole('button', { name: 'Tạo hội thoại', exact: true }).click();
  await expect(page.getByLabel('Tên hội thoại')).toHaveValue(`Hội thoại ${suffix}`);
  await page.getByText('Thêm ghi chú', { exact: true }).click();
  await page.getByLabel('Tiêu đề mới').fill('Ghi chú kiểm thử');
  await page
    .getByLabel('Nội dung mới')
    .fill('<script>window.UNTRUSTED_EXECUTED=true</script> Nội dung an toàn');
  await page.getByRole('button', { name: 'Tạo ghi chú', exact: true }).click();
  await expect(page.getByLabel('Tiêu đề ghi chú')).toHaveValue('Ghi chú kiểm thử');
  await page.reload();
  await page.getByRole('button', { name: `Dự án ${suffix} Đang hoạt động` }).click();
  await expect(page.getByRole('textbox', { name: 'Nội dung', exact: true })).toHaveValue(
    '<script>window.UNTRUSTED_EXECUTED=true</script> Nội dung an toàn',
  );
  expect(await page.evaluate(() => Reflect.get(window, 'UNTRUSTED_EXECUTED'))).toBeUndefined();
  await page.screenshot({
    path: `release-evidence/repair-m0-m1/projects-${suffix}.png`,
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('link', { name: 'Cài đặt', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Model của bạn' })).toBeVisible();
  const add = page
    .locator('details')
    .filter({ has: page.getByText('Thêm model', { exact: true }) });
  if ((await add.getAttribute('open')) === null)
    await page.getByText('Thêm model', { exact: true }).click();
  await page.getByLabel('Tên hiển thị').fill(`Synthetic ${suffix}`);
  await page.getByLabel('Địa chỉ API').fill('https://synthetic.invalid/v1');
  await page.getByLabel('Model ID').fill('synthetic-model');
  await page.getByLabel('API key').fill(`SYNTHETIC_KEY_CANARY_${suffix}`);
  await page.getByRole('button', { name: 'Lưu model', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: `Synthetic ${suffix}`, exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('API key')).toHaveValue('');
  const metadata = await page.evaluate(async () =>
    (await fetch('/api/v1/settings/providers')).text(),
  );
  expect(metadata).not.toContain(`SYNTHETIC_KEY_CANARY_${suffix}`);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('CANARY');
  await page.screenshot({
    path: `release-evidence/repair-m0-m1/settings-${suffix}.png`,
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Chào mừng trở lại.' })).toBeVisible();
  expect(await page.evaluate(async () => (await fetch('/api/v1/settings/providers')).status)).toBe(
    401,
  );
});
