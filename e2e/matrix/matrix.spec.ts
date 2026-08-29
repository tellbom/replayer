// DSH 覆盖矩阵摸底驱动（DSH-覆盖矩阵摸底任务-GLM.md §3 五步流程）
// 铁律：不修改 packages/ 任何代码；崩溃/异常如实记录并继续下一格。
// 产物：tmp/matrix-<cell>/{record.json, entry.yaml, draft.yaml, summary.json}
import { test } from '@playwright/test';
import { generateDraft } from '@dsh/analyzer';
import { parseEntry } from '@dsh/core';
import type { Entry, Skill } from '@dsh/core';
import { record } from '@dsh/recorder';
import { replay } from '@dsh/replayer';
import type { RecordSession } from '@dsh/core';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { startMatrixServer, type MatrixServer } from './matrix-fixture';
import { CELLS, clickSubmit, waitDone, type CellSpec } from './cells';

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
          if (spec.replay1Fallback && def.name in spec.replay1Fallback) {
            return { name: def.name, type: String(def.type), source: 'fallback', value: spec.replay1Fallback[def.name] };
          }
          if (def.values && def.values.length > 0) {
            return { name: def.name, type: String(def.type), source: 'enum-first', value: def.values[0]!.value };
          }
          return { name: def.name, type: String(def.type), source: 'MISSING', value: '<MISSING>' };
        });
        params1 = Object.fromEntries(paramCoverage.map((item) => [item.name, item.value]));
      }

      // ⑤ 回放 1（原参数）
      if (skill && session) {
        server.clear(spec.cell);
        const attempt1 = await runReplay(skill, params1, entry, join(outDir, 'replay-profile'));
        summary.replay1 = { ...attempt1, paramsUsed: params1, paramCoverage };
        summary.serverRecords1 = server.records(spec.cell);

        // 回放 2（跨参数）
        if (spec.altParams || spec.altBody) {
          const params2 = { ...params1, ...templateParamsFromSkill(skill, spec.altBody ?? {}), ...spec.altParams };
          server.clear(spec.cell);
          const attempt2 = await runReplay(skill, params2, entry, join(outDir, 'replay-profile-2'));
          summary.replay2 = { ...attempt2, paramsUsed: params2 };
          summary.serverRecords2 = server.records(spec.cell);
        }
      }
    } finally {
      await writeFile(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
      await server.close();
    }
  });
}
