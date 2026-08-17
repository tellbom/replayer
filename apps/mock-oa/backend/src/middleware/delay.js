import { DELAY } from '../constants.js';

export function apiDelay(request, _response, next) {
  if (request.query._nodelay === '1') {
    next();
    return;
  }
  const duration = DELAY.minMs + Math.floor(Math.random() * (DELAY.maxMs - DELAY.minMs + 1));
  setTimeout(next, duration);
}
