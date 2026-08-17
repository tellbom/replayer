import { ensureLoggedIn, launchDSHContext, recoverAuthentication } from '@dsh/browser';
import {
  ForbiddenError,
  OutcomeUnknownError,
  StepExecutionError,
  resolveTemplate,
} from '@dsh/core';
import type {
  ExecContext,
  Postcondition,
  RunResult,
  Skill,
  Step,
  StepResult,
} from '@dsh/core';
import type { Page } from 'playwright';

import { executeNetworkStep } from './channel-network.js';
import { executeUiStep } from './channel-ui.js';
import { executePreflights } from './preflight.js';

export interface ReplayOptions {
  // 冻结契约允许任意参数值。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: Record<string, any>;
  profileDir: string;
  dryRun?: boolean;
  forceChannel?: 'ui' | 'network';
  noLLM?: boolean;
  onConfirm?: (step: Step, context: ExecContext) => Promise<boolean>;
}

/** 回放统一入口；各执行器按任务顺序接入此编排。 */
export async function replay(skill: Skill, opts: ReplayOptions): Promise<RunResult> {
  if (opts.dryRun) {
    process.stdout.write(renderExecutionPlan(skill, opts));
    return { ok: true, skillId: skill.skill.id, steps: [], extracted: {} };
  }

  const browserContext = await launchDSHContext({ profileDir: opts.profileDir });
  try {
    const page = browserContext.pages()[0] ?? (await browserContext.newPage());
    await page.goto(skill.auth?.probeUrl ?? skill.skill.baseUrl);
    if (skill.auth) await ensureLoggedIn(page, skill.auth);
    const executionContext: ExecContext = {
      params: opts.params,
      vars: {},
      stepResults: {},
      baseUrl: skill.skill.baseUrl,
    };
    await executePreflights(page, skill.preflight, executionContext);
    const stepResults: StepResult[] = [];
    for (const step of skill.steps) {
      const channel = step.channel === 'merged' ? 'merged' : (opts.forceChannel ?? step.channel);
      if (!(await confirmStep(step, executionContext, opts))) {
        stepResults.push(cancelled(step, channel));
        break;
      }
      if (channel === 'merged') {
        stepResults.push(executeMergedStep(step, executionContext, skill.params));
        continue;
      }
      if (channel === 'ui' && step.ui) {
        stepResults.push(await executeUiStep(page, step, executionContext, skill.params));
        continue;
      }
      if ((channel === 'network' || channel === 'auto') && step.network) {
        let result = await executeNetworkStep(page, step, executionContext, skill.params);
        if (result.raw?.status === 403) throw new ForbiddenError(`Step ${step.id} is forbidden`);
        if (result.raw?.status === 401) {
          if (!skill.auth) throw new StepExecutionError(`Step ${step.id} requires authentication`);
          await recoverAuthentication(page, skill.auth);
          if (!(await confirmStep(step, executionContext, opts))) {
            stepResults.push(cancelled(step, 'network'));
            break;
          }
          result = await executeNetworkStep(page, step, executionContext, skill.params);
          if (result.raw?.status === 403) throw new ForbiddenError(`Step ${step.id} is forbidden`);
        }
        const resolved = await resolveNetworkOutcome(
          page,
          skill,
          step,
          result,
          executionContext,
          opts,
        );
        stepResults.push(resolved);
        if (!resolved.ok) break;
        continue;
      }
      throw new StepExecutionError(`当前任务尚未支持通道: ${channel}`);
    }
    return {
      ok: stepResults.every((result) => result.ok),
      skillId: skill.skill.id,
      steps: stepResults,
      extracted: executionContext.vars,
    };
  } finally {
    await browserContext.close();
  }
}

