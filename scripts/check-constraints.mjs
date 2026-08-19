#!/usr/bin/env node
// 【M3 停止检查】C16/C17/C2/C11 约束检查（CI 用）。违规即 exit 1。
// 路径限定 packages/ skills/ entries/ runs/，明确排除 scripts/dev-only/。
// 纯 Node 实现（不依赖外部 grep，跨平台）。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const EXCLUDED = ['scripts/dev-only/', 'node_modules', 'tmp', 'dist'];

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(ROOT, full).replaceAll('\\', '/');
    if (EXCLUDED.some((prefix) => rel.startsWith(prefix) || name === prefix.replace('/', ''))) continue;
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else out.push({ path: rel, content: readFileSync(full, 'utf8') });
  }
  return out;
}

function scanLines(files, pattern) {
  const hits = [];
  for (const file of files) {
    for (const [i, line] of file.content.split('\n').entries()) {
      if (pattern.test(line)) hits.push({ file: file.path, line: i + 1, text: line.trim() });
    }
  }
  return hits;
}

const CHECKS = [
  {
    id: 'C16/C17-browser-no-credentials',
    desc: 'packages/browser 不得包含凭证操作（grant_type、client_secret、fill 表单填写）',
    files: walkFiles(join(ROOT, 'packages/browser/src')),
    pattern: /grant_type|client_secret|\.fill\(/i,
    allow: [
      // 登录页 DOM marker 判定（探测路径，非凭证操作）
      { file: 'packages/browser/src/auth.ts', pattern: /input\[type=["']password["']\]/ },
    ],
  },
  {
    id: 'C17-configs-no-plain-credentials',
    desc: 'skills/ 与 entries/ 不得有明文凭证',
    files: [...walkFiles(join(ROOT, 'skills')), ...walkFiles(join(ROOT, 'entries'))],
    pattern: /grant_type|client_secret|api_?key\s*:/i,
    allow: [{ file: 'entries/oa.yaml', pattern: /input\[type="password"\]/ }],
  },
  {
    id: 'C2-replayer-no-node-http',
    desc: 'packages/replayer 不得使用 Node 侧 http 客户端',
    files: walkFiles(join(ROOT, 'packages/replayer/src')),
    pattern: /axios|node-fetch|got\(|http\.request/,
    allow: [],
  },
];

let failed = 0;
for (const check of CHECKS) {
  const violations = scanLines(check.files, check.pattern).filter(
    (hit) =>
      !check.allow.some(
        ({ file, pattern }) => hit.file === file && pattern.test(hit.text),
      ),
  );
  if (violations.length > 0) {
    failed += 1;
    console.error(`✗ ${check.id}: ${check.desc}`);
    for (const v of violations) console.error(`    ${v.file}:${v.line}  ${v.text.slice(0, 90)}`);
  } else {
    console.log(`✓ ${check.id}`);
  }
}

// C11：runs/ 诊断包不得泄漏真实 JWT（eyJ 开头的完整两段式 token）
const runsDir = join(ROOT, 'runs');
if (existsSync(runsDir)) {
  const jwtPattern = /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/;
  const leaks = scanLines(walkFiles(runsDir), jwtPattern);
  if (leaks.length > 0) {
    failed += 1;
    console.error(`✗ C11-runs-no-jwt-leak: 诊断包含明文 JWT`);
    for (const l of leaks.slice(0, 5)) console.error(`    ${l.file}:${l.line}`);
  } else {
    console.log('✓ C11-runs-no-jwt-leak');
  }
} else {
  console.log('✓ C11-runs-no-jwt-leak (runs/ 不存在，跳过)');
}

if (failed > 0) {
  console.error(`\n${failed} 项约束检查失败`);
  process.exit(1);
}
console.log('\n约束检查全部通过');
