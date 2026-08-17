import type { RecordSession } from '@dsh/core';
import type { Command } from 'commander';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface DiffEntry {
  path: string;
  left: unknown;
  right: unknown;
  suggestedParam: string;
}

export interface RecordingDiff {
  warnings: string[];
  candidates: DiffEntry[];
  fixed: string[];
}

export function configureDiffCommand(program: Command): void {
  program
    .command('diff <left> <right>')
    .description('对比两次录制并找出参数候选')
    .action(async (left: string, right: string) => {
      const report = await diffRecordingFiles(left, right);
      process.stdout.write(renderRecordingDiff(report));
    });
}

export async function diffRecordingFiles(left: string, right: string): Promise<RecordingDiff> {
  const [leftSession, rightSession] = await Promise.all([readSession(left), readSession(right)]);
  return diffRecordings(leftSession, rightSession);
}

export function diffRecordings(left: RecordSession, right: RecordSession): RecordingDiff {
  const warnings: string[] = [];
  const candidates: DiffEntry[] = [];
  const fixed: string[] = [];
  const leftTypes = left.actions.map((action) => action.type);
  const rightTypes = right.actions.map((action) => action.type);
  if (JSON.stringify(leftTypes) !== JSON.stringify(rightTypes)) {
    warnings.push(`动作序列结构不一致: ${leftTypes.join(' → ')} ≠ ${rightTypes.join(' → ')}`);
  }

  const actionCount = Math.min(left.actions.length, right.actions.length);
  for (let index = 0; index < actionCount; index += 1) {
    const leftAction = left.actions[index];
    const rightAction = right.actions[index];
    if (!leftAction || !rightAction || leftAction.value === rightAction.value) continue;
    candidates.push({
      path: `action[${index}].value`,
      left: leftAction.value,
      right: rightAction.value,
      suggestedParam: actionParamName(leftAction.label, leftAction.type),
    });
  }

  const networkCount = Math.min(left.network.length, right.network.length);
  if (left.network.length !== right.network.length) {
    warnings.push(`网络请求数不一致: ${left.network.length} ≠ ${right.network.length}`);
  }
  for (let index = 0; index < networkCount; index += 1) {
    const leftRequest = left.network[index];
    const rightRequest = right.network[index];
    if (!leftRequest || !rightRequest) continue;
    if (requestShape(leftRequest.url, leftRequest.method) !== requestShape(rightRequest.url, rightRequest.method)) {
      warnings.push(`network[${index}] 请求结构不一致`);
      continue;
    }
    compareObjects(
      parseRequestBody(leftRequest.postData, leftRequest.headers['content-type']),
      parseRequestBody(rightRequest.postData, rightRequest.headers['content-type']),
      `network[${index}].body`,
      candidates,
    );
    for (const header of dynamicHeaders(leftRequest.headers, rightRequest.headers)) {
      fixed.push(`network[${index}].headers.${header} → 来自 preflight`);
    }
  }
  return { warnings, candidates, fixed };
}

export function renderRecordingDiff(report: RecordingDiff): string {
  const lines: string[] = [];
  for (const warning of report.warnings) lines.push(`警告：${warning}`);
  lines.push('参数候选（两次录制值不同）：');
  if (report.candidates.length === 0) lines.push('  无');
  for (const candidate of report.candidates) {
    lines.push(
      `  ${candidate.path}    ${JSON.stringify(candidate.left)} ≠ ${JSON.stringify(candidate.right)}    → 建议参数: ${candidate.suggestedParam}`,
    );
  }
  lines.push('', '固定值（不建议参数化）：');
  if (report.fixed.length === 0) lines.push('  无');
  else lines.push(...report.fixed.map((item) => `  ${item}`));
  return `${lines.join('\n')}\n`;
}

async function readSession(path: string): Promise<RecordSession> {
  const resolved = (await stat(path)).isDirectory() ? join(path, 'record.json') : path;
  return JSON.parse(await readFile(resolved, 'utf8'));
}

function requestShape(url: string, method: string): string {
  const parsed = new URL(url);
  return `${method} ${parsed.origin}${parsed.pathname}`;
}

function parseRequestBody(body: string | null, contentType: string | undefined): unknown {
  if (body === null) return null;
  if (contentType?.includes('application/json')) return JSON.parse(body);
  if (contentType?.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(body));
  }
  return body;
}

function compareObjects(
  left: unknown,
  right: unknown,
  path: string,
  candidates: DiffEntry[],
): void {
  if (isRecord(left) && isRecord(right)) {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      compareObjects(left[key], right[key], `${path}.${key}`, candidates);
    }
    return;
  }
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    candidates.push({
      path,
      left,
      right,
      suggestedParam: path.split('.').at(-1) ?? 'value',
    });
  }
}

function dynamicHeaders(
  left: Record<string, string>,
  right: Record<string, string>,
): string[] {
  const names = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...names].filter((name) => /csrf|requestverificationtoken/i.test(name));
}

function actionParamName(label: string | undefined, type: string): string {
  const names: Record<string, string> = {
    '加班类型': 'type',
    '开始时间': 'startTime',
    '结束时间': 'endTime',
    '事由': 'reason',
  };
  return (label && names[label]) || type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