async function resolveNetworkOutcome(
  page: Page,
  skill: Skill,
  step: Step,
  result: StepResult,
  context: ExecContext,
  opts: ReplayOptions,
): Promise<StepResult> {
  if (result.ok) return result;
  const postcondition = step.postcondition ?? skill.postcondition;
  const allowUiFallback = opts.forceChannel !== 'network';

  if (result.outcome === 'outcome_unknown') {
    if (!postcondition) {
      throw new OutcomeUnknownError(`Step ${step.id} outcome is unknown and has no postcondition`);
    }
    const resolution = await executePostcondition(page, postcondition, context, skill.params);
    const resolved = withPostcondition(result, resolution);
    if (resolved.ok) return resolved;
    if (allowUiFallback && step.ui && resolution.found === false) {
      return executeUiFallback(page, step, context, skill, opts, resolution);
    }
    throw new OutcomeUnknownError(`Step ${step.id} could not be resolved safely`);
  }

  if (!allowUiFallback || !step.ui) return result;
  if (result.outcome === 'not_sent') {
    return executeUiFallback(page, step, context, skill, opts);
  }
  if (result.outcome === 'confirmed_failure') {
    if (!step.hasSideEffect) return executeUiFallback(page, step, context, skill, opts);
    if (!postcondition) return result;
    const resolution = await executePostcondition(page, postcondition, context, skill.params);
    const resolved = withPostcondition(result, resolution);
    if (resolved.ok) return resolved;
    if (resolution.found === false) {
      return executeUiFallback(page, step, context, skill, opts, resolution);
    }
    return resolved;
  }
  return result;
}

