// 【T-65】no-id 变体重测：六场景全部去除手写静态 id，贴近真实 Vue 形态：
// - class 全为 hash 形态（_btn_9k2ld），data-v-* scoped 属性随 build 变化
// - 业务文案（按钮文字/heading/label）保持稳定——唯一合法锚点
// - 动态 id 模拟组件库运行时生成（el-btn-xxxxxx，每次渲染不同）
// 另含：真 rebuild 3 轮 + 结构链脆弱性两项。
import { expect, test } from '@playwright/test';

const PWGEN = 'packages/locator/dist/pw-selector-generator.iife.js';
const LEGACY = 'packages/locator/dist/selector-generator.iife.js';

declare global {
  interface Window {
    __DSH_PWGEN__: (el: Element) => {
      selector: string;
      unique: boolean;
      matchCount: number;
      confidence: 'HIGH' | 'LOW';
      source: 'playwright';
    };
    __DSH_GEN__: (el: Element) => unknown;
  }
}

/** 注入 no-id 桩（hash class + data-v + 稳定文案；dynamicId 模拟组件库运行时 id） */
async function inject(page: import('@playwright/test').Page, html: string, dynamicId = false) {
  await page.goto('/home');
  await page.waitForTimeout(800);
  await page.evaluate(
    ({ markup, dynamicId }) => {
      document.querySelector('#poc-zone')?.remove();
      const zone = document.createElement('div');
      zone.id = 'poc-zone';
      zone.innerHTML = markup;
      document.body.append(zone);
      if (dynamicId) {
        // 组件库形态：每个按钮带运行时随机 id（每次渲染不同）
        for (const [i, btn] of [...zone.querySelectorAll('button')].entries()) {
          btn.id = `el-btn-${Math.random().toString(36).slice(2, 8)}-${i}`;
        }
      }
    },
    { markup: html, dynamicId },
  );
  const fs = await import('node:fs');
  await page.addScriptTag({ content: fs.readFileSync(PWGEN, 'utf8') });
  await page.addScriptTag({ content: fs.readFileSync(LEGACY, 'utf8') });
}

function pick(page: import('@playwright/test').Page, selector: string) {
  return page.evaluate(
    (sel) => window.__DSH_PWGEN__(document.querySelector(sel)!),
    selector,
  );
}

