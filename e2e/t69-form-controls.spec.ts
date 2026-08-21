import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

import { oaEntry } from './fixture';

test('T-69 G1-G5: no-id 表单控件走正式录制链路', async ({ browserName }, testInfo) => {
  test.setTimeout(120_000);
  process.env.DSH_LOCATOR_ENGINE = 'playwright';
  const { record } = await import('../packages/recorder/src/session');
  const profile = testInfo.outputPath(`profile-${browserName}`);
  const { chromium } = await import('playwright');
  const seed = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true });
  {
    const page = seed.pages()[0] ?? (await seed.newPage());
    await page.goto('http://127.0.0.1:5173/login');
    await page.getByLabel('用户名').fill('tester');
    await page.getByLabel('密码').fill('tester');
    await page.getByRole('button', { name: '登录' }).click();
    await page.waitForURL('**/home');
  }
  await seed.close();

  let stop!: () => void;
  const stopSignal = new Promise<void>((resolve) => { stop = resolve; });
  const session = await record({
    entry: oaEntry,
    profileDir: profile,
    outDir: testInfo.outputPath('record'),
    headless: true,
    stopSignal,
    onReady: async (page) => {
      await page.goto('http://127.0.0.1:5173/overtime/apply');
      await page.locator('.el-form-item').first().waitFor();
      await page.evaluate(() => {
        const suffix = Math.random().toString(36).slice(2, 8);
        const root = document.createElement('div');
        root.innerHTML = `
          <div class="audit-g1">
            <label for="reason-${suffix}">事由G1</label>
            <textarea id="reason-${suffix}"></textarea>
          </div>
          <div class="audit-g2">
            <input placeholder="请输入事由G2">
          </div>
          <div class="audit-g3 el-form">
            <div class="el-form-item">
              <label class="el-form-item__label">备注G3</label>
              <div class="el-form-item__content"><textarea class="el-textarea__inner"></textarea></div>
            </div>
            <div class="el-form-item">
              <label class="el-form-item__label">事由G3</label>
              <div class="el-form-item__content"><textarea class="el-textarea__inner"></textarea></div>
            </div>
          </div>
          <div class="audit-g4">
            <section>
              <h2>请假</h2>
              <div class="el-form-item"><label for="start-a-${suffix}">开始时间</label><input id="start-a-${suffix}"></div>
            </section>
            <section>
              <h2>加班</h2>
              <div class="el-form-item"><label for="start-b-${suffix}">开始时间</label><input id="start-b-${suffix}"></div>
            </section>
          </div>
          <div class="audit-g5">
            <label><input type="radio" name="decision-${suffix}" value="g5-approve">同意G5</label>
            <label><input type="radio" name="decision-${suffix}" value="g5-reject">拒绝G5</label>
          </div>`;
        document.body.append(root);

        const changes: Array<[HTMLInputElement | HTMLTextAreaElement, string]> = [
          [root.querySelector('.audit-g1 textarea')!, 'g1-value'],
          [root.querySelector('.audit-g2 input')!, 'g2-value'],
          [root.querySelectorAll('.audit-g3 textarea')[1]!, 'g3-value'],
          [root.querySelectorAll('.audit-g4 input')[1]!, 'g4-value'],
        ];
        for (const [control, value] of changes) {
          control.value = value;
          control.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const radio = root.querySelector('.audit-g5 input[value="g5-approve"]') as HTMLInputElement;
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitForTimeout(800);
      stop();
    },
  });

  const results = Object.fromEntries(
    session.actions
      .filter((action) => action.type === 'fill' && action.value?.endsWith('-value'))
      .map((action) => [
        action.value!.slice(0, 2).toUpperCase(),
        action.target as { strategy: string; selector: string; confidence: 'HIGH' | 'LOW' },
      ]),
  );
  const g5 = session.actions.find((action) => action.value === 'g5-approve')?.target as {
    strategy: string;
    selector: string;
    confidence: 'HIGH' | 'LOW';
  };

  expect(Object.keys(results)).toHaveLength(4);
  expect(results.G1.selector).toContain('internal:role=textbox');
  expect(results.G1.selector).toContain('事由G1');
  expect(results.G1.confidence).toBe('HIGH');
  expect(results.G2.selector).toContain('internal:role=textbox');
  expect(results.G2.selector).toContain('请输入事由G2');
  expect(results.G2.confidence).toBe('HIGH');
  expect(results.G3.confidence).toBe('LOW');
  expect(results.G4.confidence).toBe('LOW');
  expect(g5.selector).toContain('internal:role=radio');
  expect(g5.confidence).toBe('HIGH');

  console.log('\n===== T-69 FORM-CONTROL REPORT =====');
  for (const [scenario, result] of Object.entries({ ...results, G5: g5 })) {
    console.log(`${scenario}=${JSON.stringify(result)}`);
  }
});

test('T-69 internal:label/internal:attr 引擎可验证生成器候选', async ({ page }) => {
  await page.setContent(`
    <label for="output-label">输出标签</label><output id="output-label" role="none"></output>
    <div title="属性标题" role="none"></div>`);
  await page.addScriptTag({
    content: await readFile('packages/locator/dist/pw-selector-generator.iife.js', 'utf8'),
  });
  const results = await page.evaluate(() => {
    const generate = Reflect.get(window, '__DSH_PWGEN__') as (element: Element) => {
      selector: string;
      confidence: 'HIGH' | 'LOW';
    };
    return {
      label: generate(document.querySelector('output')!),
      attr: generate(document.querySelector('div[title]')!),
    };
  });

  console.log(`direct=${JSON.stringify(results)}`);

  expect(results.label.selector).toContain('internal:label');
  expect(results.label.confidence).toBe('HIGH');
  expect(results.attr.selector).toContain('internal:attr');
  expect(results.attr.confidence).toBe('HIGH');
});
