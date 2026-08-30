// DSH 覆盖矩阵摸底驱动（DSH-覆盖矩阵摸底任务-GLM.md §3 五步流程）
// 铁律：不修改 packages/ 任何代码；崩溃/异常如实记录并继续下一格。
// 产物：tmp/matrix-<cell>/{record.json, entry.yaml, draft.yaml, summary.json}
import { expect, test } from '@playwright/test';
import { generateDraft } from '@dsh/analyzer';
import { parseEntry } from '@dsh/core';
import type { Entry, Skill } from '@dsh/core';
import { record } from '@dsh/recorder';
import { replay } from '@dsh/replayer';
import type { RecordSession } from '@dsh/core';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { startMatrixServer, type MatrixServer } from './matrix-fixture';
import { CELLS, type CellSpec } from './cells';

test.setTimeout(300_000);

interface ReplayAttempt {
  ok: boolean;
  result?: {
    ok: boolean;
    skillId: string;
    reentryCount: number;
    steps: Array<{
      stepId: string;
      ok: boolean;
      outcome: string;
      channelUsed: string;
      error?: string;
      raw?: { status?: number; text?: string };
    }>;
  };
  error?: string;
}

function extractTemplateParams(template: unknown, values: unknown, out: Record<string, unknown>): void {
  if (typeof template === 'string') {
    const match = /^\{\{([^}|]+?)(\|[^}]*)?\}\}$/.exec(template.trim());
    if (match && values !== undefined && values !== null && !(match[1]!.trim() in out)) out[match[1]!.trim()] = values;
    return;
  }
  if (Array.isArray(template)) {
    if (Array.isArray(values)) template.forEach((item, index) => extractTemplateParams(item, values[index], out));
    return;
  }
  if (template && typeof template === 'object') {
    if (values && typeof values === 'object' && !Array.isArray(values)) {
      for (const [key, value] of Object.entries(template)) {
        extractTemplateParams(value, (values as Record<string, unknown>)[key], out);
      }
    }
  }
}

function templateParamsFromSkill(skill: Skill, body: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const step of skill.steps) {
    if (step.network?.body !== undefined && step.network.body !== null) {
      extractTemplateParams(step.network.body, body, out);
    }
  }
  return out;
}

async function runReplay(
  skill: Skill,
  params: Record<string, unknown>,
  entry: Entry,
  profileDir: string,
): Promise<ReplayAttempt> {
  try {
    const result = await replay(skill, {
      params,
      profileDir,
      entry,
      noLLM: true,
      supervisedVerification: true,
      onConfirm: async () => true,
      onLowTarget: async () => true,
    });
    return {
      ok: true,
      result: {
        ok: result.ok,
        skillId: result.skillId,
        reentryCount: result.reentryCount,
        steps: result.steps.map((step) => ({
          stepId: step.stepId,
          ok: step.ok,
          outcome: step.outcome,
          channelUsed: step.channelUsed,
          error: step.error,
          raw: step.raw,
        })),
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? String(error.stack ?? error) : String(error) };
  }
}

interface CellSummary {
  cell: string;
  desc: string;
  baseUrl: string;
  fixtureHash: string;
  record: { ok: boolean; error?: string; actions?: number; actionTypes?: string[] };
  analyze: { ok: boolean; error?: string; params?: unknown[]; steps?: unknown[] };
  recordedServerRecords?: unknown[];
  replay1: ReplayAttempt & { paramsUsed?: unknown; paramCoverage?: Array<{ name: string; type: string; source: string; value: unknown }> };
  serverRecords1?: unknown[];
  replay2: ReplayAttempt & { paramsUsed?: unknown };
  serverRecords2?: unknown[];
  verification1?: StoredVerification;
  verification2?: StoredVerification;
}

interface StoredVerification {
  status: 'pass' | 'fail' | 'unverified' | 'not-applicable';
  expected: unknown;
  stored: unknown;
  differences: string[];
  transformation?: string;
}

function cloneValues<T>(value: T): T {
  return structuredClone(value);
}

function reportedSuccess(attempt: ReplayAttempt): boolean {
  return attempt.ok && attempt.result?.ok === true
    && attempt.result.steps.every((step) => step.ok && step.outcome === 'confirmed_success');
}

function latestRecord(records: unknown[] | undefined): Record<string, unknown> | undefined {
  const value = records?.at(-1);
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function expectedReplay2(
  original: unknown,
  caller: Record<string, unknown>,
  explicit: Record<string, unknown> | undefined,
): unknown {
  if (explicit) return explicit;
  if (!original || typeof original !== 'object' || Array.isArray(original)) return caller;
  const expected = cloneValues(original as Record<string, unknown>);
  for (const [name, value] of Object.entries(caller)) {
    if (Object.prototype.hasOwnProperty.call(expected, name)) expected[name] = value;
  }
  return expected;
}

function compareStored(
  attempt: ReplayAttempt,
  records: unknown[] | undefined,
  expected: unknown,
  caller: Record<string, unknown>,
): StoredVerification {
  if (!reportedSuccess(attempt)) {
    return { status: 'not-applicable', expected, stored: latestRecord(records), differences: [] };
  }
  const record = latestRecord(records);
  if (!record) {
    return { status: 'fail', expected, stored: undefined, differences: ['回放报告成功但服务端无落库记录'] };
  }
  if (typeof record.raw === 'string' && /multipart\/form-data/i.test(String(record.contentType))) {
    const paths = Object.values(caller).flatMap((value) => Array.isArray(value) ? value : [value])
      .filter((value): value is string => typeof value === 'string');
    const missing = paths.map((path) => basename(path)).filter((name) => !record.raw!.includes(`filename="${name}"`));
    return {
      status: missing.length === 0 ? 'pass' : 'fail', expected: paths.map((path) => basename(path)), stored: record.raw,
      differences: missing.map((name) => `multipart 未落库文件名 ${name}`),
      transformation: '调用方文件路径按浏览器 multipart 规则转换为 filename；逐个比较 basename。',
    };
  }
  if (!('parsed' in record)) {
    return { status: 'unverified', expected, stored: record.raw, differences: ['服务端未提供可比较的 parsed 原文'] };
  }
  const differences: string[] = [];
  compareFields(expected, record.parsed, '$', differences);
  return { status: differences.length === 0 ? 'pass' : 'fail', expected, stored: record.parsed, differences };
}

function compareFields(expected: unknown, actual: unknown, path: string, differences: string[]): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) { differences.push(`${path}: 期望数组，实际 ${JSON.stringify(actual)}`); return; }
    if (expected.length !== actual.length) differences.push(`${path}: 数组长度 ${expected.length} -> ${actual.length}`);
    expected.forEach((value, index) => compareFields(value, actual[index], `${path}[${index}]`, differences));
    return;
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
      differences.push(`${path}: 期望对象，实际 ${JSON.stringify(actual)}`); return;
    }
    for (const [key, value] of Object.entries(expected)) {
      compareFields(value, (actual as Record<string, unknown>)[key], `${path}.${key}`, differences);
    }
    return;
  }
  if (!Object.is(expected, actual)) differences.push(`${path}: ${JSON.stringify(expected)} -> ${JSON.stringify(actual)}`);
}

