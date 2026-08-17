import { StepExecutionError } from '@dsh/core';
import type { ExecContext, Skill } from '@dsh/core';
import type { Page } from 'playwright';

type Preflight = Skill['preflight'][number];

export interface PreflightDiagnostic {
  name: string;
  source: 'current-dom' | 'request-json' | 'request-dom' | 'request-regex';
  ok: boolean;
}

/** 执行预取并仅将动态值保存在运行时上下文。 */
export async function executePreflights(
  page: Page,
  preflights: Preflight[],
  context: ExecContext,
): Promise<PreflightDiagnostic[]> {
  const diagnostics: PreflightDiagnostic[] = [];
  for (const preflight of preflights) {
    if (!preflight.request && preflight.extract.type !== 'dom') {
      throw new StepExecutionError(`无 request 的 preflight 只能从 DOM 提取: ${preflight.name}`);
    }
    const result = await page.evaluate(async (spec) => {
      const readElement = (root: ParentNode, selector: string, attribute: string): string | null =>
        root.querySelector(selector)?.getAttribute(attribute) ?? null;
      const readJsonPath = (value: unknown, path: string): unknown => {
        const segments = path
          .replace(/^\$\.?/, '')
          .replace(/\[(\d+)\]/g, '.$1')
          .split('.')
          .filter(Boolean);
        let current = value;
        for (const segment of segments) {
          if (
            (typeof current !== 'object' || current === null) ||
            !(segment in current)
          ) {
            return undefined;
          }
          current = (current as Record<string, unknown>)[segment];
        }
        return current;
      };

      if (!spec.request && spec.extract.type === 'dom') {
        return {
          value: readElement(document, spec.extract.selector, spec.extract.attribute),
          source: 'current-dom' as const,
        };
      }
      const request = spec.request!;
      const response = await fetch(request.url, {
        method: request.method,
        credentials: 'include',
        headers: request.headers,
      });
      const text = await response.text();
      if (!response.ok) return { error: `HTTP ${response.status}` };
      if (spec.extract.type === 'jsonPath') {
        return {
          value: readJsonPath(JSON.parse(text), spec.extract.path),
          source: 'request-json' as const,
        };
      }
      if (spec.extract.type === 'dom') {
        const documentValue = new DOMParser().parseFromString(text, 'text/html');
        return {
          value: readElement(documentValue, spec.extract.selector, spec.extract.attribute),
          source: 'request-dom' as const,
        };
      }
      const match = new RegExp(spec.extract.pattern).exec(text);
      return { value: match?.[spec.extract.group], source: 'request-regex' as const };
    }, preflight);
    if ('error' in result) {
      throw new StepExecutionError(`preflight ${preflight.name} 请求失败: ${result.error}`);
    }
    if (result.value === undefined || result.value === null || result.value === '') {
      throw new StepExecutionError(`preflight ${preflight.name} 未提取到值`);
    }
    context.vars[preflight.name] = result.value;
    diagnostics.push({ name: preflight.name, source: result.source, ok: true });
  }
  return diagnostics;
}
