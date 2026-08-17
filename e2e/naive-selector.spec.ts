import { expect, test } from '@playwright/test';

import { login } from './helpers';

test('朴素 CSS 选择器必须失败（否则 mock 不合格）', async ({ page }) => {
  await login(page);
  await page.goto('/overtime/apply');

  const select = page
    .locator('.el-form-item')
    .filter({ hasText: '加班类型' })
    .locator('.el-select');
  await select.click();

  await expect(page.locator('.el-select .el-select-dropdown__item')).toHaveCount(0);
  await expect(page.getByRole('option', { name: '工作日加班' })).toBeVisible();

  const submit = page.getByRole('button', { name: '提交', exact: true });
  const currentClass = await submit.getAttribute('class');
  expect(currentClass).toMatch(/submitBtn_[a-z0-9]{6}_[A-Za-z0-9_-]{5}/);
});