for (const spec of CELLS as CellSpec[]) {
  test(`${spec.desc}`, async () => {
    const outDir = join(process.cwd(), 'tmp', `matrix-${spec.cell}`);
    const server: MatrixServer = await startMatrixServer();
    const summary: CellSummary = {
      cell: spec.cell,
      desc: spec.desc,
      baseUrl: server.baseUrl,
      fixtureHash: server.hash,
      record: { ok: false },
      analyze: { ok: false },
      replay1: { ok: false },
      replay2: { ok: false },
    };
    try {
      await mkdir(outDir, { recursive: true });
      const entry = parseEntry(`
entry:
  id: matrix-${spec.cell}
  name: matrix ${spec.cell}
  via: direct
  directUrl: ${server.baseUrl}/${spec.cell}
  landingUrlPattern: /${spec.cell}
  sessionType: cookie
  sessionProbe: { url: /probe, okStatus: [200] }
  identityProbe: { url: /identity, jsonPath: $.principal, requiresAuth: true }
  sessionHolding: { strategy: probe-only }
`);
      await writeFile(join(outDir, 'entry.yaml'), `# baseUrl: ${server.baseUrl}\n# fixture hash: ${server.hash}\n`, 'utf8');

      let extra: Record<string, unknown> = {};
      if (spec.prepare) extra = { ...extra, ...(await spec.prepare(outDir)) };

      // ① 录制
      let session: RecordSession | null = null;
      try {
        let stop!: () => void;
        const stopSignal = new Promise<void>((resolveStop) => { stop = resolveStop; });
        session = await record({
          entry,
          profileDir: join(outDir, 'record-profile'),
          outDir,
          channel: 'chrome',
          headless: true,
          stopSignal,
          onReady: async (page) => {
            await page.goto(`${server.baseUrl}/${spec.cell}`);
            await page.locator('button[class^=submit-]').waitFor({ state: 'visible' });
            await spec.operate(page, server.baseUrl, extra);
            stop();
          },
        });
        summary.record = {
          ok: true,
          actions: session.actions.length,
          actionTypes: session.actions.map((action) => action.type),
        };
      } catch (error) {
        summary.record = {
          ok: false,
          error: error instanceof Error ? String(error.stack ?? error) : String(error),
        };
      }
      summary.recordedServerRecords = server.records(spec.cell);

      // ③ 分析
      let skill: Skill | null = null;
      if (session) {
        try {
          const draft = generateDraft(session);
          await writeFile(join(outDir, 'draft.yaml'), draft.yaml, 'utf8');
          skill = draft.skill;
          summary.analyze = {
            ok: true,
            params: skill.params as unknown[],
            steps: skill.steps.map((step) => ({
              id: step.id,
              channel: step.channel,
              ui: step.ui ? { action: step.ui.action, value: step.ui.value } : undefined,
              network: step.network
                ? { method: step.network.method, url: step.network.url, body: step.network.body }
                : undefined,
            })),
          };
        } catch (error) {
          summary.analyze = {
            ok: false,
            error: error instanceof Error ? String(error.stack ?? error) : String(error),
          };
        }
      }

      // replay1 参数：优先取录制时 mutating 请求体的原值
      let params1: Record<string, unknown> = {};
      let paramCoverage: CellSummary['replay1']['paramCoverage'] = [];
      if (session && skill) {
        const mutating = (session.network ?? []).filter(
          (request) => request.mutating && request.url.includes(`/records?cell=${spec.cell}`),
        );
        const last = mutating.at(-1);
        let originalBody: Record<string, unknown> = {};
        if (last?.postData) {
          try {
            originalBody = JSON.parse(last.postData) as Record<string, unknown>;
          } catch {
            originalBody = {};
          }
        }
        const templateMapped = templateParamsFromSkill(skill, originalBody);
        paramCoverage = skill.params.map((param) => {
          const def = param as { name: string; type?: string; values?: Array<{ value: string }> };
          if (def.name in originalBody) {
            return { name: def.name, type: String(def.type), source: 'recorded-body', value: originalBody[def.name] };
          }
          if (def.name in templateMapped) {
            return { name: def.name, type: String(def.type), source: 'template-path', value: templateMapped[def.name] };
          }
          if (def.type === 'file') {
            const prepared = Array.isArray(extra.__uploadPaths) ? extra.__uploadPaths : extra.__uploadPath;
            if (prepared) return { name: def.name, type: String(def.type), source: 'prepared-file', value: prepared };
          }
          if (spec.replay1Fallback && def.name in spec.replay1Fallback) {
            return { name: def.name, type: String(def.type), source: 'fallback', value: spec.replay1Fallback[def.name] };
          }
          if (def.values && def.values.length > 0) {
            return { name: def.name, type: String(def.type), source: 'enum-first', value: def.values[0]!.value };
          }
          return { name: def.name, type: String(def.type), source: 'MISSING', value: '<MISSING>' };
        });
        params1 = Object.fromEntries(
          paramCoverage.filter((item) => item.source !== 'MISSING').map((item) => [item.name, item.value]),
        );
      }

      // ⑤ 回放 1（原参数）
      if (skill && session) {
        server.clear(spec.cell);
        const caller1 = cloneValues(params1);
        const attempt1 = await runReplay(skill, params1, entry, join(outDir, 'replay-profile'));
        summary.replay1 = { ...attempt1, paramsUsed: caller1, paramCoverage };
        summary.serverRecords1 = server.records(spec.cell);
        const recorded = latestRecord(summary.recordedServerRecords)?.parsed
          ?? latestRecord(summary.recordedServerRecords)?.raw;
        summary.verification1 = compareStored(attempt1, summary.serverRecords1, recorded, caller1);
        expect(summary.verification1.status, summary.verification1.differences.join('\n')).not.toBe('fail');

        // 回放 2（跨参数）
        if (spec.altParams || spec.altBody) {
          const fileAlternatives: Record<string, unknown> = {};
          for (const param of skill.params.filter((candidate) => candidate.type === 'file')) {
            const sources = Array.isArray(extra.__uploadPaths)
              ? extra.__uploadPaths as string[]
              : extra.__uploadPath ? [extra.__uploadPath as string] : [];
            const replacements = await Promise.all(sources.map(async (source, index) => {
              const target = join(outDir, 'upload', `replacement-${index + 1}-${basename(source)}`);
              await copyFile(source, target);
              return target;
            }));
            fileAlternatives[param.name] = Array.isArray(extra.__uploadPaths) ? replacements : replacements[0];
          }
          const params2 = {
            ...params1, ...templateParamsFromSkill(skill, spec.altBody ?? {}),
            ...spec.altParams, ...fileAlternatives,
          };
          const caller2 = cloneValues(params2);
          server.clear(spec.cell);
          const attempt2 = await runReplay(skill, params2, entry, join(outDir, 'replay-profile-2'));
          summary.replay2 = { ...attempt2, paramsUsed: caller2 };
          summary.serverRecords2 = server.records(spec.cell);
          summary.verification2 = compareStored(
            attempt2,
            summary.serverRecords2,
            expectedReplay2(recorded, caller2, spec.altBody),
            caller2,
          );
          expect(summary.verification2.status, summary.verification2.differences.join('\n')).not.toBe('fail');
        }
      }
    } finally {
      await writeFile(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
      await server.close();
    }
  });
}
