import { expect, test } from '@playwright/test';

import { StepSchema, type ExecContext } from '@dsh/core';
import { record } from '@dsh/recorder';

import { executeUiStep } from '../packages/replayer/src/channel-ui';
import { oaEntry, seedProfile } from './fixture';

test('T-71 录制后处理把动态 dialog、table-row、listbox 转成 scoped HIGH', async ({ browserName }, testInfo) => {
  test.setTimeout(120_000);
  process.env.DSH_LOCATOR_ENGINE = 'playwright';
  const profileDir = testInfo.outputPath(`profile-${browserName}`);
  await seedProfile(profileDir);
  let stop!: () => void;
  const stopSignal = new Promise<void>((resolve) => { stop = resolve; });
  const globalConfidence: string[] = [];
  let llmCalls = 0;

  const session = await record({
    entry: oaEntry,
    profileDir,
    outDir: testInfo.outputPath('record'),
    headless: true,
    stopSignal,
    onDisambiguation: async () => {
      llmCalls += 1;
      return null;
    },
    onReady: async (page) => {
      await page.goto('http://127.0.0.1:5173/overtime/apply');
      await page.locator('.el-form-item').first().waitFor();
      await page.evaluate(() => {
        const harness = document.createElement('section');
        harness.innerHTML = `
          <button id="outside-confirm">确定</button>
          <button id="open-dialog">打开确认框</button>
          <button id="outside-delete">删除</button>
          <button id="add-row">添加明细</button>
          <table><tbody id="rows"></tbody></table>`;
        document.querySelector('main')!.append(harness);
        harness.querySelector('#open-dialog')!.addEventListener('click', () => {
          const dialog = document.createElement('div');
          dialog.setAttribute('role', 'dialog');
          dialog.setAttribute('aria-label', '动态确认');
          dialog.innerHTML = '<button id="inside-confirm">确定</button>';
          document.body.append(dialog);
        });
        harness.querySelector('#add-row')!.addEventListener('click', () => {
          const row = document.createElement('tr');
          row.className = 'el-table__row';
          row.innerHTML = '<td class="el-table__cell">明细A</td><td class="el-table__cell"><button id="inside-delete">删除</button></td>';
          harness.querySelector('#rows')!.append(row);
        });
      });

      await page.getByRole('button', { name: '打开确认框' }).click();
      globalConfidence.push(await page.evaluate(() => window.__DSH_PWGEN__(document.querySelector('#inside-confirm')!).confidence));
      await page.locator('[role="dialog"]').getByRole('button', { name: '确定' }).click();

      await page.getByRole('button', { name: '添加明细' }).click();
      globalConfidence.push(await page.evaluate(() => window.__DSH_PWGEN__(document.querySelector('#inside-delete')!).confidence));
      await page.locator('.el-table__row').getByRole('button', { name: '删除' }).click();

      await page.locator('.el-form-item').filter({ hasText: '加班类型' }).locator('.el-select').click();
      await page.getByRole('option', { name: '工作日加班' }).click();
      await page.waitForTimeout(1_000);
      stop();
    },
  });

  const find = (text: string) => session.actions.find((action) => action.text === text);
  const openDialog = find('打开确认框');
  const confirm = find('确定');
  const addRow = find('添加明细');
  const remove = find('删除');
  const openSelect = session.actions.find((action) => action.type === 'click' && action.label === '加班类型');
  const option = session.actions.find((action) => action.type === 'select' && action.value === '工作日加班');

  console.log(JSON.stringify({ globalConfidence, openDialog, confirm, addRow, remove, openSelect, option, llmCalls }));

  expect(globalConfidence).toEqual(['HIGH', 'HIGH']);
  expect(openDialog?.produces?.kind).toBe('dialog');
  expect(confirm?.scope).toBe(openDialog?.produces?.scopeId);
  expect(confirm?.target).toMatchObject({ strategy: 'playwright', confidence: 'HIGH' });
  expect(addRow?.produces?.kind).toBe('table-row');
  expect(remove?.scope).toBe(addRow?.produces?.scopeId);
  expect(remove?.target).toMatchObject({ strategy: 'playwright', confidence: 'HIGH' });
  expect(openSelect?.produces).toMatchObject({ kind: 'listbox', portaled: true });
  expect(option?.scope).toBe(openSelect?.produces?.scopeId);
  expect(option?.target).toMatchObject({ strategy: 'playwright', confidence: 'HIGH' });
  expect(llmCalls).toBe(0);
  console.log(JSON.stringify({
    pageGlobalLlmTriggers: globalConfidence.filter((confidence) => confidence === 'LOW').length,
    scopedLlmTriggers: llmCalls,
  }));
});

test('T-71 回放严格按唯一 scope root 定位目标', async ({ page }) => {
  await page.setContent('<button id="open">打开</button><button>确定</button>');
  await page.locator('#open').evaluate((button) => {
    button.addEventListener('click', () => {
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-label', '确认提交');
      dialog.innerHTML = '<button onclick="document.body.dataset.confirmed=\'yes\'">确定</button>';
      document.body.append(dialog);
    });
  });
  const context: ExecContext = {
    params: {},
    vars: {},
    stepResults: {},
    baseUrl: 'http://example.test',
    entry: oaEntry,
    identityDigest: 'tester',
    scopes: {},
  };
  const producer = StepSchema.parse({
    id: 's1', desc: '打开', channel: 'ui', ui: { action: 'click', target: { strategy: 'playwright', selector: '#open' } },
    produces: {
      scopeId: 'sc1',
      root: { strategy: 'playwright', selector: 'internal:role=dialog[name="确认提交"i]' },
      kind: 'dialog',
    },
    waitAfter: { scopeReady: 'sc1', settleMs: 10 },
  });
  const consumer = StepSchema.parse({
    id: 's2', desc: '确认', channel: 'ui', requires: ['sc1'],
    ui: {
      action: 'click', scope: 'sc1',
      target: { strategy: 'playwright', selector: 'internal:role=button[name="确定"i]' },
    },
  });

  await executeUiStep(page, producer, context, []);
  await executeUiStep(page, consumer, context, []);
  await expect(page.locator('body')).toHaveAttribute('data-confirmed', 'yes');

  const duplicateRoot = StepSchema.parse({
    id: 's3', desc: '再次打开', channel: 'ui',
    ui: { action: 'click', target: { strategy: 'playwright', selector: '#open' } },
    produces: {
      scopeId: 'sc2',
      root: { strategy: 'playwright', selector: 'internal:role=dialog[name="确认提交"i]' },
      kind: 'dialog',
    },
    waitAfter: { scopeReady: 'sc2' },
  });
  await expect(executeUiStep(page, duplicateRoot, context, [])).rejects.toThrow('strict mode violation');

  const missingScope = StepSchema.parse({
    id: 's4', desc: '错误 scope', channel: 'ui',
    ui: { action: 'click', scope: 'missing', target: { strategy: 'playwright', selector: 'button' } },
  });
  await expect(executeUiStep(page, missingScope, context, [])).rejects.toThrow('missing');
});
