# T-83 Playwright 单引擎完成报告

## 结论

T-82 Gate 已判定 `GO`，T-83 已完成 legacy Locator Engine 退出。Recorder 现在只注入并调用 Playwright Locator Generator，不再读取引擎切换变量，也不存在 legacy generator 回退分支。

## 删除内容

- 删除 legacy generator 源码 `packages/locator/src/selector-generator.ts`。
- 从 Locator 构建入口移除 legacy generator，并在构建时清除可能遗留的 `dist/selector-generator.iife.js`。
- 删除 `DSH_LOCATOR_ENGINE`、`resolveLocatorEngine`、`__DSH_LOCATOR_ENGINE__` 与 `__DSH_GEN__` 契约及所有运行分支。
- 删除 legacy generator 专属测试和 Playwright/legacy 双引擎对比 POC。
- 现有录制、Mutation descriptor、Browser Context audit 与 `dsh doctor` 统一使用 `__DSH_PWGEN__`。

## 保留边界

- 保留 `el-locator`：它是既有 UI 动作执行兼容能力，不参与 Locator 生成或 LOW 到 HIGH 提升。
- 保留 `legacy.spec.ts`：它覆盖 SSR hidden-field/preflight 通用能力，不依赖 legacy Locator Generator。
- 未新增框架特判、XPath、DOM similarity、sibling scoring、视觉定位或自动改版迁移。
- LOW 继续如实保留，并沿用首次监督验证、T-84 执行前语义断言与结构失败重录契约。

## 验证结果

```text
build:              PASS
unit:               152 passed / 0 failed
constraints:        PASS
full e2e:           89 passed / 3 contract-disabled skipped / 0 failed
T68-T74 + T84:      25 passed / 0 failed
legacy env/global:  0 references
legacy source:      removed
legacy bundle:      absent after build
```

全量 E2E 中的 3 个 skipped 仍为 T-82 已确认的条件禁用项：外部 rebuild class、未启用 Vue2 条件、禁止开放式探索；均不是失败或 T-83 blocker。

## 最终架构

```text
Recorder -> Playwright Locator Generator
             |-> HIGH -> Skill
             `-> LOW  -> First-run verification -> Skill

Skill -> Playwright Replay
          |-> Success
          `-> Structural or semantic failure -> needs_rerecord
```

系统不再存在 Playwright Engine 与 Legacy Engine 的产品选择面。
