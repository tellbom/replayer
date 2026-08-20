// 【T-63b】DSH Adapter：Playwright selectorGenerator（vendor 1.62.1）的浏览器侧入口。
// Playwright 原算法零修改（vendor/ 目录）；本文件只做接口适配：
//   InjectedScript 桩 = SelectorEvaluatorImpl（vendor）+ 四个生成器实际用到的引擎
//   （css / text / role / nth）——引擎分派循上游 injectedScript.querySelectorAll 主循环
//   的同一结构（roots Set → 逐 part 过滤），css AST 执行走 evaluator.query 原实现。
import { SelectorEvaluatorImpl } from '../../../vendor/playwright-injected/1.62.1/selectorEvaluator';
import { generateSelector } from '../../../vendor/playwright-injected/1.62.1/selectorGenerator';
import { parseSelector } from '../../../vendor/playwright-injected/1.62.1/selectorParser';
import type { ParsedSelector } from '../../../vendor/playwright-injected/1.62.1/selectorParser';
import { parseCSS } from '../../../vendor/playwright-injected/1.62.1/cssParser';
import { customCSSNames } from '../../../vendor/playwright-injected/1.62.1/selectorParser';
import {
  beginAriaCaches,
  endAriaCaches,
  getAriaRole,
  getElementAccessibleNameText,
} from '../../../vendor/playwright-injected/1.62.1/roleUtils';
import { isElementVisible } from '../../../vendor/playwright-injected/1.62.1/domUtils';
import { elementMatchesText, elementText } from '../../../vendor/playwright-injected/1.62.1/selectorUtils';

type Part = { name: string; body: unknown; source: string };

/** 按 ParsedSelector 逐部件查询（css/text/role/nth —— 生成器产出的引擎集）。 */
function queryAllParts(
  evaluator: SelectorEvaluatorImpl,
  parts: Part[],
  root: Element | Document,
): Element[] {
  let roots = new Set<Element>([root as Element]);
  for (const part of parts) {
    if (part.name === 'nth') {
      const list = [...roots];
      const index = Number(part.body);
      const nth = index === -1 ? list.length - 1 : index;
      roots = new Set(list.slice(nth, nth + 1));
    } else if (part.name === 'css') {
      const next = new Set<Element>();
      for (const scope of roots) {
        for (const el of evaluator.query(
          { scope, pierceShadow: true },
          part.body as never,
        )) {
          next.add(el);
        }
      }
      roots = next;
    } else if (part.name === 'text') {
      const expected = String(part.body).replace(/^["']|["']$/g, '');
      const next = new Set<Element>();
      for (const el of allElements(evaluator, root)) {
        const matches = elementMatchesText(
          evaluator._cacheText,
          el,
          (text: { normalized: string }) => text.normalized === expected,
        );
        if (matches === 'self') next.add(el);
      }
      roots = next;
    } else if (part.name === 'role') {
      const body = String(part.body);
      const roleMatch = /^\[role\s*=\s*(?:"([^"]*)"|'([^']*)'|(\w+))\]/.exec(body);
      const nameMatch = /name\s*=\s*(?:"([^"]*)"|'([^']*)'|\[([^\]]*)\]|(\S+))/.exec(body);
      const role = roleMatch?.[1] ?? roleMatch?.[2] ?? roleMatch?.[3];
      const name = nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3] ?? nameMatch?.[4];
      beginAriaCaches();
      try {
        const next = new Set<Element>();
        for (const el of allElements(evaluator, root)) {
          if (!isElementVisible(el)) continue;
          if (role && getAriaRole(el) !== role) continue;
          if (name !== undefined && getElementAccessibleNameText(el, evaluator._cacheText) !== name) continue;
          next.add(el);
        }
        roots = next;
      } finally {
        endAriaCaches();
      }
    } else {
      // 未知引擎（internal:*/control 等）——生成器在 POC 场景不产出；视为空使该候选被否决
      return [];
    }
  }
  return [...roots];
}

function allElements(evaluator: SelectorEvaluatorImpl, root: Element | Document): Element[] {
  const { selector } = parseCSS('*', customCSSNames);
  return evaluator.query({ scope: root, pierceShadow: true }, selector);
}

/** vendor generateSelector 依赖的 InjectedScript 最小桩。 */
function makeInjectedScript() {
  const evaluator = new SelectorEvaluatorImpl();
  const script = {
    _evaluator: evaluator,
    parseSelector,
    querySelector: (parsed: ParsedSelector, root: Element | Document) =>
      queryAllParts(evaluator, parsed.parts, root)[0] ?? null,
    querySelectorAll: (parsed: ParsedSelector, root: Element | Document) =>
      queryAllParts(evaluator, parsed.parts, root),
  };
  return script;
}

/**
 * 【T-63b】对外入口：对用户真实点击的 Element 生成 Playwright Codegen 级 locator。
 * unique 语义 = 唯一命中且该元素正是用户点击的原元素（录制 oracle）。
 */
function generateTarget(element: Element): {
  selector: string;
  unique: boolean;
  matchCount: number;
  confidence: 'HIGH' | 'LOW';
  source: 'playwright';
} {
  const script = makeInjectedScript();
  const result = generateSelector(script as never, element, {
    testIdAttributeName: 'data-testid',
  });
  const parsed = parseSelector(result.selector);
  const matches = queryAllParts(evaluatorOf(script), parsed.parts, element.ownerDocument);
  const usesNth = parsed.parts.some((p) => p.name === 'nth');
  return {
    selector: result.selector,
    unique: matches.length === 1 && matches[0] === element,
    matchCount: matches.length,
    confidence: usesNth ? 'LOW' : 'HIGH',
    source: 'playwright',
  };
}

function evaluatorOf(script: ReturnType<typeof makeInjectedScript>): SelectorEvaluatorImpl {
  return script._evaluator as SelectorEvaluatorImpl;
}

Object.assign(window, { __DSH_PWGEN__: generateTarget });
