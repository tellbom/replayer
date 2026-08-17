import type { Page } from '@playwright/test';

export async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('用户名').fill('tester');
  await page.getByLabel('密码').fill('tester');
  await page.getByRole('button', { name: '登录' }).click();
  await page.waitForURL('**/home');
}
