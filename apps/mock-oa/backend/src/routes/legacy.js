import { randomUUID } from 'node:crypto';
import { Router } from 'express';

export function createLegacyRouter() {
  const router = Router();

  router.use((request, response, next) => {
    if (!request.session.user) {
      response.status(401).send('未登录');
      return;
    }
    next();
  });

  router.get('/overtime', (request, response) => {
    const viewState = randomUUID();
    const token = randomUUID();
    request.session.legacyOvertime = { viewState, token };
    response.type('html').send(renderForm(viewState, token));
  });

  router.post('/overtime/submit', (request, response) => {
    const expected = request.session.legacyOvertime;
    if (
      !expected ||
      request.body.__VIEWSTATE !== expected.viewState ||
      request.body.__TOKEN !== expected.token
    ) {
      response.status(400).type('html').send('<h1>隐藏字段校验失败</h1>');
      return;
    }
    delete request.session.legacyOvertime;
    response.type('html').send('<!doctype html><html><body><h1>提交成功</h1></body></html>');
  });

  return router;
}

function renderForm(viewState, token) {
  return `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="UTF-8"><title>Legacy 加班申请</title></head>
  <body>
    <h1>Legacy 加班申请</h1>
    <form method="post" action="/legacy/overtime/submit">
      <input type="hidden" name="__VIEWSTATE" value="${viewState}">
      <input type="hidden" name="__TOKEN" value="${token}">
      <label>加班类型 <select name="type"><option value="workday">工作日加班</option></select></label>
      <label>事由 <textarea name="reason"></textarea></label>
      <button type="submit">提交</button>
    </form>
  </body>
</html>`;
}
