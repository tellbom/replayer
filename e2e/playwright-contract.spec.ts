// 【T-67a】契约闭环 e2e：DSH_LOCATOR_ENGINE=playwright 下录制 →
// record.json 的 target 为 {strategy:'playwright', selector, confidence} →
// 回放经 channel-ui 的 page.locator(selector) 命中同一元素。
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

import { oaEntry, seedProfile } from './fixture';

test('playwright 引擎录制产物符合正式契约且回放命中', async ({ browserName }, testInfo) => {
  test.setTimeout(120_000);
  process.env.DSH_LOCATOR_ENGINE = 'playwright';
  const { record } = await import('../packages/recorder/src/session');
  const profile = testInfo.outputPath(`profile-${browserName}`);

  await seedProfile(profile);

  let stop!: () => void;
  const stopSignal = new Promise<void>((r) => { stop = r; });
  const session = await record({
    entry: oaEntry,
    profileDir: profile,
    outDir: testInfo.outputPath('rec'),
    headless: true,
    stopSignal,
    onReady: async (page) => {
      await page.goto('http://127.0.0.1:15173/overtime/apply');
      await page.locator('.el-form-item').first().waitFor();
      // 点击「提交」按钮（role/button 形态，playwright 引擎应产出 role+name 语义 selector）
      await page.evaluate(() => {
        const l = window.__DSH_LOCATOR__;
        l.robustClick(
          [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === '提交')!,
        );
      });
      await page.waitForTimeout(500);
      stop();
    },
  });

  // 1. 契约断言：click 动作的 target 是 playwright 策略
  const clickAction = session.actions.find(
    (a) => a.type === 'click' && a.target && typeof a.target === 'object',
  );
  expect(clickAction).toBeTruthy();
  const target = clickAction!.target as { strategy: string; selector: string; confidence?: string };
  expect(target.strategy).toBe('playwright');
  expect(target.selector).toBeTruthy();
  expect(['HIGH', 'LOW']).toContain(target.confidence);
  console.log('契约产物:', JSON.stringify(target));

  // 2. 回放命中：selector 直接经 page.locator 执行
  const verify = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true });
  {
    const page = verify.pages()[0] ?? (await verify.newPage());
    await page.goto('http://127.0.0.1:15173/overtime/apply');
    await page.locator('.el-form-item').first().waitFor();
    const count = await page.locator(target.selector).count();
    expect(count).toBeGreaterThanOrEqual(1);
    // 命中的是「提交」按钮本身
    const isSubmit = await page
      .locator(target.selector)
      .first()
      .evaluate((el) => el.textContent?.trim() === '提交');
    expect(isSubmit).toBe(true);
  }
  await verify.close();
  void readFile;
});
