// 【T-64】LLM 消歧 POC：为不唯一 target 收集「局部上下文」（浏览器侧 IIFE）。
// 只收集：目标元素自描述 + 最近语义祖先 + 父容器内兄弟控件 + 同名候选的位置摘要。
// 禁止：page.content()/整页 innerHTML/outerHTML/DOM dump。
function collectDisambiguationContext(target: Element): {
  target: ElementSummary;
  ancestors: AncestorSummary[];
  siblings: ControlSummary[];
  sameNameCandidates: CandidateSummary[];
} {
  return {
    target: summarizeElement(target),
    ancestors: semanticAncestors(target),
    siblings: siblingControls(target),
    sameNameCandidates: sameNameCandidates(target),
  };
}

interface ElementSummary {
  tag: string;
  role: string | null;
  text: string;
  type: string | null;
  name: string | null;
  placeholder: string | null;
}

interface AncestorSummary {
  tag: string;
  role: string | null;
  heading: string | null;
  /** 该祖先范围内与目标同 role+name 的元素数（越少越适合作 scope） */
  sameNameCount: number;
}

interface ControlSummary {
  role: string | null;
  text: string;
  type: string | null;
}

interface CandidateSummary {
  index: number;
  /** 候选各自最近 heading（区分度证据） */
  nearestHeading: string | null;
}

function summarizeElement(element: Element): ElementSummary {
  const el = element as HTMLElement;
  return {
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role'),
    text: (el.textContent ?? '').trim().slice(0, 40),
    type: el.getAttribute('type'),
    name: el.getAttribute('name'),
    placeholder: el.getAttribute('placeholder'),
  };
}

/** 沿祖先向上最多 5 层，只保留有语义信号（heading/role/landmark 标签）的层。 */
function semanticAncestors(target: Element): AncestorSummary[] {
  const targetRole = target.getAttribute('role');
  const targetText = (target.textContent ?? '').trim();
  const out: AncestorSummary[] = [];
  let node = target.parentElement;
  for (let depth = 0; node && depth < 10 && out.length < 5; depth += 1) {
    const heading = node.querySelector('h1,h2,h3,h4')?.textContent?.trim().slice(0, 40) ?? null;
    const role = node.getAttribute('role');
    const landmark = /^(section|article|nav|main|aside|header|form)$/.test(node.tagName.toLowerCase());
    if (heading || role || landmark) {
      let sameNameCount = 0;
      for (const el of node.querySelectorAll(target.tagName)) {
        if (
          (targetRole ? el.getAttribute('role') === targetRole : true) &&
          (el.textContent ?? '').trim() === targetText
        ) {
          sameNameCount += 1;
        }
      }
      out.push({
        tag: node.tagName.toLowerCase(),
        role,
        heading,
        sameNameCount,
      });
    }
    node = node.parentElement;
  }
  return out;
}

/** 目标所在父容器的直接控件兄弟（最多 8 个）。 */
function siblingControls(target: Element): ControlSummary[] {
  const parent = target.parentElement;
  if (!parent) return [];
  return [...parent.querySelectorAll('button, [role="button"], a, input, select')]
    .slice(0, 8)
    .map((el) => ({
      role: el.getAttribute('role') ?? (el.tagName === 'BUTTON' ? 'button' : el.tagName === 'A' ? 'link' : null),
      text: (el.textContent ?? el.getAttribute('value') ?? '').trim().slice(0, 30),
      type: el.getAttribute('type'),
    }));
}

/** 页面内与目标同 role+name 的全部候选（各带最近 heading 佐证）。 */
function sameNameCandidates(target: Element): CandidateSummary[] {
  const role = target.getAttribute('role') ?? (target.tagName === 'BUTTON' ? 'button' : null);
  const text = (target.textContent ?? '').trim();
  const out: CandidateSummary[] = [];
  for (const el of document.querySelectorAll('button, [role="button"], a')) {
    if ((el.textContent ?? '').trim() !== text) continue;
    let heading: string | null = null;
    for (let node = el.parentElement; node; node = node.parentElement) {
      const h = node.querySelector('h1,h2,h3,h4')?.textContent?.trim().slice(0, 40) ?? null;
      if (h) { heading = h; break; }
    }
    out.push({ index: out.length, nearestHeading: heading });
    if (out.length >= 10) break;
  }
  void role;
  return out;
}

Object.assign(window, {
  __DSH_DISAMBIG__: collectDisambiguationContext,
});
