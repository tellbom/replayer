import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

import { login } from './helpers';

const locatorScript = await readFile('packages/locator/dist/dom-locator.iife.js', 'utf8');

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: locatorScript });
  await login(page);
  await page.goto('/overtime/apply');
  await expect(page.getByRole('heading', { name: '加班申请' })).toBeVisible();
});

test('el-locator: version 与 byFormItem', async ({ page }) => {
  const result = await page.evaluate(() => ({
    version: window.__DSH_LOCATOR__.version(),
    textarea: window.__DSH_LOCATOR__.byFormItem('事由：*', 'textarea').tagName,
  }));
  expect(result).toEqual({ version: 'generic', textarea: 'TEXTAREA' });
});

test('el-locator: selectOption 处理 append-to-body', async ({ page }) => {
  await page.evaluate(() => window.__DSH_LOCATOR__.selectOption('加班类型', '工作日加班'));
  await expect(
    page
      .locator('.el-form-item')
      .filter({ hasText: '加班类型' })
      .locator('.el-select__selected-item:not(.is-hidden)'),
  ).toContainText('工作日加班');
  await expect(page.getByLabel('审批人')).toHaveValue('张经理', { timeout: 2_000 });
});

test('el-locator: setInputValue 与 setDateTime 更新 Vue model', async ({ page }) => {
  await page.evaluate(async () => {
    window.__DSH_LOCATOR__.setInputValue(
      window.__DSH_LOCATOR__.byFormItem('事由', 'textarea'),
      '定位器输入',
    );
    await window.__DSH_LOCATOR__.setDateTime('开始时间', '2026-08-18 18:00:00');
  });
  await expect(page.getByLabel('事由')).toHaveValue('定位器输入');
  await expect(page.getByLabel('开始时间')).toHaveValue('2026-08-18 18:00:00');
});

test('el-locator: inDialog 等待动画并限制作用域', async ({ page }) => {
  await page.getByRole('button', { name: '提交', exact: true }).click();
  const text = await page.evaluate(() =>
    window.__DSH_LOCATOR__.inDialog('确认提交', (dialog) => dialog.textContent),
  );
  expect(text).toContain('确认提交');
});

test('el-locator: tableRowButton 定位行内按钮', async ({ page }) => {
  await page.goto('/history');
  await expect(page.getByText('OT-HISTORY-0001', { exact: true })).toBeVisible();
  const text = await page.evaluate(
    () => window.__DSH_LOCATOR__.tableRowButton('OT-HISTORY-0001', '查看').textContent,
  );
  expect(text?.trim()).toBe('查看');
});

test('el-locator: resolve、robustClick 与 waitFor', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const button = await window.__DSH_LOCATOR__.resolve({
      strategy: 'role',
      role: 'button',
      name: '提交',
    });
    window.__DSH_LOCATOR__.robustClick(button);
    const dialog = await window.__DSH_LOCATOR__.waitFor(() => document.querySelector('.el-dialog'));
    return dialog.querySelector('.el-dialog__title')?.textContent;
  });
  expect(result).toBe('确认提交');
});
