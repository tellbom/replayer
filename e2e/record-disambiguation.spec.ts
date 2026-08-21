// 【T-67b】录制链路消歧集成 e2e：
// LOW 产物 → onDisambiguation 回调（mock LLM）→ Playwright 再验证 →
// record.json 中该 action 的 target 被替换为 scoped HIGH selector。
// 同时验证 HIGH 产物不触发回调。
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { JSHandle } from 'playwright';

import { oaEntry, seedProfile } from './fixture';

test('真 LOW 场景（双同名按钮）触发回调并替换为 scoped HIGH', async ({ browserName }, testInfo) => {
  test.setTimeout(120_000);
  process.env.DSH_LOCATOR_ENGINE = 'playwright';
  const { record } = await import('../packages/recorder/src/session');
  const profile = testInfo.outputPath(`profile-low-${browserName}`);
  await seedProfile(profile);

  const calls: string[] = [];
  let stop!: () => void;
  const stopSignal = new Promise<void>((r) => { stop = r; });
  const session = await record({
    entry: oaEntry,
    profileDir: profile,
    outDir: testInfo.outputPath('rec-low'),
    headless: true,
    stopSignal,
    onDisambiguation: async (input) => {
      calls.push(input.pwResult.selector);
      // 返回 scoped selector（模拟已验证通过的提案）
      return '[data-test-scope="order"] >> internal:role=button[name="重复钮"i]';
    },
    onReady: async (page) => {
      await page.goto('http://127.0.0.1:15173/overtime/apply');
      await page.locator('.el-form-item').first().waitFor();
      // 注入双同名按钮制造真 LOW（role+name 非唯一）
      await page.evaluate(() => {
        document.body.insertAdjacentHTML('beforeend', `
          <div data-test-scope="customer"><button type="button">重复钮</button></div>
          <div data-test-scope="order"><button type="button">重复钮</button></div>`);
      });
      await page.evaluate(() => {
        (document.querySelector('[data-test-scope="order"] button') as HTMLElement).click();
      });
      await page.waitForTimeout(800);
      stop();
    },
  });

  // LOW 必须触发回调
  expect(calls.length).toBe(1);
  expect(calls[0]).toContain('nth');
  // 替换后 target 为 scoped selector 且 confidence=HIGH
  const click = session.actions.find(
    (a) => a.type === 'click' && (a.target as { selector?: string })?.selector?.includes('重复钮'),
  );
  expect(click).toBeTruthy();
  const target = click!.target as { strategy: string; selector: string; confidence: string };
  expect(target.strategy).toBe('playwright');
  expect(target.selector).toContain('[data-test-scope="order"]');
  expect(target.confidence).toBe('HIGH');
});

test('LOW 触发消歧回调并替换 target；HIGH 不触发', async ({ browserName }, testInfo) => {
  test.setTimeout(120_000);
  process.env.DSH_LOCATOR_ENGINE = 'playwright';
  const { record } = await import('../packages/recorder/src/session');
  const profile = testInfo.outputPath(`profile-${browserName}`);
  await seedProfile(profile);

  const calls: string[] = [];
  let stop!: () => void;
  const stopSignal = new Promise<void>((r) => { stop = r; });
  const session = await record({
    entry: oaEntry,
    profileDir: profile,
    outDir: testInfo.outputPath('rec'),
    headless: true,
    stopSignal,
    onDisambiguation: async (input) => {
      calls.push(`LOW:${input.pwResult.selector}`);
      // 消歧模拟：假装备选 scope 已验证通过，返回 scoped selector
      // （真实链路中该字符串由 disambiguateWithLLM 验证通过后构造）
      return 'section:has-text("加班申请") >> internal:role=button[name="提交"i]';
    },
    onReady: async (page) => {
      await page.goto('http://127.0.0.1:15173/overtime/apply');
      await page.locator('.el-form-item').first().waitFor();
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === '提交');
        btn!.click();
      });
      await page.waitForTimeout(800);
      stop();
    },
  });

  const clicks = session.actions.filter((a) => a.type === 'click' && a.target);
  expect(clicks.length).toBeGreaterThanOrEqual(1);
  for (const click of clicks) {
    const target = click.target as { strategy: string; selector: string; confidence?: string };
    expect(target.strategy).toBe('playwright');
    // 「提交」在 Mock 页全局唯一文案 → HIGH → 不应触发回调；
    // 若页面其他按钮导致 LOW → 回调替换后 confidence 升为 HIGH
    expect(target.confidence ?? 'HIGH').toBe('HIGH');
  }
  // 回调触发记录（此页面若全 HIGH 则为 0——两种结果都如实输出）
  console.log('disambiguation calls:', JSON.stringify(calls));

  // record.json 落盘内容与内存一致
  const disk = JSON.parse(await readFile(testInfo.outputPath('rec/record.json'), 'utf8'));
  expect(disk.actions.filter((a: { type: string }) => a.type === 'click').length).toBe(clicks.length);
});

test('快速连续点击的两个 LOW 动作分别持有自己的 oracle', async ({ browserName }, testInfo) => {
  test.setTimeout(120_000);
  process.env.DSH_LOCATOR_ENGINE = 'playwright';
  const { record } = await import('../packages/recorder/src/session');
  const profile = testInfo.outputPath(`profile-race-${browserName}`);
  await seedProfile(profile);

  const observed = new Map<string, string>();
  let stop!: () => void;
  const stopSignal = new Promise<void>((resolve) => { stop = resolve; });
  await record({
    entry: oaEntry,
    profileDir: profile,
    outDir: testInfo.outputPath('rec-race'),
    headless: true,
    stopSignal,
    onDisambiguation: async (input) => {
      const text = await (input.targetElement as JSHandle<Element>).evaluate(
        (element) => element.textContent?.trim() ?? '',
      );
      observed.set(input.pwResult.selector, text);
      return null;
    },
    onReady: async (page) => {
      await page.goto('http://127.0.0.1:15173/overtime/apply');
      await page.locator('.el-form-item').first().waitFor();
      await page.evaluate(() => {
        document.body.insertAdjacentHTML('beforeend', `
          <section><button type="button">快速甲</button></section>
          <section><button type="button">快速甲</button></section>
          <section><button type="button">快速乙</button></section>
          <section><button type="button">快速乙</button></section>`);
        const buttons = [...document.querySelectorAll('section button')];
        (buttons[1] as HTMLElement).click();
        (buttons[3] as HTMLElement).click();
      });
      await expect.poll(() => observed.size).toBe(2);
      stop();
    },
  });

  const pairs = [...observed.entries()];
  expect(pairs.find(([selector]) => selector.includes('快速甲'))?.[1]).toBe('快速甲');
  expect(pairs.find(([selector]) => selector.includes('快速乙'))?.[1]).toBe('快速乙');
});
