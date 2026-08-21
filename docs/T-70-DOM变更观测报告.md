# T-70 DOM 变更观测报告

日期：2026-08-21

## 结论

T-70 放行。浏览器侧 `window.__DSH_MUTATION__` 已实现动作级 `begin/end` 观测，默认在动作后继续收集 800ms，并且只返回折叠后的业务子树根。

真实 Element Plus 下拉验证发现其面板可能预渲染，点击后仅追加 option 或切换 popper 属性。实现因此同时处理新增节点和语义容器显隐变化，并把 option 等叶子变化提升到最近的 listbox 根；不记录三个 option。

## 实测结果

测试入口：`e2e/t70-mutation-tracker.spec.ts`

| 动作 | roots | kind | portaled | 结果 |
|---|---:|---|---|---|
| 点击真实 `el-select` | 1 | `listbox` | `true` | 通过 |
| 点击真实“提交” | 1 | `dialog` | `false` | 通过 |
| 点击“添加明细” | 1 | `table-row` | `false` | 通过 |
| 选择联动值 | 1 | `panel` | `false` | 通过 |

每次动作均只产出 1 个 root，满足 `≤ 3` 的噪音门禁。每个结果同时包含生成后的 `descriptor` 与 `appearedAfterMs`。

## 实现边界

- 浏览器侧代码没有 npm 依赖和 Node API，构建为独立 IIFE。
- 观测器按 `actionIdx` 隔离；重复 begin 或无 begin 的 end 直接报错。
- 已接入基础浏览器上下文及注入自检；本任务只提供观测能力，不提前写入 T-71 的 scope/produces 契约。
