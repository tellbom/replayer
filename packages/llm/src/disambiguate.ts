import { z } from 'zod';
import type { ILLMProvider } from '@dsh/core';
import type { Page } from 'playwright';

import { chatJSON } from './guard.js';

/**
 * 【T-64】录制期 LLM 消歧 POC。
 * 前置：Playwright generator 产出 LOW/FAILED（含 nth 或非唯一）时才调用；
 * HIGH 一律不进 LLM。LLM 不生成选择器——只从局部上下文中「选 scope」，
 * 产物必须经 Playwright 引擎重验证：count === 1 且唯一命中元素 === 用户点击的原元素。
 */

export interface DisambiguationInput {
  page: Page;
  /** 用户真实点击的元素（录制 oracle） */
  targetElement: unknown;
  /** playwright generator 的低置信结果 */
  pwResult: { selector: string; matchCount: number; confidence: 'HIGH' | 'LOW' };
  /** 浏览器侧 __DSH_DISAMBIG__ 收集的局部上下文 */
  context: DisambiguationContext;
}

export interface DisambiguationContext {
  target: {
    tag: string;
    role: string | null;
    text: string;
    type: string | null;
    name: string | null;
    placeholder: string | null;
  };
  ancestors: Array<{
    tag: string;
    role: string | null;
    heading: string | null;
    sameNameCount: number;
  }>;
  siblings: Array<{ role: string | null; text: string; type: string | null }>;
  sameNameCandidates: Array<{ index: number; nearestHeading: string | null }>;
}

const ScopeProposalSchema = z.object({
  /** 选择的候选下标（sameNameCandidates 内），或 null 表示无区分度 */
  candidate: z.number().nullable(),
  /** 建议的 scope（从 ancestors 中选语义层） */
  scopeHint: z
    .object({
      tag: z.string(),
      heading: z.string().nullable(),
      role: z.string().nullable(),
    })
    .nullable(),
  reason: z.string().min(1),
});

export type ScopeProposal = z.infer<typeof ScopeProposalSchema>;

export interface DisambiguationOutcome {
  accepted: boolean;
  proposal: ScopeProposal | null;
  /** 验证细节：scope 过滤后的命中数与是否即原元素 */
  verification?: { matchCount: number; isOriginalTarget: boolean };
  reason?: string;
}

export async function disambiguateWithLLM(
  llm: ILLMProvider,
  input: DisambiguationInput,
): Promise<DisambiguationOutcome> {
  // HIGH 不进 LLM（调用方也不应触发——防御性再校验）
  if (input.pwResult.confidence === 'HIGH' && input.pwResult.matchCount === 1) {
    return { accepted: false, proposal: null, reason: 'HIGH 置信度不走 LLM' };
  }

  const proposal = await chatJSON(
    llm,
    [
      {
        role: 'system',
        content:
          '你是录制定位器的消歧助手。给定目标控件、其语义祖先（含各祖先范围内同名计数）、' +
          '父容器兄弟控件、以及页面同名候选（含各自最近标题）。' +
          '只允许返回 JSON：candidate（目标在同名候选中的下标）、scopeHint（建议用哪个祖先层作范围）、reason。' +
          '禁止生成 CSS/XPath/代码。若上下文不足以区分，candidate 与 scopeHint 均返回 null。',
      },
      {
        role: 'user',
        content: JSON.stringify({
          target: input.context.target,
          ancestors: input.context.ancestors,
          siblings: input.context.siblings,
          sameNameCandidates: input.context.sameNameCandidates,
        }),
      },
    ],
    ScopeProposalSchema,
  );

  // scope 验证：用 Playwright 引擎按「scope 内目标 role+name」重查
  const verification = await verifyProposal(input, proposal);
  if (!verification) {
    return { accepted: false, proposal, reason: '提案无法验证（无 candidate 或 scope 查询失败）' };
  }
  if (verification.matchCount !== 1 || !verification.isOriginalTarget) {
    return {
      accepted: false,
      proposal,
      verification,
      reason: `拒绝：matchCount=${verification.matchCount} isOriginal=${verification.isOriginalTarget}`,
    };
  }
  return { accepted: true, proposal, verification };
}

/** Playwright 再验证：scope 过滤后唯一命中且正是录制时点击的原元素。 */
async function verifyProposal(
  input: DisambiguationInput,
  proposal: ScopeProposal,
): Promise<{ matchCount: number; isOriginalTarget: boolean } | null> {
  if (proposal.candidate === null) return null;
  const { target } = input.context;
  const name = target.text;
  // scope 过滤：用 getByRole 的 name 匹配 + 限定 scope（heading 文本作 has 过滤）
  const scope = proposal.scopeHint;
  const base = input.page.getByRole((target.role ?? 'button') as 'button', { name, exact: true });
  const scoped = scope?.heading
    ? input.page
        .locator(scope.tag, { hasText: scope.heading })
        .getByRole((target.role ?? 'button') as 'button', { name, exact: true })
    : base.nth(proposal.candidate);
  const count = await scoped.count();
  if (count !== 1) return { matchCount: count, isOriginalTarget: false };
  // 录制 oracle：给原元素打一次性标记，验证 scoped 唯一命中的正是它。
  // targetElement 经 page.evaluate 传入（对象按引用序列化为同一节点）。
  const MARK = '__dsh_disambig_mark__';
  await input.page
    .evaluate(
      ({ element, mark }) => {
        (element as Element).setAttribute(mark, '1');
      },
      { element: input.targetElement, mark: MARK },
    )
    .catch(() => undefined);
  const isOriginal = await scoped
    .evaluate((el: Element, mark: string) => el.getAttribute(mark) === '1', MARK)
    .catch(() => false);
  await input.page
    .evaluate((mark) => {
      document.querySelector(`[${mark}]`)?.removeAttribute(mark);
    }, MARK)
    .catch(() => undefined);
  return { matchCount: count, isOriginalTarget: Boolean(isOriginal) };
}
