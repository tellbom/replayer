# T-84 LOW 语义漂移防护报告

## 结论

T-84 放行。LOW 定位执行前会先做唯一性检查，再用录制与回放同源的 W3C 标准语义提取函数进行归一化精确比对。语义不同会在动作发生前硬停并进入 `needs_rerecord`；不会填写错位字段，也不会继续到后续提交。

## 契约与实现

- `recordedHint` 正式包含动作、可见文本及来源、tag、role、录制匹配数。
- 提取优先级为 accessible name、关联 label、ARIA、placeholder、title、自身文本；不含任何框架类名、XPath、相似度或 LLM。
- 归一化处理首尾空白、全角字符、规定标点、必填星号、连续空白和英文大小写；结果必须完全相等。
- LOW 的 0 match、多匹配、frame/scope 缺失、语义漂移和动作失败均可写入结构化 `rerecordReason`。
- `verifiedTtlDays` 默认 30 天；超期由 `verified` 回落 `draft`。`needs_rerecord` 在浏览器启动前直接拒绝。
- `verified` 不免除 C6：write/critical 仍逐次确认。
- 分析输出增加 LOW 占比、可校验/不可校验数量；LOW 占比达到 50% 时只警告，不阻止保存。

## 验收

`e2e/t84-semantic-drift.spec.ts`：6/6 测试组通过，覆盖：

- V8-a：漂移到“结束时间”时硬停，字段未填写，`submissions=0`，状态为 `needs_rerecord/semantic-drift`。
- V8-b：漂移到同名“开始时间”继续执行，固化为 Accepted product limitation。
- V9、V12、V13、V16：语义不变、null 跳过、HIGH 不校验、录制回放同源。
- V10、V11：标点/必填标记、中文内部空白与英文大小写归一化无假阳性。
- V14、V15：TTL 回落与 `needs_rerecord` 启动前拒绝。
- V6、V7、V17：0 match/多匹配分类与 LOW 高占比警告。

本节点不实现 T-81 的 CLI 人工确认和持久化交互，不进入 T-82/T-83。
