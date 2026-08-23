# T-85 · Network 通道健康审计报告

日期：2026-08-21

## 审计结论

Network 通道判定为：**部分退化**。

执行器、跨请求动态值注入、C2 浏览器内 fetch 和 Outcome 四态仍然工作；但当前真实录制暴露出以下问题：

1. `session`、`csrf` 两条 GET 请求的 `sanitizeMode` 为 `fallback`，不满足 T-24“全部 structured”的 DoD。
2. `approver` 的 `requestTs` 落在后续“事由 fill”动作区间，实际没有归属到触发它的“选择加班类型”动作。
3. 自动生成 draft 把 `type` 写成 `{{s4[0].value}}`，即从类型列表第一项取值；切换为周末参数前仍需人工修正为 `{{type|enumValue}}`。审批人和 approvalToken 的跨步模板没有硬编码。

审计期间未修改 `packages/`、既有测试、技能或历史报告。

## A · 测试存活性

```text
channel-network: 1 passed / 0 failed / 0 skipped
network-record:  1 passed / 0 failed / 0 skipped
analyzer 单测:   21 passed / 0 failed / 0 skipped
fallback:        3 passed / 0 failed / 0 skipped
```

任务原命令全部无法进入测试执行。四条命令各自退出码均为 1，原始输出相同：

```text
WARN  The "workspaces" field in package.json is not supported by pnpm. Create a "pnpm-workspace.yaml" file instead.
ERROR This project is configured to use npm
For help, run: pnpm help run
EXIT_CODE=1
```

这不是“无匹配测试”，而是任务命令与仓库声明的 `npm@11.6.0` 不兼容。随后使用仓库等价命令执行。

### channel-network 原始测试输出

```text
Running 1 test using 1 worker
[1/1] e2e\channel-network.spec.ts:22:1 › channel-network: 联动提交、模板缺失与响应丢失机械分类
1 passed (17.1s)
```

### network-record 原始测试输出

```text
Running 1 test using 1 worker
[1/1] e2e\network-record.spec.ts:9:1 › network-record: 加班请求按发出时间录入并结构化脱敏
1 passed (16.3s)
```

### analyzer 原始测试输出

```text
Test Files  4 passed (4)
Tests       21 passed (21)
```

明细：`params` 2、`preflight` 5、`correlate` 8、`draft` 6。

### fallback 原始测试输出

```text
Running 3 tests using 1 worker
[1/3] fallback: not_sent permits one confirmed UI fallback
[2/3] fallback: drop_response resolves by postcondition without replay
[3/3] fallback: 403 is forbidden and never enters authentication recovery
3 passed (47.1s)
```

## B · 录制产物

使用当前 Mock OA 完整录制了一次工作日加班申请，包括类型选择、审批人联动和最终提交。

```text
捕获请求总数:       5
approver 被捕获:    是
submit 被捕获:      是
sanitizeMode 分布:  structured=3 fallback=2 none=0
requestTs 异常记录: 0 条
```

环境未安装 `jq`，文档中的三条 `jq` 命令原样执行均返回：

```text
jq : The term 'jq' is not recognized as the name of a cmdlet, function, script file, or operable program.
```

使用 PowerShell `ConvertFrom-Json` 做等价只读查询，原始结果为：

```json
[
  {"method":"GET","url":"/api/session","mutating":false,"sanitizeMode":"fallback","requestTs":1787323435070,"responseTs":1787323435835},
  {"method":"GET","url":"/api/csrf","mutating":false,"sanitizeMode":"fallback","requestTs":1787323435835,"responseTs":1787323436709},
  {"method":"GET","url":"/api/overtime/types","mutating":false,"sanitizeMode":"structured","requestTs":1787323436707,"responseTs":1787323437269},
  {"method":"POST","url":"/api/overtime/approver","mutating":true,"sanitizeMode":"structured","requestTs":1787323437756,"responseTs":1787323438437},
  {"method":"POST","url":"/api/overtime/submit","mutating":true,"sanitizeMode":"structured","requestTs":1787323438656,"responseTs":1787323439153}
]
```

`requestTs` 均存在、均不等于 `responseTs`，并且均早于 `responseTs`。`approver` 与 `submit` 均为 `structured`；但全体请求并非全部 `structured`，因此仍按 T-24 不符记录。

## C · 关联与依赖

```text
approver 归属到“选择加班类型”: 否
实际归属:                    “事由” fill
submit body 使用跨步模板:    是
correlate.ts 时间戳字段:      requestTs
```

真实时间线：

```text
选择工作日加班 ts=1787323437251
开始时间       ts=1787323437388
结束时间       ts=1787323437500
事由 fill      ts=1787323437619
approver 请求  requestTs=1787323437756
```

因此最近前置动作算法把 approver 归给了“事由 fill”。生成 draft 中 approver 为 `s9`，submit 的关键 body 为：

```yaml
type: "{{s4[0].value}}"
approverId: "{{s9.approverId}}"
approvalToken: "{{s9.approvalToken}}"
```

