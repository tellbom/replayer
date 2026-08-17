import { expect, test } from '@playwright/test';

import { login } from './helpers';

test('legacy: SSR 隐藏字段可提取并提交', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:3000/legacy/overtime');

  const viewState = await page.locator('input[name="__VIEWSTATE"]').getAttribute('value');
  const token = await page.locator('input[name="__TOKEN"]').getAttribute('value');
  expect(viewState).toBeTruthy();
  expect(token).toBeTruthy();

  await page.getByLabel('事由').fill('Legacy 验证');
  await page.getByRole('button', { name: '提交' }).click();
  await expect(page.getByRole('heading', { name: '提交成功' })).toBeVisible();
});

test('legacy: 错误隐藏字段必须失败', async ({ page }) => {
  await login(page);
  await page.goto('http://127.0.0.1:3000/legacy/overtime');
  await page.locator('input[name="__VIEWSTATE"]').evaluate((element) => {
    (element as HTMLInputElement).value = 'invalid';
  });
  await page.getByRole('button', { name: '提交' }).click();
  await expect(page.getByRole('heading', { name: '隐藏字段校验失败' })).toBeVisible();
});
