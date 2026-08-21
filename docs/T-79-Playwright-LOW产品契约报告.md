# T-79 Playwright LOW 产品契约报告

## 结论

T-79 产品契约已落地。Playwright 的位置型 selector 可以合法保存为 LOW，但不会被提升或伪装为 HIGH；含 LOW 的录制草稿自动设置 `requiresFirstRunVerification=true`，新 Skill 生命周期默认从 `draft` 开始。

## 契约

- Skill verification 状态：`draft`、`verified`、`needs_rerecord`。
- 首次验证字段：`requiresFirstRunVerification`、`verifiedAt`、`verifiedRunId`、`verifiedBy`。
- LOW UI 步骤保存 `recordedHint`：动作、可见语义、语义来源、标签名、role 和录制匹配数。
- 可见语义仅使用标准 accessible name、关联 label、ARIA、placeholder、title 和自身文本，不包含框架类名、XPath、相似度或 LLM。
- 分析器仅根据真实 `confidence: LOW` 设置首次验证要求；不改变定位器质量等级。

页面重大结构变化后的处理边界保持为停止并重新录制，不承诺自动迁移旧 Skill。首次验证 CLI 交互属于 T-81，不在本节点提前实现。
