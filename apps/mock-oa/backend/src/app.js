import express from 'express';
import session from 'express-session';

import { SESSION } from './constants.js';
import { getCsrfToken } from './middleware/csrf.js';
import { apiDelay } from './middleware/delay.js';
import { createBusinessRouter } from './routes/business.js';

const PUBLIC_API_PATHS = new Set(['/api/login', '/api/session', '/api/csrf']);

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
      cookie: { httpOnly: true, sameSite: 'lax' },
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

  return app;
}
