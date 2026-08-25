// mock-portal：模拟"指纹仪认证 + 子系统跳转"门户（cookie 派）
// 形态复刻：K-2 cookie 持久/会话模式可切换、K-3 门户会话独立计时、
// K-1 一次性 token 60s 用后即焚。纯 Node 无依赖，SSR 输出（无前端框架）。
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const PORT = 4000;
const SESSION_TTL_SECONDS = Number(process.env.PORTAL_SESSION_TTL ?? 14_400);
const SESSION_TTL_MS = SESSION_TTL_SECONDS * 1000;
const COOKIE_MAX_AGE = Number(process.env.PORTAL_COOKIE_MAX_AGE ?? 14_400);

/** portalSid → { user, expiresAt }（内存存储） */
const sessions = new Map();
/** 一次性 token → { user, expiresAt, used }（K-1: 60s 用后即焚）。写文件与 mock-legacy-sys 共享 */
const oneTimeTokens = new Map();
const TOKEN_STORE = new URL('./.tokens.json', import.meta.url);

function persistTokens() {
  // Map 不能 JSON.stringify（会得到 {}），先转普通对象
  try { writeFileSync(TOKEN_STORE, JSON.stringify(Object.fromEntries(oneTimeTokens))); } catch { /* best-effort */ }
}

const COOKIE_MODE = () => (process.env.PORTAL_COOKIE_MODE ?? 'persistent');

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function setSidCookie(res, sid) {
  // K-2: persistent 为默认回归形态；session 模式仍保留用于覆盖浏览器关闭即失效。
  if (COOKIE_MODE() === 'persistent') {
    res.setHeader('Set-Cookie', `PORTAL_SID=${sid}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax`);
  } else {
    res.setHeader('Set-Cookie', `PORTAL_SID=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  }
}

function getSession(req) {
  const sid = parseCookies(req).PORTAL_SID;
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(sid); return null; } // K-3 独立计时
  return s;
}

function html(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...extraHeaders });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // ---------- 登录页 ----------
  if (path === '/portal/login' && req.method === 'GET') {
    return html(res, 200, `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>统一门户登录</title></head>
<body style="font-family:simsun,serif;background:#e8e8e8">
<div style="width:420px;margin:120px auto;background:#fff;border:1px solid #999;padding:24px">
  <h2 style="font-size:16px">集团统一身份门户</h2>
  <p style="color:#555;font-size:13px">请使用指纹仪完成身份认证</p>
  <form id="portal-login-form" method="post" action="/portal/login">
    <input type="hidden" name="device" value="fingerprint-v2">
    <button type="submit" id="fp-btn" style="padding:8px 24px">模拟指纹认证</button>
  </form>
</div></body></html>`);
  }
  if (path === '/portal/login' && req.method === 'POST') {
    const autoAuth = url.searchParams.get('autoAuth') === '1';
    if (!autoAuth) {
      const body = await readBody(req);
      if (!new URLSearchParams(body).has('device')) return html(res, 400, '<h2>需要人工认证动作</h2>');
    }
    // autoAuth 仅供自动化回归；普通路径仍需提交页面上的模拟指纹按钮。
    const sid = randomBytes(16).toString('hex');
    sessions.set(sid, { user: 'EMP010', name: '陈默', expiresAt: Date.now() + SESSION_TTL_MS });
    setSidCookie(res, sid);
    res.writeHead(302, { Location: '/portal' });
    return res.end();
  }

  // ---------- 门户首页 ----------
  if (path === '/portal') {
    const session = getSession(req);
    if (!session) { res.writeHead(302, { Location: '/portal/login' }); return res.end(); }
    return html(res, 200, `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>统一门户</title></head>
<body style="font-family:simsun,serif">
<h2 style="font-size:16px">统一门户 — ${session.name}</h2>
<ul>
  <li><a href="/portal/jump/legacy">Legacy 业务系统</a></li>
  <li><a href="#" onclick="return false">人力资源系统（未接入）</a></li>
</ul>
<p style="color:#888;font-size:12px">会话剩余：${Math.round((session.expiresAt - Date.now()) / 60000)} 分钟</p>
</body></html>`);
  }

  // ---------- 子系统跳转（K-1 一次性 token） ----------
  if (path.startsWith('/portal/jump/')) {
    const session = getSession(req);
    if (!session) { res.writeHead(302, { Location: '/portal/login' }); return res.end(); }
    const sys = path.split('/')[3] ?? '';
    if (sys !== 'legacy') { return html(res, 404, '<h2>未知子系统</h2>'); }
    const token = randomBytes(20).toString('hex');
    oneTimeTokens.set(token, { user: session.user, expiresAt: Date.now() + 60_000, used: false });
    persistTokens();
    res.writeHead(302, { Location: `http://localhost:4100/sso?token=${token}` });
    return res.end();
  }

  // ---------- 门户会话探测端点 ----------
  if (path === '/portal/api/session') {
    const session = getSession(req);
    // K-4 关联：authFailMode=json 时返回 401 JSON；默认 redirect 模式 302 到登录页 HTML
    const mode = url.searchParams.get('authFailMode') ?? process.env.PORTAL_AUTH_FAIL_MODE ?? 'redirect';
    if (!session) {
      if (mode === 'json') {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ loggedIn: false }));
      }
      res.writeHead(302, { Location: '/portal/login' });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ loggedIn: true, user: session.user, name: session.name }));
  }

  // ---------- 调试端点：使门户会话失效 ----------
  if (path === '/portal/_debug/expire' && req.method === 'POST') {
    const sid = parseCookies(req).PORTAL_SID;
    if (sid) sessions.delete(sid);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ expired: true }));
  }

  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<h2>404</h2>');
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let value = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { value += chunk; });
    req.on('end', () => resolve(value));
    req.on('error', reject);
  });
}

// 定期清理过期一次性 token（写回普通对象）
setInterval(() => {
  const now = Date.now();
  let dirty = false;
  for (const [t, v] of oneTimeTokens) if (now > v.expiresAt + 60_000) { oneTimeTokens.delete(t); dirty = true; }
  if (dirty) persistTokens();
}, 30_000).unref();

server.listen(PORT, () => console.log(`[mock-portal] http://localhost:${PORT}  cookieMode=${COOKIE_MODE()}`));
