import { expect, test } from '@playwright/test';

import { login } from './helpers';

test('K-points: Element Plus 坑点与动态依赖均存在', async ({ page }) => {
  await login(page);
  await page.goto('/overtime/apply');

  const select = page
    .locator('.el-form-item')
    .filter({ hasText: '加班类型' })
    .locator('.el-select');
  await select.click();
  await expect(page.locator('.el-select .el-select-dropdown__item')).toHaveCount(0);
  await expect(page.getByRole('listbox')).toBeVisible();

  const submitButton = page.getByRole('button', { name: '提交', exact: true });
  await expect(submitButton).toHaveAttribute('class', /submitBtn_\w+/);

  const requestStartedAt = Date.now();
  const approverRequest = page.waitForRequest((request) =>
    request.url().includes('/api/overtime/approver'),
  );
  await page.getByRole('option', { name: '工作日加班' }).click();
  const firstRequest = await approverRequest;
  const requestDelay = Date.now() - requestStartedAt;
  expect(requestDelay).toBeGreaterThanOrEqual(450);
  expect(requestDelay).toBeLessThan(1_500);
  const firstResponse = await firstRequest.response();
  const firstApproval = await firstResponse.json();

  await select.click();
  const secondApproverRequest = page.waitForRequest((request) =>
    request.url().includes('/api/overtime/approver'),
  );
  await page.getByRole('option', { name: '周末加班' }).click();
  const secondRequest = await secondApproverRequest;
  const secondResponse = await secondRequest.response();
  const secondApproval = await secondResponse.json();
  expect(secondApproval.approvalToken).not.toBe(firstApproval.approvalToken);

  await page.getByLabel('事由').fill('K-points 验证');
  await submitButton.click();
  const submitRequest = page.waitForRequest((request) =>
    request.url().includes('/api/overtime/submit'),
  );
  await page.getByRole('button', { name: '确认提交' }).click();
  const body = (await submitRequest).postDataJSON();
  expect(body.approverId).toBe(secondApproval.approverId);
  expect(body.approvalToken).toBe(secondApproval.approvalToken);
  expect(body.approvalToken).not.toBe(firstApproval.approvalToken);
});