审批人与 token 使用跨步模板，没有写入录制时具体值；但 `type` 来自类型列表第一项，不是本次回放参数。

实际关联代码：

```ts
const actionIndex = ownerActionIndex(session.actions, request.requestTs);

function ownerActionIndex(actions: RecordedAction[], requestTs: number): number {
  // 按最近前置动作及 2 秒窗口归属
}
```

确认使用 `requestTs`，未使用 `responseTs`，C15 保持完好。

## D · channel 分布

```text
本次 draft: network=6 ui=3 merged=2 auto=0
已有技能:   network=3 ui=0 merged=3
network 是否为 0: 否
```

分析器没有退化为“一切皆 UI”。`draft.ts` 当前判定主干为：

```ts
request?.mutating || item.action?.type === 'navigate' || (request && !ui)
  ? 'network'
  : item.action?.type === 'fill' || item.action?.type === 'datetime'
    ? 'merged'
    : 'ui'
```

问题发生在关联阶段，而不是 channel 判定分支：approver 被关联到了错误的前置动作。

## E · 依赖陷阱

```text
workday 录制 -> weekend 回放: 成功
结论: approverId / approvalToken 跨请求依赖识别正确
限制: 自动生成 draft 仍需人工修正 type 模板及可执行步骤
```

本次自动 draft 不是无需复核即可直接回放的成品，因此使用仓库中同一流程的已修正技能执行周末参数回放。结果：

```json
{
  "approver": {
    "status": 200,
    "responseBody": {"approverId":2046,"approverName":"李总监","approvalToken":"<REDACTED>"}
  },
  "submit": {
    "requestBody": {
      "type":"weekend",
      "startTime":"2026-08-22 09:00:00",
      "endTime":"2026-08-22 12:00:00",
      "reason":"T85 dependency trap weekend",
      "approverId":2046,
      "approvalToken":"<REDACTED>"
    },
    "status":200,
    "responseBody":{"code":0,"no":"OT-20260821-0002"}
  }
}
```

反例与正确注入对照：

```text
weekend + workday approverId/token  -> HTTP 400，审批人不匹配
weekend + fresh weekend values      -> HTTP 200，生成 OT-20260821-0003
```

这证明 Mock 的依赖陷阱真实存在，且当前修正技能会重新调用 approver 并注入新值。动态 token 已在报告中脱敏，不持久化明文。

## F · C2 约束

```text
Node http 客户端引用: 0 处
page.evaluate 内 fetch: 是
```

搜索范围：`packages/replayer/src/`；模式：`axios|node-fetch|got\(|http\.request|https\.request`，无匹配。

关键实现：

```ts
return page.evaluate(
  async ({ spec, origin, timeoutMs, authorization }) => {
    // ...
    fetchStarted = true;
    const response = await fetch(new URL(spec.url, origin).href, {
      method: spec.method,
      credentials: 'include',
      headers,
      body,
      signal: controller.signal,
    });
  },
  // ...
);
```

C2 保持完好。

## G · Outcome 四态

```text
fetchStarted 标志位存在:       是
置位于 fetch 调用前一行:       是
未收到响应时无条件 unknown:     是
drop_response 实测:            outcome=outcome_unknown submissions delta=1
自动 UI fallback:              未发生
```

机械分类代码：

```ts
if (!result.fetchStarted) return notSent(step.id, startedAt, result.error ?? '未调用 fetch');
if (result.status === null) {
  return {
    stepId: step.id,
    ok: false,
    outcome: 'outcome_unknown',
    channelUsed: 'network',
    // ...
  };
}
```

实测原始摘要：

```json
{
  "dropResult": {
    "ok": false,
    "outcome": "outcome_unknown",
    "channelUsed": "network",
    "error": "HTTP 500",
    "raw": {"status":500,"text":""}
  },
  "submissionsBefore": 2,
  "submissionsAfter": 3,
  "delta": 1,
  "uiFallbackObserved": false
}
```

当前 Vite proxy 将后端断连表征为 `HTTP 500 + 空响应体`，不是浏览器侧 `status=null`；执行器仍按非显式拒绝机械判为 `outcome_unknown`。服务端只新增一条业务数据，没有自动 UI 重提。

## 总结与建议优先级

```text
network 通道整体状态: 部分退化
```

1. **P1**：修复/澄清 T-24 sanitizeMode 契约，使 session、csrf 等 JSON GET 也记录为 `structured`；同时扩充测试，不能只断言 approver/submit。
2. **P1**：修正异步联动请求的动作归属，使 approver 稳定关联到“选择加班类型”，而非请求真正发出前的最近任意 UI 动作。
3. **P1**：修正 draft 的 `type` 参数化，避免 `{{s4[0].value}}` 固定取类型列表第一项；增加“工作日录制、周末参数回放”的生成 draft 级验收。
4. **P2**：把 T-85 文档的 pnpm/jq 命令替换为本仓库可直接执行的 npm/PowerShell 命令，避免审计入口自身失效。

依赖提取、跨步模板、Playwright 页面内 fetch、`fetchStarted` 边界和 `outcome_unknown` 防重复提交规则均未发现失效。
