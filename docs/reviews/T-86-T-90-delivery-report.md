# T-86 ~ T-90 交付与验收报告

日期：2026-08-22

## T-86 参数化正确性

- V-86-1 enum 绑定：PASS
  - draft 中 approver/submit 的 type：`{{type|enumValue}}`
  - `enumMap`：3 项（工作日/周末/节假日）
- V-86-2 跨参数回放：PASS
  - 输入：工作日录制的分析器直接产物；回放参数为周末加班；未人工修改 draft
  - replay：成功
  - 服务端记录的 type：`weekend`
  - history 原文：`{"kind":"overtime","no":"OT-20260822-0002","type":"weekend","startTime":"2026-08-23 13:00:00","endTime":"2026-08-23 16:00:00","reason":"T86 weekend replay 1787328628215","createdAt":"2026-08-21T16:10:38.633Z"}`
- V-86-3 未引用参数报错：PASS；生成阶段抛 `UnusedParameterError`
- V-86-4 下标取值被拒：PASS；固定数组下标改为参数绑定，无法判定时生成 `TODO_UNRESOLVED` 并由 `parseSkill()` 拒绝
- V-86-5 跨步依赖回归：PASS；`approverId` / `approvalToken` 模板保留；请假流程 A4 通过

## T-87 联动关联

- V-87-1 值匹配关联：PASS
  - approver 归属：`s5`（该次真实录制中 `s5` 即“选择加班类型”；文档示例的 `s4` 不是固定编号）
  - `_correlation.method`：`request-value-match`
  - `_correlation.confidence`：`high`
- V-87-2 时间窗兜底：PASS；`confidence=low`，生成 YAML 带明确 TODO 注释
- V-87-3 人工慢节奏：PASS；动作间隔 1.6 秒的真实录制仍归属 `s5`，方法和值置信度不变
- V-87-4 correlate 回归：12 passed / 0 failed
- 额外门禁：短字符串、布尔和小整数不允许作为 DOM 因果证据，避免 `code=0` 静默误关联

## T-88 sanitizeMode 与 drop_response

- V-88-1 性质判定：响应解析缺陷
  - `session/csrf` 都有有效 JSON 响应体；浏览器缓存响应缺少 `content-type`，旧逻辑把 JSON 降级为正则 fallback
  - 修复后，无媒体类型但可完整解析的 JSON 走 structured；空体为 none；畸形 JSON 仍为 fallback
- V-88-2 修复后分布：`structured=5 none=0 fallback=0`
- V-88-3 直连 drop_response：PASS
  - status：`null`
  - 分支：`status=null: TypeError: Failed to fetch`
  - outcome：`outcome_unknown`
  - submissions delta：`1`
  - 未发生自动 UI fallback

## T-89 审计脚本

- `npm run audit:network`：PASS，九个阶段全部通过
- `npm run audit:channels`：PASS，输出 `network=3 ui=0 merged=3 auto=0`
- `npm run audit:dependency`：PASS，服务端值为 `weekend`
- 实际平台：Windows 通过；脚本仅使用 Node API、`process.execPath` 和跨平台路径拼接，不依赖 jq/grep/特定 shell。macOS/Linux 本轮未做实机执行。

## T-90 外部方案对照评审

- 独立评审已完成，详见 `docs/reviews/T-90-external-comparison.md`
- 结论：当前“一变体一 skill”是安全的阶段性方案；未来公共片段应来自多条已验证录制和人工合并，不能从单条录制猜测未见字段
- workflow-use 当前版本不具备 DSH 已冻结的 enum/未引用参数门禁、写确认、四态 outcome、身份锁与 T-84 漂移门禁；T-86 ~ T-89 与既有方向无冲突

## 回归

- build：PASS（全部 workspace）
- unit：164 passed / 0 failed
- e2e 定向回归：31 passed / 0 failed / 0 skipped
- T68-T74 + T84：21 passed / 0 failed
- `npm run audit:network`：overall PASS

## 提交

- `b16bb62` docs(T-90): external comparison review
- `369e07f` fix(T-86): bind enum parameters safely
- `e96bfc8` fix(T-87): correlate requests by causal values
- `c1a9342` fix(T-88): verify direct disconnect outcomes
- `88957b5` fix(T-87): exclude weak DOM evidence
- `38fe742` fix(T-86): normalize business type parameters
- `b9f351b` feat(T-89): add executable network audits
- `3149ab5` test(T-87): verify slow recording cadence

## 总结

- 本轮状态：PASS，可进入下一节点
- 遗留问题：无阻塞项
- 限制：macOS/Linux 未做实机脚本执行；完整 Playwright 全量套件未运行，本轮按风险执行了 31 个定向 e2e，并完成全部 unit、workspace build 与指定 T68-T74 + T84 门禁
