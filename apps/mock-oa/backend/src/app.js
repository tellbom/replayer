import { randomUUID } from 'node:crypto';
import express from 'express';
import session from 'express-session';

import { SESSION } from './constants.js';
import { getCsrfToken } from './middleware/csrf.js';
import { apiDelay } from './middleware/delay.js';
import { createBusinessRouter } from './routes/business.js';
import { createLegacyRouter } from './routes/legacy.js';

const PUBLIC_API_PATHS = new Set([
  '/api/login',
  '/api/session',
  '/api/csrf',
  '/api/userinfo',
]);

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(
    session({
      name: SESSION.cookieName,
      secret: SESSION.secret,
      resave: false,
      saveUninitialized: false,
      // maxAge 模拟真实企业门户的持久会话（session cookie 关闭浏览器即失效，
      // 会导致每次重开 profile 都要重新登录——与内网门户行为不符）
      cookie: { httpOnly: true, sameSite: 'lax', maxAge: SESSION.maxAgeMs },
    }),
  );
  app.use('/api', apiDelay);

  app.post('/api/login', (request, response) => {
    const { username, password } = request.body;
    if (!username || !password) {
      response.status(400).json({ code: 400, msg: '用户名和密码不能为空' });
      return;
    }
    request.session.user = String(username);
    response.json({ loggedIn: true, user: request.session.user });
  });

  app.get('/api/session', (request, response) => {
    const user = request.session.user;
    response.json(user ? { loggedIn: true, user } : { loggedIn: false });
  });

  app.get('/api/csrf', (request, response) => {
    response.json({ token: getCsrfToken(request) });
  });

  // 【v2.0 C21】身份一致性探测：identityProbe 用
  app.get('/api/userinfo', (request, response) => {
    const user = request.session.user;
    if (!user) {
      response.status(401).json({ code: 401, msg: '未登录' });
      return;
    }
    response.json({ sub: user, preferred_username: user });
  });

  // 【v2.0 C19】门户一次性认证跳转：token 单次消费，供 excludeUrlPatterns 验收
  const oneTimeTokens = new Set();
  app.get('/sso/issue', (request, response) => {
    const user = request.session.user;
    if (!user) {
      response.status(401).json({ code: 401, msg: '未登录' });
      return;
    }
    const token = randomUUID();
    oneTimeTokens.add(token);
    response.json({ token });
  });
  app.get('/sso/redirect', (request, response) => {
    const token = String(request.query.token ?? '');
    if (!token || !oneTimeTokens.delete(token)) {
      // token 缺失或已被消费（重放必然失败——这正是 C19 要挡住的）
      response.status(401).send('一次性认证跳转无效或已消费');
      return;
    }
    response.redirect('/home');
  });

  app.use('/api', (request, response, next) => {
    if (PUBLIC_API_PATHS.has(request.path)) {
      next();
      return;
    }
    if (!request.session.user) {
      response.status(401).json({ code: 401, msg: '未登录' });
      return;
    }
    next();
  });

  app.post('/api/_debug/expire', (request, response, next) => {
    request.session.destroy((error) => {
      if (error) {
        next(error);
        return;
      }
      response.json({ expired: true });
    });
  });

  app.get('/api/_debug/forbidden', (_request, response) => {
    response.status(403).json({ code: 403, msg: '无权限' });
  });

  app.use('/api', createBusinessRouter());
  app.use('/legacy', createLegacyRouter());

  return app;
}
