import { expect, test } from '@playwright/test';

import { oaEntry, seedProfile } from './fixture';

test('T-68 A2/A3: 正式录制链路重跑 no-id 六场景并输出完整 options', async ({ browserName }, testInfo) => {
  test.setTimeout(120_000);
  const { record } = await import('../packages/recorder/src/session');
  const profile = testInfo.outputPath(`profile-${browserName}`);
  await seedProfile(profile);

  const lowSelectors: string[] = [];
  let options: unknown;
  let stop!: () => void;
  const stopSignal = new Promise<void>((resolve) => { stop = resolve; });
  const session = await record({
    entry: oaEntry,
    profileDir: profile,
    outDir: testInfo.outputPath('record'),
    headless: true,
    stopSignal,
    onDisambiguation: async ({ pwResult }) => {
      lowSelectors.push(pwResult.selector);
      return null;
    },
    onReady: async (page) => {
      await page.goto('http://127.0.0.1:15173/overtime/apply');
      await page.locator('.el-form-item').first().waitFor();
      await page.evaluate(() => {
        const root = document.createElement('div');
        root.innerHTML = `
          <div class="_wrap_a"><button class="_btn_a">搜索A</button></div>
          <div class="audit-b">${Array.from({ length: 10 }, (_, index) =>
            `<section><h2>区域${index}管理</h2><button class="_btn_b">搜索B</button></section>`,
          ).join('')}</div>
          <div class="audit-c">
            <form role="search"><input><button type="submit">搜索C</button></form>
            <form role="search"><input><button type="submit">搜索C</button></form>
          </div>
          <div class="audit-d">
            <section><h2>客户管理</h2><button type="button">搜索D</button></section>
            <section><h2>订单管理</h2><button type="button">搜索D</button></section>
          </div>
          <div class="_wrap_e"><button class="_submit_e">提交E</button></div>
          <div class="audit-f">
            <button type="submit">搜索F</button><button type="button">搜索F</button>
          </div>`;
        root.addEventListener('submit', (event) => event.preventDefault());
        document.body.append(root);
        (root.querySelector('._wrap_a button') as HTMLElement).click();
        (root.querySelectorAll('.audit-b section')[7]!.querySelector('button') as HTMLElement).click();
        (root.querySelectorAll('.audit-c form')[1]!.querySelector('button') as HTMLElement).click();
        (root.querySelectorAll('.audit-d section')[1]!.querySelector('button') as HTMLElement).click();
        (root.querySelector('._wrap_e button') as HTMLElement).click();
        (root.querySelectorAll('.audit-f button')[1] as HTMLElement).click();
      });
      options = await page.evaluate(() => Reflect.get(window, '__DSH_PWGEN_OPTIONS__'));
      stop();
    },
  });

  const results = Object.fromEntries(
    session.canonicalActions
      .filter((action) => action.kind === 'activate'
        && /^(搜索[ABCDF]|提交E)$/.test(action.after?.self?.textContent ?? ''))
      .map((action) => [
        action.after?.self?.textContent,
        {
          strategy: 'playwright',
          selector: action.target?.locatorEvidence?.generatedSelector,
          confidence: action.target?.locatorEvidence?.confidence,
        },
      ]),
  );
  expect(options).toEqual({ testIdAttributeName: 'data-testid', noCSSId: true });
  expect(Object.keys(results)).toHaveLength(6);
  expect(results['搜索A']?.confidence).toBe('HIGH');
  expect(results['搜索B']?.confidence).toBe('HIGH');
  expect(results['搜索C']?.confidence).toBe('LOW');
  expect(results['搜索D']?.confidence).toBe('HIGH');
  expect(results['提交E']?.confidence).toBe('HIGH');
  expect(results['搜索F']?.confidence).toBe('LOW');
  expect(lowSelectors).toHaveLength(2);
  console.log('\n===== T-68 FORMAL-CHAIN REPORT =====');
  console.log('options=' + JSON.stringify(options));
  for (const [scenario, result] of Object.entries(results)) {
    console.log(`${scenario}=${JSON.stringify(result)}`);
  }
});

test('T-68 A4: 官方 Playwright Codegen 对同一六场景输出原始 locator', async ({ context, page }) => {
  const recorderContext = context as unknown as {
    _exposeConsoleApi: () => Promise<void>;
  };
  await recorderContext._exposeConsoleApi();
  const html = `
    <div class="_wrap_a"><button class="_btn_a">搜索A</button></div>
    <div class="audit-b">${Array.from({ length: 10 }, (_, index) =>
      `<section><h2>区域${index}管理</h2><button class="_btn_b">搜索B</button></section>`,
    ).join('')}</div>
    <div class="audit-c">
      <form role="search"><input><button type="submit">搜索C</button></form>
      <form role="search"><input><button type="submit">搜索C</button></form>
    </div>
    <div class="audit-d">
      <section><h2>客户管理</h2><button type="button">搜索D</button></section>
      <section><h2>订单管理</h2><button type="button">搜索D</button></section>
    </div>
    <div class="_wrap_e"><button class="_submit_e">提交E</button></div>
    <div class="audit-f">
      <button type="submit">搜索F</button><button type="button">搜索F</button>
    </div>`;
  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const codes = await page.evaluate(() => {
    const api = Reflect.get(window, 'playwright') as {
      generateLocator: (element: Element, language?: string) => string;
    };
    const elements = [
      document.querySelector('._wrap_a button')!,
      document.querySelectorAll('.audit-b section')[7]!.querySelector('button')!,
      document.querySelectorAll('.audit-c form')[1]!.querySelector('button')!,
      document.querySelectorAll('.audit-d section')[1]!.querySelector('button')!,
      document.querySelector('._wrap_e button')!,
      document.querySelectorAll('.audit-f button')[1]!,
    ];
    return elements.map((element) => api.generateLocator(element, 'javascript'));
  });

  console.log('\n===== T-68 OFFICIAL CODEGEN RAW =====');
  for (const code of codes) console.log(code);
  expect(codes[0]).toBe("getByRole('button', { name: '搜索A' })");
  expect(codes[4]).toBe("getByRole('button', { name: '提交E' })");
});
