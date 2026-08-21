# T-81 LOW 首次人工验证状态机报告

## 结论

T-81 放行。包含 LOW 定位的 `draft` Skill 在任何浏览器或业务动作发生前必须由用户明确进入监督运行；完整运行成功后仍需再次确认结果正确，随后才持久化为 `verified`。`--yes` 不会绕过该流程。

## 状态机与交互

- 全 HIGH Skill 不触发 LOW 风险交互。
- LOW `draft` 先展示步骤、录制语义和 selector 风险清单，再询问是否开始监督运行；否认则不执行。
- 监督运行成功后询问完整流程是否正确；确认后写入 `verifiedAt`、随机 `verifiedRunId` 并清除首次验证要求，否认则保持 `draft`。
- `verified` 且未超过 TTL 的 Skill 不重复首次确认，但 write/critical 的 C6 逐步确认仍保留。
- TTL 到期先持久化回 `draft`，再要求重新监督验证。
- 0 match、多匹配、语义漂移等结构失败由回放器标记，CLI 在异常返回前持久化 `needs_rerecord`；后续运行在浏览器启动前拒绝。
- `dsh replay` 与自然语言 `dsh run` 使用同一验证流程；回放器本身也拒绝缺少 `supervisedVerification` 的未验证 LOW Skill，非 CLI 调用不能静默绕过。

## 验收

- V1：全 HIGH 不触发 LOW 流程。
- V2：LOW 草稿要求监督验证，并展示风险清单。
- V3：监督运行成功且确认正确后持久化为 `verified`。
- V4：拒绝开始时零执行；完整运行后否认时保持 `draft`。
- V5：已验证 LOW 不重复要求首次确认。
- V6：0 match 停止并进入 `needs_rerecord/not-found`。
- V7：多匹配严格停止并进入 `needs_rerecord/strict-multiple`，不使用 `.first()`。

V1-V5 由 `packages/cli/src/verification.test.ts` 固化；回放器启动前强制门禁由 `packages/replayer/src/engine.test.ts` 固化；V6/V7 的真实定位分类与停止行为由 `e2e/t84-semantic-drift.spec.ts` 固化。
