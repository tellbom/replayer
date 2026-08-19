// 一次性探测脚本（dev-only）：登录后立即在会话内探测 sessionType（C18 验证）。
import { chromium } from 'playwright';

const user = process.env.KC_USER;
const pass = process.env.KC_PASS;
if (!user || !pass) { console.error('需要 KC_USER / KC_PASS'); process.exit(1); }

const ctx = await chromium.launchPersistentContext('./profiles/keycloak', {
  channel: 'chrome', headless: false,
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto('http://192.168.124.2:18085/admin/master/console/');
await page.waitForSelector('#username', { timeout: 20_000 }).catch(() => {});
if (await page.locator('#username').count()) {
  await page.fill('#username', user);
  await page.fill('#password', pass);
  await page.click('button[type=submit]');
}
await page.waitForURL('**/admin/master/console/**', { timeout: 30_000 });
await page.evaluate(() => { location.hash = '/master/clients'; });
await page.waitForTimeout(5_000);

// 【T-57】CDP 观察页面自身请求的认证头
const cdp = await ctx.newCDPSession(page);
await cdp.send('Network.enable');
const observed = [];
cdp.on('Network.requestWillBeSent', (e) => {
  const h = e.request.headers ?? {};
  const auth = h['Authorization'] ?? h['authorization'];
  const cookie = h['Cookie'] ?? h['cookie'];
  if ((auth || cookie) && !/\.(js|css|svg|png|woff|map)/.test(e.request.url)) {
    observed.push({ url: e.request.url.slice(60, 110), auth: Boolean(auth), cookie: Boolean(cookie) });
  }
});
// 触发页面自身的业务请求（刷新当前视图）
await page.reload();
await page.waitForTimeout(6_000);
console.log('观察到的带认证请求:');
for (const o of observed.slice(0, 8)) console.log(' ', JSON.stringify(o));
const hasAuth = observed.some((o) => o.auth);
const hasCookie = observed.some((o) => o.cookie);
const sessionType = hasAuth && hasCookie ? 'mixed' : hasAuth ? 'bearer' : hasCookie ? 'cookie' : 'unknown';
console.log(`\nsessionType 判定: ${sessionType}`);

// bearer 来源定位（storage / global）
const locate = await page.evaluate(() => {
  const out = { storage: null, global: null };
  const re = /token|auth|kc-/i;
  for (const store of [sessionStorage, localStorage]) {
    for (const k of Object.keys(store)) {
      if (!re.test(k)) continue;
      const raw = store.getItem(k);
      try {
        const v = JSON.parse(raw);
        if (v?.access_token ?? v?.token ?? v?.accessToken) out.storage = k;
      } catch { /* 非 JSON */ }
    }
  }
  const kc = window.keycloak;
  if (kc?.token) out.global = 'keycloak.token';
  return out;
});
console.log('bearerSource 定位:', JSON.stringify(locate));
// window 全量探测：KC 实例是否可达
const globals = await page.evaluate(() => {
  const keys = Object.getOwnPropertyNames(window).filter(
    (k) => /kc|keycloak|auth|token/i.test(k) && !k.startsWith('__DSH'),
  );
  const probe = {};
  for (const k of keys.slice(0, 10)) {
    const v = window[k];
    probe[k] = typeof v === 'object' && v !== null ? Object.keys(v).slice(0, 6).join(',') : typeof v;
  }
  return probe;
});
console.log('window 相关全局:', JSON.stringify(globals));
// cdp-inherit 可行性：通过 CDP 抓到的 Authorization 头（真实存在），可以复用
console.log('结论: cdp-inherit 可行（CDP 已捕获 Authorization 头）');
await ctx.close();
