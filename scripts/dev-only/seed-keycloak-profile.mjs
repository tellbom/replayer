// 一次性手工操作脚本（scripts/dev-only/，不进 CI）：
// 等价于用户坐在电脑前，在持久 profile 里登录一次 Keycloak 管理台。
// 账号经环境变量传入，不写入任何文件。用完可删。
//   KC_USER=... KC_PASS=... node scripts/dev-only/seed-keycloak-profile.mjs
import { chromium } from 'playwright';

const user = process.env.KC_USER;
const pass = process.env.KC_PASS;
if (!user || !pass) {
  console.error('需要 KC_USER / KC_PASS 环境变量（不落盘）');
  process.exit(1);
}

const ctx = await chromium.launchPersistentContext('./profiles/keycloak', {
  channel: 'chrome',
  headless: false,
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto('http://192.168.124.2:18085/admin/master/console/');

// 等登录表单（已登录则直接跳过）
await page.waitForSelector('#username', { timeout: 20_000 }).catch(() => {});
if (await page.locator('#username').count()) {
  await page.fill('#username', user);
  await page.fill('#password', pass);
  await page.click('button[type=submit]');
}

// 等进入控制台（Clients 页可达）
await page.waitForURL('**/admin/master/console/**', { timeout: 30_000 });
await page.evaluate(() => { location.hash = '/master/clients'; });
await page.waitForTimeout(5_000);
const clientsVisible = await page.locator('a', { hasText: '创建客户端' }).first().isVisible()
  .catch(() => false);
console.log('Clients 页面可达:', clientsVisible);
console.log('profile 已保留: ./profiles/keycloak');
await ctx.close();
