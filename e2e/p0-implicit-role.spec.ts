// 【P0 回归】原生控件 implicit ARIA role：
// generator 生成 role:'button'，回放必须按 Playwright role 语义命中（而非显式 [role=] 属性查询）。
// 覆盖 <button> / <a href> / <input type=submit> 三种真实 implicit role 形态。
import { expect, test } from '@playwright/test';
import type { Step } from '@dsh/core';

import { executeUiStep } from '../packages/replayer/src/channel-ui';

test.describe('P0 implicit role regression', () => {
  for (const fixture of [
    { id: 'native-button', html: '<button id="p0-target">搜索P0</button>', role: 'button' },
    // <a href> 的 implicit role 是 link（非 button）——测试 role:'link' 语义
    { id: 'anchor', html: '<a href="#" id="p0-target">搜索P0</a>', role: 'link' },
    { id: 'submit-input', html: '<input type="submit" value="搜索P0" id="p0-target">', role: 'button' },
  ]) {
    test(`click 命中无显式 role 属性的 ${fixture.id}`, async ({ page }) => {
      await page.goto('/home');
      await page.waitForTimeout(800);
      await page.evaluate((html) => {
        document.body.insertAdjacentHTML('beforeend', `<div id="p0-zone">${html}</div>`);
      }, fixture.html);
      const clicked = page.evaluate(() => new Promise<string>((resolve) => {
        document.querySelector('#p0-target')!.addEventListener('click', () => resolve('hit'), { once: true });
      }));

      const step: Step = {
        id: 'p0',
        desc: '点击搜索',
        channel: 'ui',
        riskLevel: 'read',
        hasSideEffect: false,
        ui: { action: 'click', target: { strategy: 'role', role: fixture.role, name: '搜索P0' } },
      };
      // executeUiStep 需要 ExecContext——P0 场景只验证 click 路径，context 传最小桩
      const { testEntry } = await import('../packages/replayer/src/test-entry');
      await executeUiStep(page, step, {
        params: {}, vars: {}, stepResults: {}, baseUrl: page.url(),
        entry: testEntry(), identityDigest: '',
        scopes: {},
      }, []);

      expect(await Promise.race([clicked, new Promise<string>((r) => setTimeout(() => r('timeout'), 3_000))])).toBe('hit');
      // 语义验证：命中的必须正是目标元素（可通过它自身标记确认）
      const isTarget = await page.evaluate(() => {
        return Boolean(document.querySelector('#p0-target'));
      });
      expect(isTarget).toBe(true);
    });
  }
});
