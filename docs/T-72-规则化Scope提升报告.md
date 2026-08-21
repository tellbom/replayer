# T-72 规则化 Scope 提升报告

日期：2026-08-21

## 结论

T-72 放行。动态 scope 未命中且 page-global selector 为 LOW 时，录制器会在调用 LLM 前向上查找具名业务容器，在容器内重新生成目标，并用 Playwright 对 scope、target 和真实点击 oracle 做唯一性验证。

原 D 场景已经从：

```text
internal:role=button[name="搜索"i] >> nth=1  LOW
```

提升为：

```text
section:has-text("加班区") >> internal:role=button[name="搜索"i]  HIGH
```

实际 LLM 回调次数为 0。

## 覆盖规则

- `role=region/form/group` 且具备 `aria-label` 或 `aria-labelledby`
- `section/fieldset` 且包含 heading 或 legend
- `.el-card/.el-collapse-item/.el-tab-pane` 且能提取标题或可访问名

规则只在以下条件全部成立时接管：

- 原目标为 Playwright LOW
- scope selector 全页唯一
- target selector 在 scope 内唯一且为 HIGH
- Playwright 实际命中元素等于本次 `actionIdx` 的点击 oracle

否则继续进入既有 LLM 消歧路径，不把未验证候选标成 HIGH。

## 量化

测试入口：`e2e/t72-ancestor-scope.spec.ts`

| 指标 | 结果 |
|---|---:|
| 原始 LOW 场景 | 1 |
| 规则提升成功 | 1 |
| 规则覆盖率 | 100%（1/1） |
| 提升后 LLM 回调 | 0 |

另已验证具名 region、fieldset/legend、Element card 三类容器均生成预期的 scope selector。