/** Execute the idempotent GET used to resolve an uncertain write outcome. */
export async function executePostcondition(
  page: Page,
  postcondition: Postcondition,
  context: ExecContext,
  params: Skill['params'],
): Promise<{ found: boolean; expectFound: boolean; matched?: unknown }> {
  const spec = resolveTemplate(postcondition, context, params);
  const deadline = Date.now() + spec.timeoutMs;
  do {
    let response: { status: number; text: string };
    try {
      response = await page.evaluate(
        async ({ condition, baseUrl }) => {
          const result = await fetch(new URL(condition.request.url, baseUrl).href, {
            method: 'GET',
            credentials: 'include',
            headers: condition.request.headers,
          });
          return { status: result.status, text: await result.text() };
        },
        { condition: spec, baseUrl: context.baseUrl },
      );
    } catch (error) {
      throw new OutcomeUnknownError('Postcondition request failed', { cause: error });
    }
    if (response.status === 403) throw new ForbiddenError('Postcondition request is forbidden');
    if (response.status < 200 || response.status >= 300) {
      throw new OutcomeUnknownError(`Postcondition request failed with HTTP ${response.status}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(response.text);
    } catch (error) {
      throw new OutcomeUnknownError('Postcondition response is not JSON', { cause: error });
    }
    const allCandidates = readCandidateList(body, spec.match.jsonPath);
    const candidates = spec.match.limit
      ? allCandidates.slice(0, spec.match.limit)
      : allCandidates;
    const matched = candidates.find((candidate) => matchesWhere(candidate, spec.match.where));
    if (matched !== undefined || !spec.expectFound) {
      return {
        found: matched !== undefined,
        expectFound: spec.expectFound,
        ...(matched !== undefined ? { matched } : {}),
      };
    }
    if (Date.now() < deadline) await page.waitForTimeout(200);
  } while (Date.now() < deadline);
  return { found: false, expectFound: spec.expectFound };
}

async function executeUiFallback(
  page: Page,
  step: Step,
  context: ExecContext,
  skill: Skill,
  opts: ReplayOptions,
  resolution?: { found: boolean; expectFound: boolean; matched?: unknown },
): Promise<StepResult> {
  if (!(await confirmStep(step, context, opts))) {
    const result = cancelled(step, 'ui');
    return resolution
      ? { ...result, outcomeResolvedBy: 'postcondition', postconditionResult: resolution }
      : result;
  }
  const result = await executeUiStep(page, step, context, skill.params);
  return resolution
    ? {
        ...result,
        outcomeResolvedBy: 'postcondition',
        postconditionResult: resolution,
      }
    : result;
}

function executeMergedStep(
  step: Step,
  context: ExecContext,
  params: Skill['params'],
): StepResult {
  const startedAt = Date.now();
  const value =
    step.ui?.value === undefined
      ? context.params[step.id]
      : resolveTemplate(step.ui.value, context, params);
  context.vars[step.id] = value;
  context.stepResults[step.id] = value;
  return {
    stepId: step.id,
    ok: true,
    outcome: 'confirmed_success',
    channelUsed: 'merged',
    durationMs: Date.now() - startedAt,
  };
}

function withPostcondition(
  result: StepResult,
  resolution: { found: boolean; expectFound: boolean; matched?: unknown },
): StepResult {
  const ok = resolution.found === resolution.expectFound;
  return {
    ...result,
    ok,
    outcome: ok ? 'confirmed_success' : 'confirmed_failure',
    outcomeResolvedBy: 'postcondition',
    postconditionResult: resolution,
  };
}

function readCandidateList(body: unknown, path: string): unknown[] {
  const normalized = path.replace(/^\$\.?/, '').replace(/\[\*\]$/, '');
  let current = body;
  for (const segment of normalized.split('.').filter(Boolean)) {
    if (typeof current !== 'object' || current === null || !(segment in current)) {
      throw new OutcomeUnknownError(`Postcondition JSONPath not found: ${path}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (!Array.isArray(current)) {
    throw new OutcomeUnknownError(`Postcondition JSONPath is not a collection: ${path}`);
  }
  return current;
}

function matchesWhere(candidate: unknown, where: Record<string, string>): boolean {
  if (typeof candidate !== 'object' || candidate === null) return false;
  return Object.entries(where).every(
    ([key, expected]) => String((candidate as Record<string, unknown>)[key]) === expected,
  );
}

async function confirmStep(
  step: Step,
  context: ExecContext,
  opts: ReplayOptions,
): Promise<boolean> {
  if (step.riskLevel === 'read') return true;
  return opts.onConfirm ? opts.onConfirm(step, context) : true;
}

function cancelled(step: Step, channel: StepResult['channelUsed'] | 'auto'): StepResult {
  return {
    stepId: step.id,
    ok: false,
    outcome: 'not_sent',
    channelUsed: channel === 'auto' ? 'network' : channel,
    durationMs: 0,
    error: 'User cancelled execution',
  };
}

export function renderExecutionPlan(skill: Skill, opts: ReplayOptions): string {
  const lines = [
    `DSH dry-run: ${skill.skill.id}`,
    `baseUrl: ${skill.skill.baseUrl}`,
    `profile: ${opts.profileDir}`,
    `channel: ${opts.forceChannel ?? 'skill'}`,
    `LLM: ${opts.noLLM ? 'disabled' : 'enabled'}`,
    '预取:',
  ];
  if (skill.preflight.length === 0) lines.push('  无');
  else skill.preflight.forEach((item) => lines.push(`  - ${item.name}: ${item.extract.type}`));
  lines.push('步骤:');
  if (skill.steps.length === 0) lines.push('  无');
  else {
    skill.steps.forEach((step) => {
      const channel = step.channel === 'merged' ? 'merged' : (opts.forceChannel ?? step.channel);
      lines.push(
        `  - ${step.id} [${channel}/${step.riskLevel}] ${step.desc}${step.hasSideEffect ? ' [side-effect]' : ''}`,
      );
    });
  }
  lines.push('断言:');
  if (skill.assertions.length === 0) lines.push('  无');
  else skill.assertions.forEach((assertion) => lines.push(`  - ${assertion.type}`));
  lines.push(`postcondition: ${skill.postcondition ? skill.postcondition.request.url : '无'}`);
  return `${lines.join('\n')}\n`;
}
