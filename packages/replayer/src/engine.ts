import { acquireDSHContext, ensureEntry } from '@dsh/browser';
import type { Entry } from '@dsh/core';
import {
  ForbiddenError,
  ChannelCarrierMissingError,
  FirstRunVerificationRequiredError,
  LocatorNotFoundError,
  OutcomeUnknownError,
  StepExecutionError,
  resolveTemplate,
  assertNoUnresolvedExecutableValues,
  validateExecutionParams,
  requestUsesMultipart,
  SemanticDriftError,
  SkillNeedsRerecordError,
  ScopeNotReadyError,
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
import type { LowTargetInspection } from './semantic-guard.js';

import { runAssertions } from './assert.js';
import { startDiagnosticSession, writeDiagnosticBundle } from './diagnostic.js';
import { executeNetworkStep } from './channel-network.js';
import { executeUiStep } from './channel-ui.js';
import { executePreflights } from './preflight.js';
import { decideReentry, resetContextAfterAnchor } from './reentry.js';

export interface ReplayOptions {
  // 冻结契约允许任意参数值。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: Record<string, any>;
  profileDir: string;
  /** 【v2.0 C16】技能引用的认证载体配置 */
  entry: Entry;
  dryRun?: boolean;
  forceChannel?: 'ui' | 'network';
  noLLM?: boolean;
  /** Explicit proof that this run is being watched for first-run LOW verification. */
  supervisedVerification?: boolean;
  cdpEndpoint?: string;
  onConfirm?: (step: Step, context: ExecContext) => Promise<boolean>;
  onLowTarget?: (step: Step, inspection: LowTargetInspection) => Promise<boolean>;
  onLocatorFailure?: (input: {
    page: Page;
    skill: Skill;
    step: Step;
    error: LocatorNotFoundError;
    context: ExecContext;
  }) => Promise<StepResult | null>;
}

/** 回放统一入口；各执行器按任务顺序接入此编排。 */
export async function replay(skill: Skill, opts: ReplayOptions): Promise<RunResult> {
  assertNoUnresolvedExecutableValues(skill);
  validateExecutionParams(skill.params, opts.params);
  refreshVerification(skill);
  if (skill.verification.status === 'needs_rerecord') {
    throw new SkillNeedsRerecordError(
      `Skill ${skill.skill.id} 已标记为需要重新录制：${skill.verification.rerecordReason?.detail ?? '页面结构已变化'}`,
    );
  }
  if (opts.dryRun) {
    process.stdout.write(renderExecutionPlan(skill, opts));
    return { ok: true, skillId: skill.skill.id, steps: [], extracted: {}, reentryCount: 0 };
  }
  if (
    skill.verification.status === 'draft'
    && skill.verification.requiresFirstRunVerification
    && skill.steps.some((step) => {
      const target = step.ui?.target;
      return target && 'confidence' in target && target.confidence === 'LOW';
    })
    && !opts.supervisedVerification
  ) {
    throw new FirstRunVerificationRequiredError(
      `Skill ${skill.skill.id} contains unverified LOW-confidence locators; supervised verification is required`,
    );
  }

  const lease = await acquireDSHContext({ profileDir: opts.profileDir }, opts.cdpEndpoint);
  const browserContext = lease.context;
  try {
    const page = browserContext.pages()[0] ?? (await browserContext.newPage());
    const diagnostic = startDiagnosticSession(page);
    let currentStepId = 'bootstrap';
    let beforeScreenshot: Buffer | undefined;
    const stepResults: StepResult[] = [];
    try {
      // 【T-35 v2.0】回放起点恒为「已通过 entry 进入目标系统、会话已建立」（C16）。
      const entrySession = await ensureEntry(page, opts.entry);
      const executionContext: ExecContext = {
        params: opts.params,
        vars: {},
        stepResults: {},
        baseUrl: skill.skill.baseUrl,
        entry: opts.entry,
        identityDigest: entrySession.identityDigest,
        scopes: {},
      };
      await executePreflights(page, skill.preflight, executionContext);
      let reentryCount = 0;
      let stepIndex = 0;
      let aborted = false;
      while (stepIndex < skill.steps.length && !aborted) {
        const step = skill.steps[stepIndex]!;
        currentStepId = step.id;
        beforeScreenshot = await page.screenshot();
        const channel = step.channel === 'merged' ? 'merged' : (opts.forceChannel ?? step.channel);
        if (!(await confirmStep(step, executionContext, opts))) {
          stepResults.push(cancelled(step, channel));
          break;
        }
        if (channel === 'merged') {
          stepResults.push(executeMergedStep(step, executionContext, skill.params));
          stepIndex += 1;
          continue;
        }
        if (channel === 'ui' && step.ui) {
          try {
            const result = await executeUiStep(page, step, executionContext, skill.params, {
              onLowTarget: opts.onLowTarget
                ? (inspection) => opts.onLowTarget!(step, inspection)
                : undefined,
            });
            let resolved = result;
            if (step.expectsRedirect) {
              const postcondition = step.postcondition ?? skill.postcondition;
              if (!postcondition) {
                throw new OutcomeUnknownError(
                  `Step ${step.id} is a redirecting write and has no postcondition`,
                );
              }
              resolved = withPostcondition(
                { ...result, ok: false, outcome: 'outcome_unknown' },
                await executePostcondition(page, postcondition, executionContext, skill.params),
              );
            }
            stepResults.push(resolved);
            if (!resolved.ok) break;
          } catch (error) {
            if (!(error instanceof LocatorNotFoundError) || !opts.onLocatorFailure) throw error;
            const healed = await opts.onLocatorFailure({
              page,
              skill,
              step,
              error,
              context: executionContext,
            });
            if (!healed) throw error;
            stepResults.push(healed);
          }
          stepIndex += 1;
          continue;
        }
        if ((channel === 'network' || channel === 'auto') && step.network) {
          let result = await executeNetworkStep(page, step, executionContext, skill.params);
          if (result.raw?.status === 403) throw new ForbiddenError(`Step ${step.id} is forbidden`);
          if (result.raw?.status === 401) {
            // 【T-59】会话失效：恢复认证 + 身份校验 + 按 C22 决策重跑方式。
            reentryCount += 1;
            const decision = await decideReentry(
              {
                page,
                skill,
                step,
                context: executionContext,
                interrupted: result,
                reentryCount,
              },
              (conditionPage, condition, conditionContext) =>
                executePostcondition(conditionPage, condition, conditionContext, skill.params),
            );
            if (decision.action === 'abort') {
              aborted = true;
              break;
            }
            if (decision.action === 'skip-step') {
              stepResults.push(decision.result ?? cancelled(step, 'network'));
              stepIndex += 1;
              continue;
            }
            if (decision.action === 'restart-from-anchor') {
              const anchorId = skill.reentry?.anchor;
              const anchorIndex = anchorId
                ? skill.steps.findIndex((s) => s.id === anchorId)
                : -1;
              if (anchorIndex < 0) {
                aborted = true;
                break;
              }
              resetContextAfterAnchor(executionContext, skill);
              await executePreflights(page, skill.preflight, executionContext);
              stepIndex = anchorIndex;
              continue;
            }
            // retry-step：重新执行当前步骤（不推进 index）
            if (!(await confirmStep(step, executionContext, opts))) {
              stepResults.push(cancelled(step, 'network'));
              break;
            }
            result = await executeNetworkStep(page, step, executionContext, skill.params);
            if (result.raw?.status === 403) {
              throw new ForbiddenError(`Step ${step.id} is forbidden`);
            }
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
          stepIndex += 1;
          continue;
        }
        throw new StepExecutionError(`当前任务尚未支持通道: ${channel}`);
      }
      const finalStep = stepResults.at(-1);
      if (finalStep?.raw && finalStep.outcomeResolvedBy !== 'postcondition') {
        runAssertions(skill.assertions, finalStep.raw, executionContext);
      }
      const runResult: RunResult = {
        ok: stepResults.every((result) => result.ok),
        skillId: skill.skill.id,
        steps: stepResults,
        extracted: executionContext.vars,
        reentryCount,
      };
      if (!runResult.ok) {
        runResult.diagnosticDir = await writeDiagnosticBundle({
          page,
          stepId: currentStepId,
          result: runResult,
          beforeScreenshot,
          session: diagnostic,
        });
      } else {
        await diagnostic.stop();
      }
      return runResult;
    } catch (error) {
      const failedStep = skill.steps.find((step) => step.id === currentStepId);
      if (failedStep) markSkillNeedsRerecord(skill, failedStep, error);
      const diagnosticDir = await writeDiagnosticBundle({
        page,
        stepId: currentStepId,
        result: { skillId: skill.skill.id, steps: stepResults },
        error,
        beforeScreenshot,
        session: diagnostic,
      });
      if (error instanceof Error) Object.assign(error, { diagnosticDir });
      throw error;
    }
  } finally {
    await lease.release();
  }
}

export function refreshVerification(skill: Skill, now = new Date()): void {
  const verification = skill.verification;
  if (verification.status !== 'verified' || !verification.verifiedAt) return;
  const ageMs = now.getTime() - new Date(verification.verifiedAt).getTime();
  if (ageMs <= verification.verifiedTtlDays * 86_400_000) return;
  verification.status = 'draft';
  verification.requiresFirstRunVerification = true;
}

export function markSkillNeedsRerecord(skill: Skill, step: Step, error: unknown): void {
  const classified = classifyRerecordFailure(step, error);
  skill.verification.status = 'needs_rerecord';
  skill.verification.rerecordReason = {
    at: new Date().toISOString(),
    stepId: step.id,
    kind: classified.kind,
    detail: classified.detail,
  };
}

function classifyRerecordFailure(
  step: Step,
  error: unknown,
): { kind: NonNullable<Skill['verification']['rerecordReason']>['kind']; detail: string } {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof SemanticDriftError) return { kind: 'semantic-drift', detail };
  if (error instanceof ScopeNotReadyError) return { kind: 'scope-missing', detail };
  if (error instanceof LocatorNotFoundError) {
    const count = /实际\s*(\d+)/.exec(detail)?.[1];
    if (count && Number(count) > 1) return { kind: 'strict-multiple', detail };
    if (step.ui?.target?.strategy === 'frame-playwright') return { kind: 'frame-missing', detail };
    if (count === '0') return { kind: 'not-found', detail };
  }
  return { kind: 'action-failed', detail };
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
    if (step.expectsRedirect) return resolved;
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
  let spec: ReturnType<typeof resolveTemplate<Postcondition>>;
  try {
    spec = resolveTemplate(postcondition, context, params);
  } catch (error) {
    throw new OutcomeUnknownError(`Postcondition parameter mapping failed: ${String(error)}`, {
      cause: error,
    });
  }
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
  assertUiFallbackCarrier(skill, step);
  if (!(await confirmStep(step, context, opts))) {
    const result = cancelled(step, 'ui');
    return resolution
      ? { ...result, outcomeResolvedBy: 'postcondition', postconditionResult: resolution }
      : result;
  }
  const result = await executeUiStep(page, step, context, skill.params, {
    onLowTarget: opts.onLowTarget
      ? (inspection) => opts.onLowTarget!(step, inspection)
      : undefined,
  });
  return resolution
    ? {
        ...result,
        outcomeResolvedBy: 'postcondition',
        postconditionResult: resolution,
      }
    : result;
}

export function assertUiFallbackCarrier(skill: Skill, step: Step): void {
  if (!step.network) return;
  if (requestUsesMultipart(step.network)) {
    throw new ChannelCarrierMissingError(
      `步骤 ${step.id} 的 multipart 字段或文件在 UI 降级后无载体。` +
      '已中止以避免提交空请求体。',
    );
  }
  const mergedIds = new Set(
    skill.steps.filter((candidate) => candidate.channel === 'merged').map((candidate) => candidate.id),
  );
  const dependencies = new Set<string>();
  const serialized = JSON.stringify(step.network);
  for (const match of serialized.matchAll(/\{\{\s*([^.[|\s}]+)/g)) {
    const root = match[1];
    if (root && mergedIds.has(root)) dependencies.add(root);
  }
  if (dependencies.size === 0) return;
  throw new ChannelCarrierMissingError(
    `步骤 ${step.id} 依赖 ${dependencies.size} 个 merged 步骤的值，` +
    '降级为 UI 通道后这些值无载体。已中止以避免提交不完整数据。',
  );
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

export function matchesWhere(candidate: unknown, where: Record<string, unknown>): boolean {
  if (typeof candidate !== 'object' || candidate === null) return false;
  return Object.entries(where).every(
    ([key, expected]) => matchesValue((candidate as Record<string, unknown>)[key], expected),
  );
}

function matchesValue(candidate: unknown, expected: unknown): boolean {
  if (Array.isArray(candidate) && Array.isArray(expected)) {
    if (candidate.length !== expected.length) return false;
    const remaining = [...candidate];
    return expected.every((value) => {
      const index = remaining.findIndex((item) => matchesScalar(item, value));
      if (index < 0) return false;
      remaining.splice(index, 1);
      return true;
    });
  }
  if (Array.isArray(candidate)) return candidate.some((value) => matchesScalar(value, expected));
  if (Array.isArray(expected)) {
    return expected.length === 1 && matchesScalar(candidate, expected[0]);
  }
  return matchesScalar(candidate, expected);
}

function matchesScalar(candidate: unknown, expected: unknown): boolean {
  if (typeof candidate === 'string' && typeof expected === 'string') {
    return candidate.trim() === expected.trim();
  }
  if (typeof candidate === 'number' && typeof expected === 'number') {
    return Object.is(candidate, expected);
  }
  if (typeof candidate === 'boolean' && typeof expected === 'boolean') {
    return candidate === expected;
  }
  if (typeof candidate === 'number' && typeof expected === 'string') {
    return Number.isFinite(candidate) && String(candidate) === expected.trim();
  }
  if (typeof candidate === 'string' && typeof expected === 'number') {
    return candidate.trim() === String(expected);
  }
  if (typeof candidate === 'boolean' && typeof expected === 'string') {
    return String(candidate) === expected.trim();
  }
  if (typeof candidate === 'string' && typeof expected === 'boolean') {
    return candidate.trim() === String(expected);
  }
  return candidate === expected;
}

async function confirmStep(
  step: Step,
  context: ExecContext,
  opts: ReplayOptions,
): Promise<boolean> {
  // verified 只免除首次全流程监督；write/critical 的 C6 每次执行确认始终独立保留。
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
