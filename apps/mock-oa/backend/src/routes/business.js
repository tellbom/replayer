import { randomUUID } from 'node:crypto';
import { Router } from 'express';

import { APPROVAL_TOKEN_TTL_MS } from '../constants.js';
import { validateCsrf } from '../middleware/csrf.js';

const OVERTIME_TYPES = [
  { value: 'workday', label: '工作日加班' },
  { value: 'weekend', label: '周末加班' },
  { value: 'holiday', label: '节假日加班' },
];

const LEAVE_TYPES = [
  { value: 'annual', label: '年假' },
  { value: 'sick', label: '病假' },
  { value: 'personal', label: '事假' },
];

const APPROVERS = {
  workday: { approverId: 1023, approverName: '张经理' },
  weekend: { approverId: 2046, approverName: '李总监' },
  holiday: { approverId: 4092, approverName: '王副总' },
};

const LEAVE_BALANCES = {
  annual: { balanceId: 301, balanceDays: 8 },
  sick: { balanceId: 302, balanceDays: 20 },
  personal: { balanceId: 303, balanceDays: 5 },
};

const STATIC_HISTORY = Array.from({ length: 200 }, (_, index) => ({
  no: `OT-HISTORY-${String(index + 1).padStart(4, '0')}`,
  type: OVERTIME_TYPES[index % OVERTIME_TYPES.length].value,
  startTime: `2026-07-${String((index % 28) + 1).padStart(2, '0')} 18:00`,
  endTime: `2026-07-${String((index % 28) + 1).padStart(2, '0')} 21:00`,
  reason: `历史加班记录 ${index + 1}`,
  createdAt: new Date(Date.UTC(2026, 6, (index % 28) + 1)).toISOString(),
}));

let submissionSequence = 0;

export function createBusinessRouter() {
  const router = Router();

  router.get('/overtime/types', (_request, response) => response.json(OVERTIME_TYPES));

  router.post('/overtime/approver', (request, response) => {
    const type = String(request.body.type ?? '');
    const approver = APPROVERS[type];
    if (!approver) {
      response.status(400).json({ code: 400, msg: '加班类型无效' });
      return;
    }
    const approvalToken = randomUUID();
    request.session.overtimeApproval = {
      type,
      approverId: approver.approverId,
      approvalToken,
      expiresAt: Date.now() + APPROVAL_TOKEN_TTL_MS,
    };
    response.json({ ...approver, approvalToken });
  });

  router.post('/overtime/submit', validateCsrf, (request, response) => {
    const approval = request.session.overtimeApproval;
    const type = String(request.body.type ?? '');
    const expectedApprover = APPROVERS[type];
    if (!expectedApprover || Number(request.body.approverId) !== expectedApprover.approverId) {
      response.status(400).json({ code: 400, msg: '审批人不匹配' });
      return;
    }
    if (
      !approval ||
      approval.type !== type ||
      approval.approverId !== expectedApprover.approverId ||
      approval.approvalToken !== request.body.approvalToken ||
      approval.expiresAt < Date.now()
    ) {
      response.status(400).json({ code: 400, msg: 'approvalToken 无效或已失效' });
      return;
    }

    delete request.session.overtimeApproval;
    const submission = createOvertimeSubmission(request.body);
    getSubmissions(request).push(submission);

    if (request.query.drop_response === '1') {
      request.session.save(() => request.socket.destroy());
      return;
    }
    response.json({ code: 0, no: submission.no });
  });

  router.get('/overtime/history', (request, response) => {
    if (request.query.limit !== undefined) {
      const limit = Number(request.query.limit);
      const list = getSubmissions(request)
        .filter((item) => item.kind === 'overtime')
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, limit);
      response.json({ list, total: list.length });
      return;
    }
    const page = Math.max(1, Number(request.query.page ?? 1));
    const size = Math.max(1, Number(request.query.size ?? 20));
    const start = (page - 1) * size;
    response.json({ list: STATIC_HISTORY.slice(start, start + size), total: STATIC_HISTORY.length });
  });

  router.get('/leave/types', (_request, response) => response.json(LEAVE_TYPES));

  router.post('/leave/balance', (request, response) => {
    const type = String(request.body.type ?? '');
    const balance = LEAVE_BALANCES[type];
    if (!balance) {
      response.status(400).json({ code: 400, msg: '请假类型无效' });
      return;
    }
    const balanceToken = randomUUID();
    request.session.leaveBalance = {
      type,
      balanceId: balance.balanceId,
      balanceToken,
      expiresAt: Date.now() + APPROVAL_TOKEN_TTL_MS,
    };
    response.json({ ...balance, balanceToken });
  });

  router.post('/leave/submit', validateCsrf, (request, response) => {
    const balance = request.session.leaveBalance;
    const type = String(request.body.type ?? '');
    const expectedBalance = LEAVE_BALANCES[type];
    if (!expectedBalance || Number(request.body.balanceId) !== expectedBalance.balanceId) {
      response.status(400).json({ code: 400, msg: '余额记录不匹配' });
      return;
    }
    if (
      !balance ||
      balance.type !== type ||
      balance.balanceId !== expectedBalance.balanceId ||
      balance.balanceToken !== request.body.balanceToken ||
      balance.expiresAt < Date.now()
    ) {
      response.status(400).json({ code: 400, msg: 'balanceToken 无效或已失效' });
      return;
    }
    delete request.session.leaveBalance;
    const submission = createLeaveSubmission(request.body);
    getSubmissions(request).push(submission);
    response.json({ code: 0, no: submission.no });
  });

  router.get('/_debug/submissions', (request, response) => {
    const list = getSubmissions(request);
    response.json({ count: list.length, list });
  });

  return router;
}

function getSubmissions(request) {
  if (!request.session.submissions) request.session.submissions = [];
  return request.session.submissions;
}

function createOvertimeSubmission(body) {
  submissionSequence += 1;
  const date = new Date();
  return {
    kind: 'overtime',
    no: `OT-${compactDate(date)}-${String(submissionSequence).padStart(4, '0')}`,
    type: String(body.type),
    startTime: String(body.startTime ?? ''),
    endTime: String(body.endTime ?? ''),
    reason: String(body.reason ?? ''),
    createdAt: date.toISOString(),
  };
}

function createLeaveSubmission(body) {
  submissionSequence += 1;
  const date = new Date();
  return {
    kind: 'leave',
    no: `LV-${compactDate(date)}-${String(submissionSequence).padStart(4, '0')}`,
    type: String(body.type),
    startTime: String(body.startTime ?? ''),
    endTime: String(body.endTime ?? ''),
    reason: String(body.reason ?? ''),
    createdAt: date.toISOString(),
  };
}

function compactDate(date) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0'))
    .join('');
}
