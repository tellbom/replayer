# T-82 legacy 移除 Gate 报告

## 门禁结论

```text
Playwright 默认模式：未设置 DSH_LOCATOR_ENGINE
unit: 153 passed / 0 failed
e2e: 91 passed / 3 contract-disabled skipped / 0 failed

T68: PASS（2/2；4 HIGH / 2 LOW）
T69: PASS（2/2；4 HIGH / 1 LOW）
T70: PASS（1/1）
T71: PASS（2/2）
T72: PASS（2/2）
T73: PASS（4/4 测试组，H1-H10/I1-I6 共 16/16）
T74: PASS（2/2）

HIGH steps: 8
LOW steps: 3
  可语义校验: 2
  无法校验: 1（T69 G3）

T-84 语义漂移防护:
  V8-a (漂移到不同语义):  PASS
  V8-b (漂移到相同语义):  Accepted product limitation
  V9-V17:                 PASS
  假阳性次数:              0

LOW supervised verification:
PASS

是否仍存在只能由 legacy 完成的真实业务能力：
NO

Cutover:
GO
```

## 完整 Skill 流程证据

以下流程均在本次全量 e2e 的同一默认 Playwright 运行中完成：

1. A2：持久化会话进入 Mock OA，完整执行加班 Skill 的预取、联动、参数合并和 network 提交，业务返回 `confirmed_success`。
2. A9：自然语言路由选中 `oa_overtime_submit`，完成参数抽取和完整提交，取得真实 `OT-*` 业务单号。
3. `channel-ui`：强制 UI 通道完成加班类型、审批人联动、时间、事由、确认弹窗和最终提交，并从调试接口验证落库记录。

附加覆盖：A1 完整录制并提交加班后生成可解析 Skill 草稿；A4 使用同一录制器完整录制并提交请假流程。

## Gate 判断依据

- T68/T69 的 LOW 均如实保留，没有通过框架特判伪装为 HIGH；G3 LOW 不构成 NO-GO。
- LOW 首次监督验证、TTL 回落、`needs_rerecord` 启动前拒绝、V6/V7 严格停止和 T84 语义漂移硬停均已通过。
- `legacy.spec.ts` 验证的是 SSR hidden-field/preflight 通用能力，不依赖 legacy Locator generator。
- 旧 `el-locator` 的既有 UI 动作执行能力不参与 Playwright 录制置信度生成，属于规格允许保留的通用执行兼容能力；没有真实业务只能由 legacy generator 生成或回放。
- 全量门禁曾因工作区外服务占用 `5173` 而误连门户。Mock OA 已固定到专用 `15173` 并启用 `strictPort`；所有 v2 录制测试使用 persistent cookie，CLI 测试使用合法 `probe-only` Entry，最终全量运行无失败。
- 3 个 skipped 分别是需外部 rebuild class 的 A3、未启用 Vue2 条件的 A8、明确不进入开放式探索的 A10；均为规格条件禁用，不是失败或 blocker。

因此 T82 判定 `GO`，允许进入 T83 删除 legacy Locator Engine。
