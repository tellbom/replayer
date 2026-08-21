# T-75 Cutover 决策报告

## 决策

**本轮不切换 `DSH_LOCATOR_ENGINE` 默认值，不删除 legacy。**

决策输入已经齐备，因而允许作出 Cutover 判断；但现有数据仍包含一个已证实的表单结构盲区，且 scope 对 LLM 触发次数的对照数据为 0 → 0，不能证明全量默认切换的成本收益。因此本节点结论为 **NO-GO**，当前默认值继续为 `legacy`，`playwright` 继续通过显式环境变量启用。

## 决策输入

| 输入 | 实测数据 | 对 Cutover 的含义 |
|---|---:|---|
| T-68 六场景 | 2 HIGH / 4 LOW（33.3% / 66.7%） | 官方 Codegen 结果与 DSH 同构，链路可信；但多数同名/同构场景仍有位置依赖。 |
| T-69 G1–G5 | 3 HIGH / 2 LOW（60% / 40%） | G3 的 Element Plus label/control 无关联是明确结构盲区；`el-locator.byFormItem` 仍不可删除。G4 需要 scope。 |
| T-71 scope 与 LLM | page-global 0，scoped 0 | 验证了严格生命周期和唯一性边界，但该样本不能证明 LLM 调用量下降。 |
| T-72 规则提升 | 1/1（100%），LLM 0 | D 场景可从 LOW 提升为 scoped HIGH；覆盖样本只有 1 个，不能外推为全场景覆盖。 |
| T-73 动态矩阵 | 16/16（100%） | H1–H10、I1–I6 的动态执行能力达到当前验收线。 |

补充证据：T-74 已验证异步联动录制与回放 2/2 通过，动作等待不依赖固定 sleep；这提高回放稳定性，但不消除 G3 的定位候选缺口。

## 阻止默认切换的明确条件

1. G3 仍只能生成 `internal:role=textbox >> nth=5` LOW。T-69 已要求把 `el-locator.byFormItem` 作为补充候选接入 Playwright 候选池或消歧层，该闭环尚未交付。
2. T-68 的六场景仍有 4 个原始 LOW；T-72 只证明其中一个具名 section 场景可规则提升。
3. T-71 的 LLM 对照为 0 → 0，不能据此修改成本模型或宣称 scope 已降低 LLM 调用。

后续若要重新发起 Cutover，至少需先完成 G3 的语义候选闭环，并重跑表单矩阵与扩展后的规则覆盖样本；结论必须继续来自正式 `record()` 链路。

## T-78 触发判断

T-78 **不触发**。其前置条件是“现场确认无法保持浏览器常驻”；当前 T-76 已实测 daemon 持有 persistent context，录制/回放可通过 CDP 附着同一会话，附着客户端断开后 owner context 仍有效。没有出现现场常驻失败证据，因此不实现 storageState 快照，也不引入额外凭证文件。
