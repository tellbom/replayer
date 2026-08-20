# Vendored from microsoft/playwright

- Upstream: https://github.com/microsoft/playwright
- Version/commit tag: **v1.62.1**（与本项目 package-lock 中 playwright 1.62.1 严格对应）
- License: Apache License 2.0（见各文件头；全文 http://www.apache.org/licenses/LICENSE-2.0）

## 来源文件

| 文件 | 上游路径 |
|---|---|
| selectorGenerator.ts | packages/injected/src/selectorGenerator.ts |
| selectorEvaluator.ts | packages/injected/src/selectorEvaluator.ts |
| selectorUtils.ts | packages/injected/src/selectorUtils.ts |
| domUtils.ts | packages/injected/src/domUtils.ts |
| roleUtils.ts | packages/injected/src/roleUtils.ts |
| layoutSelectorUtils.ts | packages/injected/src/layoutSelectorUtils.ts |
| locatorGenerators.ts | packages/isomorphic/locatorGenerators.ts |
| locatorUtils.ts | packages/isomorphic/locatorUtils.ts |
| stringUtils.ts | packages/isomorphic/stringUtils.ts |
| selectorParser.ts | packages/isomorphic/selectorParser.ts |
| cssParser.ts | packages/isomorphic/cssParser.ts |
| cssTokenizer.ts | packages/isomorphic/cssTokenizer.ts |

## 本目录允许的改动

- **禁止修改上游算法**。唯一例外：`ariaSnapshot-shim.ts` 与 `tsconfig.json`
  是 DSH 添加的适配文件（非上游内容），用于类型别名与模块解析。
- Playwright 升级时：以新版本 tag 重新拉取上述文件并替换整个目录，
  目录名随之改为新版本号；`packages/locator/src/pw-selector-generator.ts`
  （DSH Adapter）必须重新验证六场景 POC 后方可合入。
