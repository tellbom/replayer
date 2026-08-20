// 【T-64】LLM 录制期消歧 POC：D 场景（playwright generator 退化为 nth LOW）触发 LLM，
// LLM 从局部上下文选 scope → Playwright 再验证（count==1 且命中即用户点击的原元素）。
import { expect, test } from '@playwright/test';
import type { ILLMProvider } from '@dsh/core';

import { disambiguateWithLLM } from '../packages/llm/src/disambiguate';

const PWGEN = 'packages/locator/dist/pw-selector-generator.iife.js';
const DISAMBIG = 'packages/locator/dist/disambiguation-context.iife.js';

/** mock LLM：模拟一个「看局部上下文能选出订单管理 scope」的模型。 */
function mockLLM(response: object): ILLMProvider {
  return {
    name: 'mock',
    supportsVision: false,
    async chat() {
      return JSON.stringify(response);
    },
  };
}

test('D 场景：LOW 触发 LLM → scope 消歧 → Playwright oracle 验证通过', async ({ page }) => {
  await page.goto('/home');
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      'beforeend',
      `<div id="poc-zone">
        <section><h2>客户管理</h2><form role="search"><button type="submit">搜索DD</button></form></section>
        <section><h2>订单管理</h2><form role="search"><button type="submit">搜索DD</button></form></section>
      </div>`,
    );
  });
  const fs = await import('node:fs');
  await page.addScriptTag({ content: fs.readFileSync(PWGEN, 'utf8') });
  await page.addScriptTag({ content: fs.readFileSync(DISAMBIG, 'utf8') });

  // 1. playwright generator 产物（预期 nth LOW——同 role+name 候选 2 个）
  const pw = await page.evaluate(() => {
    const sections = [...document.querySelectorAll('#poc-zone section')];
    const order = sections.find((s) => s.querySelector('h2')!.textContent === '订单管理')!;
    const element = order.querySelector('button')!;
    return { pw: window.__DSH_PWGEN__(element) };
  });
  expect(pw.pw.confidence).toBe('LOW');
  expect(pw.pw.matchCount).toBeGreaterThanOrEqual(1);
  // LOW 是进入 LLM 的门槛

  // 2. 收集局部上下文（浏览器侧）
  const elementHandle = await page.evaluateHandle(
    () => ([...document.querySelectorAll('#poc-zone section')].find((s) => s.querySelector('h2')!.textContent === '订单管理')!.querySelector('button')),
  );
  const context = await page.evaluate((el) => window.__DSH_DISAMBIG__(el), elementHandle);
  // 上下文必须包含订单管理语义证据（ancestors 或候选 heading）
  const contextJson = JSON.stringify(context);
  expect(contextJson).toContain('订单管理');
  // 禁止整页泄漏：上下文规模必须远小于页面
  const pageSize = await page.evaluate(() => document.documentElement.outerHTML.length);
  expect(contextJson.length).toBeLessThan(pageSize / 20);

  // 3. LLM 提案（mock：选 section+订单管理 scope）
  const llm = mockLLM({
    candidate: 1,
    scopeHint: { tag: 'section', heading: '订单管理', role: null },
    reason: '两个同名搜索按钮分属客户/订单管理 section，目标在订单管理 section 内',
  });
  const outcome = await disambiguateWithLLM(llm, {
    page,
    targetElement: elementHandle,
    pwResult: { selector: pw.pw.selector, matchCount: pw.pw.matchCount, confidence: pw.pw.confidence },
    context,
  });

  // 4. 验证结果：提案被接受，且 oracle 成立（唯一命中即原元素）
  expect(outcome.accepted).toBe(true);
  expect(outcome.verification?.matchCount).toBe(1);
  expect(outcome.verification?.isOriginalTarget).toBe(true);
});

test('错误提案被 Playwright 再验证拒绝（scope 指向客户管理 → 命中原元素失败）', async ({ page }) => {
  await page.goto('/home');
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      'beforeend',
      `<div id="poc-zone">
        <section><h2>客户管理</h2><form role="search"><button type="submit">搜索DX</button></form></section>
        <section><h2>订单管理</h2><form role="search"><button type="submit">搜索DX</button></form></section>
      </div>`,
    );
  });
  const fs = await import('node:fs');
  await page.addScriptTag({ content: fs.readFileSync(DISAMBIG, 'utf8') });
  const element = await page.evaluateHandle(() => {
    const sections = [...document.querySelectorAll('#poc-zone section')];
    const order = sections.find((s) => s.querySelector('h2')!.textContent === '订单管理')!;
    return order.querySelector('button')!;
  });
  const context = await page.evaluate((el) => window.__DSH_DISAMBIG__(el), element);
  // LLM 故意给错 scope（客户管理）
  const llm = mockLLM({
    candidate: 0,
    scopeHint: { tag: 'section', heading: '客户管理', role: null },
    reason: '故意选错的 scope',
  });
  const outcome = await disambiguateWithLLM(llm, {
    page,
    targetElement: element,
    pwResult: { selector: 'button >> nth=0', matchCount: 2, confidence: 'LOW' },
    context,
  });
  // 错误 scope：count==1 但命中的不是原元素 → 必须拒绝
  expect(outcome.accepted).toBe(false);
  expect(outcome.verification?.isOriginalTarget).toBe(false);
});

declare global {
  interface Window {
    __DSH_PWGEN__: (el: Element) => {
      selector: string;
      unique: boolean;
      matchCount: number;
      confidence: 'HIGH' | 'LOW';
      source: 'playwright';
    };
    __DSH_DISAMBIG__: (
      el: Element,
    ) => {
      target: Record<string, unknown>;
      ancestors: Array<Record<string, unknown>>;
      siblings: Array<Record<string, unknown>>;
      sameNameCandidates: Array<Record<string, unknown>>;
    };
  }
}
