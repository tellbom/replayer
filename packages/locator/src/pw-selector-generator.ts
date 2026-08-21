// 【T-63b】DSH Adapter：Playwright selectorGenerator（vendor 1.62.1）的浏览器侧入口。
// Playwright 原算法零修改（vendor/ 目录）；本文件只做接口适配：
//   InjectedScript 桩 = SelectorEvaluatorImpl（vendor）+ 生成器实际用到的引擎
//   （css / text / role / attr / label / nth）——引擎分派循上游 injectedScript.querySelectorAll 主循环
//   的同一结构（roots Set → 逐 part 过滤），css AST 执行走 evaluator.query 原实现。
import { SelectorEvaluatorImpl } from '../../../vendor/playwright-injected/1.62.1/selectorEvaluator';
import { generateSelector } from '../../../vendor/playwright-injected/1.62.1/selectorGenerator';
import { parseAttributeSelector, parseSelector } from '../../../vendor/playwright-injected/1.62.1/selectorParser';
import type { ParsedSelector } from '../../../vendor/playwright-injected/1.62.1/selectorParser';
import { parseCSS } from '../../../vendor/playwright-injected/1.62.1/cssParser';
import { customCSSNames } from '../../../vendor/playwright-injected/1.62.1/selectorParser';
import { beginAriaCaches, endAriaCaches } from '../../../vendor/playwright-injected/1.62.1/roleUtils';
import {
  elementMatchesText,
  getElementLabels,
  matchesAttributePart,
} from '../../../vendor/playwright-injected/1.62.1/selectorUtils';
import type { ElementText } from '../../../vendor/playwright-injected/1.62.1/selectorUtils';
import { createRoleEngine } from '../../../vendor/playwright-injected/1.62.1/roleSelectorEngine';
import { normalizeWhiteSpace } from '../../../vendor/playwright-injected/1.62.1/stringUtils';

type Part = { name: string; body: unknown; source: string };

const roleEngine = createRoleEngine(true);
const GENERATE_SELECTOR_OPTIONS = Object.freeze({
  testIdAttributeName: 'data-testid',
  noCSSId: true,
});

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
    } else if (part.name === 'internal:text') {
      // 上游文本候选引擎（escapeForTextSelector 产物，"text" 或 /regex/ 形态）
      const raw = String(part.body);
      const expected = raw.replace(/^["']|["']$/g, '');
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
    } else if (part.name === 'internal:role' || part.name === 'role') {
      // 上游 role 引擎原实现（roleSelectorEngine.ts，含 name/checked/level 等
      // ARIA 属性解析与 implicit role 语义）——与官方 getByRole 同源
      beginAriaCaches();
      try {
        const next = new Set<Element>();
        for (const scope of roots) {
          for (const el of roleEngine.queryAll(scope, String(part.body))) next.add(el);
        }
        roots = next;
      } finally {
        endAriaCaches();
      }
    } else if (part.name === 'internal:attr') {
      const parsed = parseAttributeSelector(String(part.body), true);
      if (parsed.name || parsed.attributes.length !== 1) throw new Error('Malformed internal:attr selector');
      const attribute = parsed.attributes[0]!;
      const next = new Set<Element>();
      for (const scope of roots) {
        for (const el of allElements(evaluator, scope)) {
          if (el.hasAttribute(attribute.name) && matchesAttributePart(el.getAttribute(attribute.name), attribute)) {
            next.add(el);
          }
        }
      }
      roots = next;
    } else if (part.name === 'internal:label') {
      const matcher = createInternalTextMatcher(String(part.body));
      const next = new Set<Element>();
      for (const scope of roots) {
        for (const el of allElements(evaluator, scope)) {
          if (getElementLabels(evaluator._cacheText, el).some(matcher)) next.add(el);
        }
      }
      roots = next;
    } else {
      // 尚未接入的内部引擎不参与候选验证。
      return [];
    }
  }
  return [...roots];
}

function createInternalTextMatcher(selector: string): (text: ElementText) => boolean {
  if (selector[0] === '/' && selector.lastIndexOf('/') > 0) {
    const lastSlash = selector.lastIndexOf('/');
    const expression = new RegExp(
      selector.substring(1, lastSlash),
      selector.substring(lastSlash + 1),
    );
    return (text) => expression.test(text.full);
  }

  let strict = false;
  if (
    selector.length > 1 &&
    selector[0] === '"' &&
    selector[selector.length - 2] === '"' &&
    selector[selector.length - 1] === 's'
  ) {
    selector = JSON.parse(selector.substring(0, selector.length - 1)) as string;
    strict = true;
  } else if (
    selector.length > 1 &&
    selector[0] === '"' &&
    selector[selector.length - 2] === '"' &&
    selector[selector.length - 1] === 'i'
  ) {
    selector = JSON.parse(selector.substring(0, selector.length - 1)) as string;
  } else if (selector.length > 1 && selector[0] === '"' && selector[selector.length - 1] === '"') {
    selector = JSON.parse(selector) as string;
    strict = true;
  }

  selector = normalizeWhiteSpace(selector);
  if (strict) return (text) => text.normalized === selector;
  const expected = selector.toLowerCase();
  return (text) => text.normalized.toLowerCase().includes(expected);
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
function generateTarget(element: Element, root: Element | Document = element.ownerDocument): {
  selector: string;
  unique: boolean;
  matchCount: number;
  confidence: 'HIGH' | 'LOW';
  source: 'playwright';
} {
  const script = makeInjectedScript();
  const result = generateSelector(script as never, element, {
    ...GENERATE_SELECTOR_OPTIONS,
    root,
    // 组件库运行时 id（el-collapse-2f8c-… 每次渲染变化）不能当锚点：
    // vendor 的 id 优先档会直接采用它——渲染即断。noCSSId 关闭 id 档，
    // 迫使算法退到 role/text 语义档（业务文案，rebuild 稳定）。
    // 代价：稳定手写 id 也一并放弃（内网页面手写 id 罕见，取舍可接受）。
  });
  const parsed = parseSelector(result.selector);
  const matches = queryAllParts(evaluatorOf(script), parsed.parts, root);
  // 置信度（任务定义：位置依赖 = LOW）：
  // - nth 引擎（button >> nth=4）
  // - css 内的 :nth-child(/nth-of-type 结构链（section:nth-child(8) > button）
  // 两者都是「DOM 位置依赖」，rebuild/改版即断——vendor 分数体系不区分这两档，DSH 在此收紧。
  const usesNth = parsed.parts.some(
    (p) => p.name === 'nth' || (p.name === 'css' && String(p.source).includes(':nth-')),
  );
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

Object.assign(window, {
  __DSH_PWGEN__: generateTarget,
  __DSH_PWGEN_OPTIONS__: GENERATE_SELECTOR_OPTIONS,
});
