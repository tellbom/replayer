// v2.0 e2e 共享基建：entry 形态的技能加载 / 录制 / 门户登录
import { parseEntry, parseSkill } from '@dsh/core';
import type { Entry, Skill } from '@dsh/core';
import { record } from '@dsh/recorder';
import type { RecordSession } from '@dsh/core';
import { readFile } from 'node:fs/promises';
import type { Page } from '@playwright/test';

export const oaEntry: Entry = parseEntry(await readFile('entries/oa.yaml', 'utf8'));
export const entryResolver = (): ((id: string) => Entry) => () => oaEntry;

export async function loadOvertimeSkill(): Promise<Skill> {
  return parseSkill(await readFile('skills/oa_overtime_submit.yaml', 'utf8'), entryResolver());
}

/** 门户登录（e2e 种子：等价于用户坐在浏览器前登录一次） */
export async function portalLogin(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('用户名').fill('tester');
  await page.getByLabel('密码').fill('tester');
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL('**/home');
}

/** v2.0 录制：entry 建立会话后开始，不含登录动作 */
export async function recordBusiness(
  profileDir: string,
  outDir: string,
  action: (page: Page) => Promise<void>,
): Promise<RecordSession> {
  let stop!: () => void;
  const stopSignal = new Promise<void>((resolveStop) => { stop = resolveStop; });
  return record({
    entry: oaEntry,
    profileDir,
    outDir,
    headless: true,
    stopSignal,
    onReady: async (page) => {
      await page.goto('/overtime/apply');
      await page.locator('.el-form-item').first().waitFor();
      await action(page);
      stop();
    },
  });
}

/** 为全新 profile 种子门户会话（等价于用户此前登录过）。 */
export async function seedProfile(profileDir: string): Promise<void> {
  const { chromium } = await import('playwright');
  const ctx = await chromium.launchPersistentContext(profileDir, { channel: 'chrome', headless: true });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto('http://127.0.0.1:5173/login');
    await page.evaluate(() =>
      fetch('/api/login?cookieMode=persistent&_nodelay=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'tester', password: 'tester' }),
      }),
    );
  } finally {
    await ctx.close();
  }
}
