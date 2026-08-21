import type { Skill } from '@dsh/core';

export function renderLocatorQualitySummary(skill: Skill): string {
  const targets = skill.steps
    .map((step) => step.ui)
    .filter((ui): ui is NonNullable<typeof ui> & {
      target: Extract<NonNullable<typeof ui>['target'], { strategy: 'playwright' | 'frame-playwright' }>;
    } => ui?.target?.strategy === 'playwright' || ui?.target?.strategy === 'frame-playwright');
  const low = targets.filter((ui) => ui.target.confidence === 'LOW');
  const checkable = low.filter((ui) => ui.recordedHint?.visibleText !== null && ui.recordedHint?.visibleText !== undefined);
  const percent = targets.length === 0 ? 0 : Math.round((low.length / targets.length) * 100);
  const lines = [
    `Skill：${skill.skill.name}`,
    `共 ${skill.steps.length} 个步骤`,
    `稳定定位：${targets.length - low.length}`,
    `位置型定位：${low.length}  (${percent}%)`,
    `  其中可语义校验：${checkable.length}`,
    `  其中无法校验：${low.length - checkable.length}`,
  ];
  if (percent >= 50) {
    lines.push(
      `⚠ 此 Skill 中 ${low.length}/${targets.length} 步为位置型定位（${percent}%）。`,
      '  该页面缺乏语义结构，Skill 稳定性较低，页面任何改动都可能导致步骤错位。',
    );
  }
  return `${lines.join('\n')}\n`;
}
