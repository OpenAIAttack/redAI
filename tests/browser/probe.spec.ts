import { test, expect } from '@playwright/test';
test('owner confirms a real synthetic probe, sees persisted results and retries safely', async ({
  page,
  request,
}, info) => {
  await page.goto('/login');
  await page.getByLabel('Tên đăng nhập', { exact: true }).fill('browser-owner');
  await page.getByLabel('Mật khẩu', { exact: true }).fill('synthetic-browser-password');
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await page.getByRole('link', { name: 'Cài đặt', exact: true }).click();
  await expect(page.getByText('Đang tải cài đặt…')).toBeHidden();
  const add = page
    .locator('details')
    .filter({ has: page.getByText('Thêm model', { exact: true }) });
  if ((await add.getAttribute('open')) === null)
    await page.getByText('Thêm model', { exact: true }).click();
  await page.getByLabel('Tên hiển thị').fill(`Probe ${info.project.name}`);
  await page.getByLabel('Địa chỉ API').fill('http://127.0.0.1:8790/v1');
  await page.getByLabel('Model ID').fill('synthetic');
  await page.getByLabel('Chế độ dữ liệu').selectOption('local_only');
  await page.getByRole('button', { name: 'Lưu model', exact: true }).click();
  const provider = page.locator('article.provider').filter({
    has: page.getByRole('heading', { name: `Probe ${info.project.name}`, exact: true }),
  });
  await expect(provider).toBeVisible();
  const count = Number(await (await request.get('http://127.0.0.1:8790/count')).text());
  page.once('dialog', (dialog) => dialog.dismiss());
  await provider.getByRole('button', { name: 'Kiểm tra model', exact: true }).click();
  expect(Number(await (await request.get('http://127.0.0.1:8790/count')).text())).toBe(count);
  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('Có thể phát sinh phí');
    await dialog.accept();
  });
  await provider.getByRole('button', { name: 'Kiểm tra model', exact: true }).click();
  await expect(provider.getByText('Tool calls: Đạt · Streaming: Đạt')).toBeVisible();
  await expect(provider.getByText('JSON có schema: Đạt · Hủy kết nối: Đã kiểm tra')).toBeVisible();
  await expect(
    provider.getByText('Provider không trả usage; chi phí chưa xác định.'),
  ).toBeVisible();
  expect(Number(await (await request.get('http://127.0.0.1:8790/count')).text())).toBe(count + 5);
  page.once('dialog', (dialog) => dialog.accept());
  await provider.getByRole('button', { name: 'Kiểm tra model', exact: true }).click();
  await expect(page.getByText('Đã kiểm chứng khả năng model bằng dữ liệu mẫu.')).toBeVisible();
  expect(Number(await (await request.get('http://127.0.0.1:8790/count')).text())).toBe(count + 5);
  await page.reload();
  await expect(provider.getByText('Tool calls: Đạt · Streaming: Đạt')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `release-evidence/T08-probe/settings-${info.project.name}.png`,
    fullPage: true,
  });
  await provider.getByRole('button', { name: 'Tắt model', exact: true }).click();
  await expect(provider.getByText('Chưa kiểm chứng kết nối')).toBeVisible();
  await expect(
    provider.getByRole('button', { name: 'Kiểm tra model', exact: true }),
  ).toBeDisabled();
});
