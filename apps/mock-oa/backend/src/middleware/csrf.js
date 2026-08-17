import { randomUUID } from 'node:crypto';

export function getCsrfToken(request) {
  if (!request.session.csrfToken) request.session.csrfToken = randomUUID();
  return request.session.csrfToken;
}

export function validateCsrf(request, response, next) {
  const expected = request.session.csrfToken;
  const actual = request.get('X-CSRF-TOKEN');
  if (!expected || actual !== expected) {
    response.status(403).json({ code: 403, msg: 'CSRF token 无效' });
    return;
  }
  next();
}