test('T-65 · 六场景 no-id 重测', async ({ page }) => {
  test.setTimeout(120_000);
  const report: string[] = [];
  const legacyOf = (page: import('@playwright/test').Page, selector: string) =>
    page.evaluate((sel) => window.__DSH_GEN__(document.querySelector(sel)!), selector);

  // ---------- A：no-id 原生 button（hash class + data-v，唯一搜索钮） ----------
  await inject(
    page,
    `<div class="_wrap_x7f2a" data-v-3a9c1b>
       <button class="_btn_9k2ld" data-v-3a9c1b>搜索A</button>
     </div>`,
  );
  const a = await pick(page, '#poc-zone button');
  const aLegacy = await legacyOf(page, '#poc-zone button');
  report.push(`A  pw=${JSON.stringify(a)}  legacy=${JSON.stringify(aLegacy)}`);

  // ---------- B：10 区域同名（无 id） ----------
  const sectionsB = Array.from({ length: 10 }, (_, i) =>
    `<section data-v-3a9c1b><h2>区域${i}管理</h2><button class="_btn_9k2ld" data-v-3a9c1b>搜索B</button></section>`,
  ).join('');
  await inject(page, sectionsB);
  const b = await page.evaluate(() => {
    const sections = [...document.querySelectorAll('#poc-zone section')];
    return window.__DSH_PWGEN__(sections[7]!.querySelector('button')!);
  });
  report.push(`B  pw=${JSON.stringify(b)}`);

  // ---------- C：双同构 form（无 id，无任何区分语义） ----------
  await inject(
    page,
    `<form role="search" data-v-3a9c1b><input><button type="submit" class="_btn_9k2ld">搜索C</button></form>
     <form role="search" data-v-3a9c1b><input><button type="submit" class="_btn_9k2ld">搜索C</button></form>`,
  );
  const c = await page.evaluate(() => {
    const forms = [...document.querySelectorAll('#poc-zone form')];
    return window.__DSH_PWGEN__(forms[1]!.querySelector('button')!);
  });
  report.push(`C  pw=${JSON.stringify(c)}`);

  // ---------- D：客户/订单管理 section（无 id） ----------
  await inject(
    page,
    `<section data-v-3a9c1b><h2>客户管理</h2><form role="search"><button type="submit" class="_btn_9k2ld">搜索D</button></form></section>
     <section data-v-3a9c1b><h2>订单管理</h2><form role="search"><button type="submit" class="_btn_9k2ld">搜索D</button></form></section>`,
  );
  const d = await page.evaluate(() => {
    const sections = [...document.querySelectorAll('#poc-zone section')];
    const order = sections.find((s) => s.querySelector('h2')!.textContent === '订单管理')!;
    return window.__DSH_PWGEN__(order.querySelector('button')!);
  });
  report.push(`D  pw=${JSON.stringify(d)}`);

  // ---------- E：真 rebuild 3 轮（替换原无效场景） ----------
  const eRounds: string[] = [];
  await inject(
    page,
    `<div class="_wrap_x7f2a" data-v-3a9c1b>
       <button class="_submitBtn_a83kd_12xQf" data-v-3a9c1b>提交E</button>
     </div>`,
  );
  let recordedSelector: string | null = null;
  for (let round = 1; round <= 3; round += 1) {
    if (round === 1) {
      recordedSelector = (await pick(page, '#poc-zone button')).selector;
      eRounds.push(`轮次1 录制: ${recordedSelector}`);
      continue;
    }
    // rebuild：hash class/data-v 全变 + 插入一层无关 wrapper（DOM 结构变化）
    const survives = await page.evaluate(
      ({ selector, round }) => {
        const btn = document.querySelector('#poc-zone button')!;
        btn.className = `_submitBtn_h${round}f9k2_zZ${round}wQ`;
        btn.removeAttribute('data-v-3a9c1b');
        btn.setAttribute(`data-v-b${round}ee12`, '');
        // 结构变化：包一层 div
        const wrapper = document.createElement('div');
        wrapper.className = `_wrap_dyn${round}`;
        btn.parentElement!.insertBefore(wrapper, btn);
        wrapper.append(btn);
        // 用已录 selector 重新解析（借助生成器同源的引擎语义：重查匹配数）
        // 简化验证：重新生成 selector，看它是否还指向同一元素且不依赖旧 hash
        return window.__DSH_PWGEN__(btn);
      },
      { selector: recordedSelector, round },
    );
    const stale = await page.evaluate((selector) => {
      // 旧 selector 直接查询是否还能命中唯一元素
      try {
        return document.querySelectorAll(selector.replace(/^css=|>>.*$/, '').trim()).length;
      } catch {
        return -1;
      }
    }, recordedSelector);
    eRounds.push(
      `轮次${round} rebuild后: 旧selector="${recordedSelector}" 原样查询命中=${stale} | 同元素新生成=${JSON.stringify(survives)}`,
    );
    recordedSelector = survives.selector;
  }
  report.push(...eRounds.map((l) => `E  ${l}`));

  // ---------- F：同文本不同 type（无 id） ----------
  await inject(
    page,
    `<form data-v-3a9c1b>
       <button type="submit" class="_btn_9k2ld">搜索F</button>
       <button type="button" class="_btn_9k2ld">搜索F</button>
     </form>`,
  );
  const fSubmit = await page.evaluate(() => window.__DSH_PWGEN__(document.querySelector('#poc-zone form button[type=submit]')!));
  const fPlain = await page.evaluate(() => window.__DSH_PWGEN__(document.querySelector('#poc-zone form button[type=button]')!));
  report.push(`F  pw-submit=${JSON.stringify(fSubmit)}`);
  report.push(`F  pw-plain=${JSON.stringify(fPlain)}`);

  // ---------- 结构链脆弱性（B 场景 selector） ----------
  await inject(page, sectionsB);
  const fragility: string[] = [];
  const fragTest = async (label: string, mutate: string) => {
    const outcome = await page.evaluate(
      ({ mutateFn }) => {
        const fn = new Function('return ' + mutateFn) as () => void;
        fn();
        const sections = [...document.querySelectorAll('#poc-zone section')];
        const target = sections.find((s) => s.querySelector('h2')!.textContent === '区域7管理')!;
        return window.__DSH_PWGEN__(target.querySelector('button')!);
      },
      { mutateFn: mutate },
    );
    fragility.push(`${label}: ${JSON.stringify(outcome)}`);
  };
  await fragTest('前插section', `() => {
    const s = document.createElement('section'); s.innerHTML = '<h2>新区域管理</h2><button>搜索B</button>';
    const zone = document.querySelector('#poc-zone');
    zone.insertBefore(s, zone.querySelector('section'));
  }`);
  await fragTest('后插section', `() => {
    const s = document.createElement('section'); s.innerHTML = '<h2>新区域管理</h2><button>搜索B</button>';
    document.querySelector('#poc-zone').append(s);
  }`);
  await fragTest('内部包div', `() => {
    const target = [...document.querySelectorAll('#poc-zone section')].find(s => s.querySelector('h2').textContent === '区域7管理');
    const btn = target.querySelector('button');
    const w = document.createElement('div'); w.className = '_inner_dyn';
    btn.parentElement.insertBefore(w, btn); w.append(btn);
  }`);
  report.push(...fragility.map((l) => `FRAG ${l}`));

  console.log('\n===== T-65 NO-ID REPORT =====\n' + report.join('\n'));
});

test('T-65 · 动态 id（组件库形态）下 A 场景退化验证', async ({ page }) => {
  await inject(
    page,
    `<div class="_wrap_x7f2a" data-v-3a9c1b><button class="_btn_9k2ld" data-v-3a9c1b>搜索AD</button></div>`,
    true, // dynamicId：el-btn-xxxxxx 运行时随机
  );
  const result = await pick(page, '#poc-zone button');
  // 动态 id 下产物不得依赖运行时 id（el-btn-*），否则渲染即断
  console.log('A-dynamic-id →', JSON.stringify(result));
  expect(result.selector).not.toMatch(/el-btn-/);
});
