import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

import { login } from './helpers';

const generatorScript = await readFile('packages/locator/dist/selector-generator.iife.js', 'utf8');

test('selector-generator: 12 个典型元素均生成语义策略', async ({ page }) => {
  await page.addInitScript({ content: generatorScript });
  await login(page);
  await page.goto('/overtime/apply');
  await expect(page.getByRole('heading', { name: '加班申请' })).toBeVisible();

  const strategies = await page.evaluate(() => {
    const form = [...document.querySelectorAll('.el-form-item')];
    const elementIn = (label: string, selector: string) => {
      const item = form.find((candidate) => candidate.textContent?.includes(label));
      const element = item?.querySelector(selector);
      if (!element) throw new Error(`找不到测试元素: ${label}/${selector}`);
      return element;
    };
    return [
      window.__DSH_GEN__(elementIn('加班类型', '.el-select')),
      window.__DSH_GEN__(elementIn('开始时间', 'input')),
      window.__DSH_GEN__(elementIn('结束时间', 'input')),
      window.__DSH_GEN__(elementIn('事由', 'textarea')),
      window.__DSH_GEN__(elementIn('审批人', 'input')),
      window.__DSH_GEN__(document.querySelector('[role="button"]')!),
    ];
  });

  await page
    .locator('.el-form-item')
    .filter({ hasText: '加班类型' })
    .locator('.el-select')
    .click();
  await expect(page.getByRole('option', { name: '工作日加班' })).toBeVisible();
  strategies.push(
    await page.evaluate(() => window.__DSH_GEN__(document.querySelector('[role="option"]')!)),
  );
  await page.getByRole('option', { name: '工作日加班' }).click();
  await page.getByRole('button', { name: '提交', exact: true }).click();
  strategies.push(
    await page.evaluate(() => {
      const dialog = document.querySelector('.el-dialog');
      const confirm = [...(dialog?.querySelectorAll('button') ?? [])].find(
        (button) => button.textContent?.trim() === '确认提交',
      );
      if (!confirm) throw new Error('找不到确认按钮');
      return window.__DSH_GEN__(confirm);
    }),
  );

  await page.goto('/history');
  await expect(page.getByText('OT-HISTORY-0001', { exact: true })).toBeVisible();
  strategies.push(
    await page.evaluate(() => window.__DSH_GEN__(document.querySelector('.el-table__row button')!)),
  );

  await page.goto('/home');
  await expect(page.getByRole('heading', { name: 'Mock OA' })).toBeVisible();
  strategies.push(
    ...(await page.evaluate(() => {
      const elements = [
        document.querySelector('h1'),
        ...[...document.querySelectorAll('button')].slice(0, 2),
      ];
      return elements.map((element) => window.__DSH_GEN__(element!));
    })),
  );

  expect(strategies).toHaveLength(12);
  expect(strategies.filter((strategy) => strategy.strategy === 'css')).toHaveLength(0);
});
