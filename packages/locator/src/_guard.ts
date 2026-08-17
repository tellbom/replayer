const FORBIDDEN_BROWSER_PATTERNS = [
  { pattern: /\brequire\s*\(/, label: 'require(' },
  { pattern: /\bprocess\s*\./, label: 'process.' },
  { pattern: /\bimport\s+/, label: 'import statement' },
] as const;

export function assertBrowserBundle(source: string, filename: string): void {
  for (const forbidden of FORBIDDEN_BROWSER_PATTERNS) {
    if (forbidden.pattern.test(source)) {
      throw new Error(`${filename} 包含浏览器侧禁用内容: ${forbidden.label}`);
    }
  }
}
