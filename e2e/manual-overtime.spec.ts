import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

import { login } from './helpers';

const locatorScript = await readFile('packages/locator/dist/el-locator.iife.js', 'utf8');

test('manual-overtime: 手写 locator 脚本完成加班流程', async ({ page }) => {
  await page.addInitScript({ content: locatorScript });
  await login(page);
  await page.goto('/overtime/apply');
  await expect(page.getByRole('heading', { name: '加班申请' })).toBeVisible();

  await page.evaluate(async () => {
    const locator = window.__DSH_LOCATOR__;
    await locator.selectOption('加班类型', '工作日加班');
    await locator.setDateTime('开始时间', '2026-08-18 18:00:00');
    await locator.setDateTime('结束时间', '2026-08-18 21:00:00');
    locator.setInputValue(locator.byFormItem('事由', 'textarea'), '版本上线');

    await locator.waitFor(() => {
      const approver = locator.byFormItem('审批人', 'input') as HTMLInputElement;
      return approver.value !== '—' ? approver.value : undefined;
    });

    const submit = await locator.resolve({ strategy: 'role', role: 'button', name: '提交' });
    locator.robustClick(submit);
    await locator.inDialog('确认提交', (dialog) => {
      const confirm = [...dialog.querySelectorAll('button')].find(
        (button) => button.textContent?.trim() === '确认提交',
      );
      if (!(confirm instanceof HTMLElement)) throw new Error('确认弹窗中找不到确认提交按钮');
      locator.robustClick(confirm);
    });
  });

  await expect(page.getByText(/提交成功：OT-/)).toBeVisible();
});
