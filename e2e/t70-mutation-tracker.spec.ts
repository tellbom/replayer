import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

import { login } from './helpers';

interface RootResult {
  kind: string;
  portaled: boolean;
  appearedAfterMs: number;
  descriptor: unknown;
}

async function endObservation(page: Page, actionIdx: number): Promise<RootResult[]> {
  return page.evaluate(async (idx) => {
    const roots = await window.__DSH_MUTATION__.end(idx);
    return roots.map(({ kind, portaled, appearedAfterMs, descriptor }) => ({
      kind,
      portaled,
      appearedAfterMs,
      descriptor,
    }));
  }, actionIdx);
}

test('T-70 动作后只记录动态子树根并识别业务容器', async ({ page }) => {
  test.setTimeout(30_000);
  await login(page);
  await page.goto('/overtime/apply');
  await page.locator('.el-form-item').first().waitFor();
  await page.addScriptTag({
    content: await readFile('packages/locator/dist/selector-generator.iife.js', 'utf8'),
  });
  await page.addScriptTag({
    content: await readFile('packages/locator/dist/mutation-tracker.iife.js', 'utf8'),
  });

  await page.evaluate(() => {
    const harness = document.createElement('section');
    harness.innerHTML = `
      <button id="add-detail">添加明细</button>
      <table><tbody id="detail-body"></tbody></table>
      <select id="linked-select"><option value="">请选择</option><option value="show">显示字段</option></select>
      <div id="linked-fields"></div>`;
    document.body.append(harness);
    harness.querySelector('#add-detail')!.addEventListener('click', () => {
      setTimeout(() => {
        const row = document.createElement('tr');
        row.className = 'el-table__row';
        row.innerHTML = '<td class="el-table__cell">新增明细</td>';
        harness.querySelector('#detail-body')!.append(row);
      }, 25);
    });
    harness.querySelector('#linked-select')!.addEventListener('change', () => {
      setTimeout(() => {
        const field = document.createElement('div');
        field.className = 'el-form-item';
        field.innerHTML = '<label class="el-form-item__label">联动字段</label><input>';
        harness.querySelector('#linked-fields')!.append(field);
      }, 25);
    });
  });

  await page.evaluate(() => window.__DSH_MUTATION__.begin(0));
  await page.locator('.el-form-item').filter({ hasText: '加班类型' }).locator('.el-select').click();
  const listbox = await endObservation(page, 0);
  expect(listbox).toHaveLength(1);
  expect(listbox[0]).toMatchObject({ kind: 'listbox', portaled: true });
  expect(listbox[0]?.descriptor).toBeDefined();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  await page.evaluate(() => window.__DSH_MUTATION__.begin(1));
  await page.getByRole('button', { name: '提交', exact: true }).click();
  const dialog = await endObservation(page, 1);
  expect(dialog).toHaveLength(1);
  expect(dialog[0]?.kind).toBe('dialog');
  await page.getByRole('button', { name: '取消' }).click();
  await page.waitForTimeout(200);

  await page.evaluate(() => window.__DSH_MUTATION__.begin(2));
  await page.getByRole('button', { name: '添加明细' }).click();
  const row = await endObservation(page, 2);
  expect(row).toHaveLength(1);
  expect(row[0]).toMatchObject({ kind: 'table-row', portaled: false });

  await page.evaluate(() => window.__DSH_MUTATION__.begin(3));
  await page.selectOption('#linked-select', 'show');
  const conditional = await endObservation(page, 3);
  expect(conditional).toHaveLength(1);
  expect(conditional[0]).toMatchObject({ kind: 'panel', portaled: false });

  for (const roots of [listbox, dialog, row, conditional]) expect(roots.length).toBeLessThanOrEqual(3);
  console.log(JSON.stringify({ listbox, dialog, row, conditional }));
});
