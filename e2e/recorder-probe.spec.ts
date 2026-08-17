import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

import { login } from './helpers';

const generatorScript = await readFile('packages/locator/dist/selector-generator.iife.js', 'utf8');
const probeScript = await readFile('packages/locator/dist/recorder-probe.iife.js', 'utf8');

test('recorder-probe: 加班流程产生精确动作序列', async ({ page }) => {
  await page.addInitScript(() => {
    Reflect.set(window, '__recordedActions', []);
    Reflect.set(window, '__DSH_RECORDING__', true);
    Reflect.set(window, '__DSH_RECORD__', (action: unknown) => {
      (Reflect.get(window, '__recordedActions') as unknown[]).push(action);
    });
  });
  await page.addInitScript({ content: generatorScript });
  await page.addInitScript({ content: probeScript });
  await login(page);
  await page.goto('/overtime/apply');
  await expect(page.getByRole('heading', { name: '加班申请' })).toBeVisible();

  await page
    .locator('.el-form-item')
    .filter({ hasText: '加班类型' })
    .locator('.el-select')
    .click();
  await page.getByRole('option', { name: '工作日加班' }).click();
  for (const [label, value] of [
    ['开始时间', '2026-08-18 18:00:00'],
    ['结束时间', '2026-08-18 21:00:00'],
  ]) {
    await page.getByLabel(label).evaluate((element, nextValue) => {
      const input = element as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, nextValue);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
  }
  await page.getByRole('heading', { name: '加班申请' }).click();
  await page.getByLabel('事由').fill('录制探针验证');
  await page.getByRole('button', { name: '提交', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '确认提交' })).toBeVisible();
  await page.getByRole('button', { name: '确认提交' }).click();

  const types = await page.evaluate(() =>
    (Reflect.get(window, '__recordedActions') as Array<{ type: string }>).map((action) => action.type),
  );
  expect(types).toEqual(['navigate', 'select', 'datetime', 'datetime', 'fill', 'click', 'click']);
});
