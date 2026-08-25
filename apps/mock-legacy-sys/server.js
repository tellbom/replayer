// mock-legacy-sys：模拟老式 C# MVC / JSP 子系统（cookie 派 + __VIEWSTATE）
// 形态复刻：
//   K-1 一次性 token 由门户颁发、此处校验并焚毁
//   K-2 JSESSIONID 会话 cookie 无 Max-Age（cookieMode 开关）
//   K-3 子系统会话 5 分钟独立计时（可 SUB_TTL_MS 调）
//   K-4 401/未认证 = 302 到门户 HTML（authFailMode=json 可切换）
//   K-5 __VIEWSTATE/__TOKEN 每次 GET 都不同
//   K-6 原生 select/radio/checkbox
//   K-7 提交按钮 = <div onclick> + hash class
//   K-8 label 一半带 for 一半不带且无 placeholder
//   K-9 服务端字段依赖：submit 校验 seqCode 必须等于本次表单页下发的值
//   K-10 提交成功后 302 到 /records
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const PORT = 4100;
const PORTAL = 'http://localhost:4000';
const SUB_TTL_MS = Number(process.env.SUB_SESSION_TTL ?? 300) * 1000;

/** jsessionid → { user, name, expiresAt } */
const subSessions = new Map();
/** 一次性 token 白名单（由 mock-portal 写入共享文件；同进程族约定：直接内联校验函数） */
import { accessSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const TOKEN_STORE = '../mock-portal/.tokens.json';
/** records 落库 */
const records = [];

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setJsessionCookie(res, sid) {
  // K-2: 默认无 Max-Age
  if (process.env.SUB_COOKIE_MODE === 'persistent') {
    res.setHeader('Set-Cookie', `JSESSIONID=${sid}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax`);
  } else {
    res.setHeader('Set-Cookie', `JSESSIONID=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  }
}
function getSubSession(req) {
  const sid = parseCookies(req).JSESSIONID;
  if (!sid) return null;
  const s = subSessions.get(sid);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { subSessions.delete(sid); return null; }
  return s;
}
function html(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(body);
}
function redirect(res, loc) { res.writeHead(302, { Location: loc }); res.end(); }

// ---------- 一次性 token 共享（portal 与 sub 是两个进程，用文件共享最简单） ----------
function consumeToken(token) {
  try {
    const map = JSON.parse(readFileSync(new URL(TOKEN_STORE, import.meta.url), 'utf8'));
    const t = map[token];
    const now = Date.now();
    if (!t || t.used || t.expiresAt < now) return null;
    map[token] = { ...t, used: true }; // K-1: 焚毁
    writeFileSync(new URL(TOKEN_STORE, import.meta.url), JSON.stringify(map));
    return t;
  } catch { return null; }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const authFailMode = url.searchParams.get('authFailMode') ?? process.env.SUB_AUTH_FAIL_MODE ?? 'redirect';

  // ---------- SSO 一次性令牌入口（K-1/K-4） ----------
  if (path === '/sso') {
    const token = url.searchParams.get('token');
    const t = token ? consumeToken(token) : null;
    if (!t) return redirect(res, `${PORTAL}/portal`); // 无效/已用/过期 → 回门户
    const sid = randomBytes(16).toString('hex');
    subSessions.set(sid, { user: t.user, name: '陈默', expiresAt: Date.now() + SUB_TTL_MS });
    setJsessionCookie(res, sid);
    return redirect(res, '/home');
  }

  // ---------- 业务首页 ----------
  if (path === '/home') {
    const s = getSubSession(req);
    if (!s) {
      if (authFailMode === 'json') {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'unauthenticated' }));
      }
      return redirect(res, `${PORTAL}/portal`); // K-4: 302 到门户（HTML 链）
    }
    return html(res, 200, `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>Legacy 业务系统</title></head>
<body style="font-family:simsun,serif">
<h2 style="font-size:16px;border-bottom:2px solid #336699;padding-bottom:6px">Legacy 业务系统 — ${s.name}</h2>
<ul>
  <li><a href="/form/apply">设备维修申请</a></li>
  <li><a href="/records">申请记录查询</a></li>
</ul>
</body></html>`);
  }

  // ---------- 申请表单（K-5/K-6/K-7/K-8/K-9） ----------
  if (path === '/form/apply' && req.method === 'GET') {
    const s = getSubSession(req);
    if (!s) {
      if (authFailMode === 'json') {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'unauthenticated' }));
      }
      return redirect(res, `${PORTAL}/portal`);
    }
    // K-5: 每次生成新的 VIEWSTATE/TOKEN；K-9: seqCode 必须回传且与本次一致
    const viewState = randomBytes(24).toString('base64');
    const formToken = randomBytes(16).toString('hex');
    const seqCode = `SEQ-${Date.now().toString(36).toUpperCase()}`;
    s.pendingForm = { viewState, formToken, seqCode };
    return html(res, 200, `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>设备维修申请</title>
<style>.submitBtn_a1b2c_{background:#336699;color:#fff;padding:6px 18px;cursor:pointer;display:inline-block}</style></head>
<body style="font-family:simsun,serif">
<h2 style="font-size:16px;border-bottom:2px solid #336699;padding-bottom:6px">设备维修申请</h2>
<form method="post" action="/form/apply/submit" id="applyForm">
  <input type="hidden" name="__VIEWSTATE" value="${viewState}">
  <input type="hidden" name="__TOKEN" value="${formToken}">
  <input type="hidden" name="seqCode" value="${seqCode}">

  <div style="margin-bottom:10px">
    <label for="deviceType">设备类型</label>
    <select name="deviceType" id="deviceType">
      <option value="">--请选择--</option>
      <option value="LAPTOP">笔记本电脑</option>
      <option value="PRINTER">打印机</option>
      <option value="MONITOR">显示器</option>
    </select>
  </div>

  <div style="margin-bottom:10px">
    <label>故障等级</label>
    <input type="radio" name="urgency" value="NORMAL" checked> 一般
    <input type="radio" name="urgency" value="URGENT"> 紧急
    <input type="radio" name="urgency" value="CRITICAL"> 严重
  </div>

  <div style="margin-bottom:10px">
    <label for="desc">故障描述</label>
    <textarea name="desc" id="desc" rows="4" cols="40"></textarea>
  </div>

  <div style="margin-bottom:10px">
    <label>配件更换</label>
    <input type="checkbox" name="parts" value="BATTERY"> 电池
    <input type="checkbox" name="parts" value="SCREEN"> 屏幕
    <input type="checkbox" name="parts" value="KBD"> 键盘
  </div>

  <div style="margin-bottom:10px">
    <label>报修人分机</label>
    <input type="text" name="ext" size="10">
  </div>

  <div class="submitBtn_a1b2c_" onclick="document.getElementById('applyForm').submit()">提 交</div>
</form>
</body></html>`);
  }

  // ---------- 提交（K-5/K-9 校验 + K-10 跳列表） ----------
  if (path === '/form/apply/submit' && req.method === 'POST') {
    const s = getSubSession(req);
    if (!s) {
      if (authFailMode === 'json') {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'unauthenticated' }));
      }
      return redirect(res, `${PORTAL}/portal`);
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const form = new URLSearchParams(body);
      const pf = s.pendingForm;
      // K-5: VIEWSTATE/TOKEN 必须与本次会话下发的一致（且一次性）
      if (!pf || form.get('__VIEWSTATE') !== pf.viewState || form.get('__TOKEN') !== pf.formToken) {
        return html(res, 400, '<h2 style="color:#c00">提交失败：页面已过期，请返回重新填写（VIEWSTATE 校验未通过）</h2>');
      }
      // K-9: seqCode 必须来自前一个 GET 的响应
      if (form.get('seqCode') !== pf.seqCode) {
        return html(res, 400, '<h2 style="color:#c00">提交失败：流水号校验未通过</h2>');
      }
      const rec = {
        id: `RC-${String(records.length + 1).padStart(4, '0')}`,
        deviceType: form.get('deviceType') ?? '',
        urgency: form.get('urgency') ?? '',
        desc: form.get('desc') ?? '',
        parts: form.getAll('parts'),
        ext: form.get('ext') ?? '',
        seqCode: pf.seqCode,
        user: s.user,
        at: new Date().toISOString(),
      };
      records.push(rec);
      s.pendingForm = null; // 焚毁
      return redirect(res, '/records'); // K-10
    });
    return;
  }

  // ---------- 记录列表页（K-10 跳转目标） ----------
  if (path === '/records') {
    const s = getSubSession(req);
    if (!s) {
      if (authFailMode === 'json') {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: 'unauthenticated' }));
      }
      return redirect(res, `${PORTAL}/portal`);
    }
    const rows = [...records].reverse().map((r) =>
      `<tr><td>${r.id}</td><td>${r.deviceType}</td><td>${r.urgency}</td><td>${(r.desc || '').slice(0, 30)}</td><td>${r.parts.join('+') || '-'}</td><td>${r.ext}</td><td>${r.at}</td></tr>`).join('');
    return html(res, 200, `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>申请记录</title></head>
<body style="font-family:simsun,serif">
<h2 style="font-size:16px;border-bottom:2px solid #336699;padding-bottom:6px">申请记录</h2>
<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;font-size:13px">
<tr style="background:#dce6f0"><th>编号</th><th>设备类型</th><th>故障等级</th><th>描述</th><th>配件</th><th>分机</th><th>时间</th></tr>
${rows || '<tr><td colspan="7" style="color:#888">暂无记录</td></tr>'}
</table>
<p><a href="/form/apply">继续申请</a></p>
</body></html>`);
  }

  // ---------- JSON 端点（postcondition / 身份探测） ----------
  if (path === '/api/records') {
    const s = getSubSession(req);
    if (!s) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'unauthenticated' })); // JSON API 保持 JSON 401（与页面 302 分离，真实系统亦常见）
    }
    const limit = Number(url.searchParams.get('limit') ?? 20);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ total: records.length, list: [...records].reverse().slice(0, limit) }));
  }
  if (path === '/api/whoami') {
    const s = getSubSession(req);
    if (!s) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'unauthenticated' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ username: s.user, name: s.name }));
  }

  // ---------- 调试端点 ----------
  if (path === '/_debug/expire-sub' && req.method === 'POST') {
    const sid = parseCookies(req).JSESSIONID;
    if (sid) subSessions.delete(sid);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ expired: true }));
  }
  if (path === '/_debug/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      subSessions: subSessions.size,
      records: records.length,
      cookieMode: process.env.SUB_COOKIE_MODE ?? 'session',
      subTtlMs: SUB_TTL_MS,
    }));
  }

  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<h2>404</h2>');
});

server.listen(PORT, () => console.log(`[mock-legacy-sys] http://localhost:${PORT}`));
