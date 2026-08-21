# T-71 Scope 推导与契约扩展报告

日期：2026-08-21

## 结论

T-71 放行。动态 root 已从 T-70 观测结果进入正式录制后处理：下一动作位于上一动作产生的 root 内时，录制器写入 `produces`、`waitAfter.scopeReady`、`ui.scope`，并在 root 内重新生成目标。规则命中后不进入 LLM 消歧。

回放端严格执行 `root → target` 两层定位。scope 未注册、root 非唯一或 target 非唯一均报错；不使用 `.first()` 静默选取。

## 契约

- `Step.requires`、`Step.produces`、`Step.waitAfter`、`Step.pageState`
- `UiAction.scope`
- `ExecContext.scopes`
- `RecordedAction.scope/produces/waitAfter`，供分析器生成技能草稿

默认值与交接契约一致：`requires=[]`、`produces.portaled=false`、`waitAfter.timeoutMs=8000`。

## 正式录制链路实测

测试入口：`e2e/t71-scope.spec.ts`

| 场景 | producer root | consumer selector（scope 内） | confidence | LLM |
|---|---|---|---|---:|
| 动态确认框 | `internal:role=dialog[name="动态确认"i]` | `internal:role=button[name="确定"i]` | HIGH | 0 |
| 动态表格行 | `internal:role=row[name="明细A 删除"i]` | `internal:role=button[name="删除"i]` | HIGH | 0 |
| Element Plus 下拉 | `.el-select-dropdown`，`portaled=true` | `internal:role=option[name="工作日加班"i]` | HIGH | 0 |

下拉触发控件改为记录内部 combobox，产物为 `internal:role=combobox[name="加班类型"i]`（HIGH），避免 wrapper 的 `div >> nth`。

## LLM 触发量化

同一次录制中，动态确认按钮和行内删除按钮的 page-global Playwright 结果本身已是 HIGH，因此基准 LLM 触发数为 0；引入 scope 后实际回调数仍为 0：

```text
pageGlobalLlmTriggers=0
scopedLlmTriggers=0
```

这个结果说明当前 Mock 的 dialog/row 语义已足够强，不能宣称 scope 在这两个桩上降低了 LLM 次数。scope 的已验证收益是把动态生命周期和唯一性边界写入契约，并使下拉、弹窗、表格行都能在回放期严格复现。T-72 将使用同名 section 场景验证非零的规则化提升收益。

## 时序修正

真实快速操作验证发现，固定 800ms 窗口会与下一动作重叠。现规则为：最多观测 800ms；若下一动作先发生，立即封口上一动作，再开启新窗口。后续动作的 DOM 变化不会归到前一动作。

## 回放验证

- producer 执行后等待唯一 scope root 可见并注册。
- consumer 在已注册 root 内唯一命中并成功点击。
- scope 缺失时报错。
- 两个同名 scope root 同时存在时触发 Playwright strict mode violation，未选择第一个。
