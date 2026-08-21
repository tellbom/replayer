import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

import { record } from '@dsh/recorder';

import { oaEntry, seedProfile } from './fixture';

test('T-72 同名 section 按钮由规则化祖先提升为 HIGH，且不调用 LLM', async ({ browserName }, testInfo) => {
  test.setTimeout(120_000);
  const profileDir = testInfo.outputPath(`profile-${browserName}`);
  await seedProfile(profileDir);
  let stop!: () => void;
  const stopSignal = new Promise<void>((resolve) => { stop = resolve; });
  let originalConfidence = '';
  let ancestorCandidate: unknown;
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
      await page.goto('http://127.0.0.1:15173/overtime/apply');
      await page.locator('.el-form-item').first().waitFor();
      await page.evaluate(() => {
        const root = document.createElement('div');
        root.innerHTML = `
          <section><h2>请假区</h2><button>搜索</button></section>
          <section><h2>加班区</h2><button>搜索</button></section>`;
        document.querySelector('main')!.append(root);
      });
      originalConfidence = await page.evaluate(() => {
        const sections = document.querySelectorAll('section');
        return window.__DSH_PWGEN__(sections[1]!.querySelector('button')!).confidence;
      });
      ancestorCandidate = await page.evaluate(() => {
        const sections = document.querySelectorAll('section');
        return window.__DSH_ANCESTOR_SCOPE__(sections[1]!.querySelector('button')!);
      });
      await page.locator('section').filter({ hasText: '加班区' }).getByRole('button', { name: '搜索' }).click();
      await page.waitForTimeout(1_000);
      stop();
    },
  });

  const action = session.actions.find((candidate) => candidate.type === 'click' && candidate.text === '搜索');
  console.log(JSON.stringify({ originalConfidence, ancestorCandidate, action, llmCalls }));
  expect(originalConfidence).toBe('LOW');
  expect(action?.target).toMatchObject({ strategy: 'playwright', confidence: 'HIGH' });
  expect(action?.target?.strategy === 'playwright' ? action.target.selector : '').toContain(
    'section:has-text("加班区")',
  );
  expect(action?.target?.strategy === 'playwright' ? action.target.selector : '').toContain(
    'internal:role=button[name="搜索"i]',
  );
  expect(llmCalls).toBe(0);
  console.log(JSON.stringify({ originalConfidence, promoted: action?.target, llmCalls }));
});

test('T-72 支持具名 role、fieldset 与 Element 容器规则', async ({ page }) => {
  await page.setContent(`
    <button>搜索</button>
    <div role="region" aria-label="订单管理"><button id="role-target">搜索</button></div>
    <fieldset><legend>客户资料</legend><button id="fieldset-target">搜索</button></fieldset>
    <div class="el-card"><div class="el-card__header">风险信息</div><button id="card-target">搜索</button></div>`);
  await page.addScriptTag({ content: await readFile('packages/locator/dist/pw-selector-generator.iife.js', 'utf8') });
  await page.addScriptTag({ content: await readFile('packages/locator/dist/ancestor-scope.iife.js', 'utf8') });

  const selectors = await page.evaluate(() => [
    window.__DSH_ANCESTOR_SCOPE__(document.querySelector('#role-target')!)?.scopeSelector,
    window.__DSH_ANCESTOR_SCOPE__(document.querySelector('#fieldset-target')!)?.scopeSelector,
    window.__DSH_ANCESTOR_SCOPE__(document.querySelector('#card-target')!)?.scopeSelector,
  ]);
  expect(selectors).toEqual([
    'internal:role=region[name="订单管理"i]',
    'fieldset:has-text("客户资料")',
    '.el-card:has-text("风险信息")',
  ]);
});
