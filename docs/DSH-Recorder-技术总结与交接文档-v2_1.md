# DSH Recorder · 技术总结与交接文档 v2.1

> 日期：2026-08-20 ｜ 基线 commit：`e6c6c6a`（feat(T-67b)）
> 面向：接手后续开发的 Codex / 工程师
> 定位：**实际做了什么、攻克了什么、哪些写法有问题、接下来做什么**——全部基于真实代码与实测数据，不复述设计文档。

---

## 一、项目现状总览

| 维度 | 数据 |
|---|---|
| 总提交 | 61（T-01 ~ T-67b，任务制提交，message 可追溯） |
| 产品代码 | `packages/` 8 包共 6,564 行（不含测试） |
| vendored 代码 | `vendor/playwright-injected/1.62.1/` 13 文件 5,908 行（与上游 md5 逐字节一致） |
| 测试 | 132 单测（vitest）+ 33 个 e2e spec（Playwright，49 通过/3 计划内 skip） |
| 分支 | `v2.0-entry-architecture`（main 停在 v1.x 交付态） |

### 产品一句话（按代码而非 README）

把"用户已登录的真实浏览器里的手动操作"录成可确定性回放的 YAML 技能；认证边界上只做探测/复用/借用而**绝不代登录**；定位引擎已从自研 120 行决策树升级为 Playwright Codegen 同源算法（vendor）+ LLM 消歧兜底。

### 三个发展阶段的实际演进

1. **v1.x（T-01~T-55）**：Mock 验收体系。录制→分析→回放全链路，Element 语义定位器，S1-S2 安全场景。
2. **v2.0（T-61~T-62）**：Entry 认证载体架构。C16-C23 八条新约束（技能不含登录、凭证拒绝、bearer 分流、身份校验、anchor 重入），Keycloak 真实环境 C18 实测。
3. **定位引擎通用化（T-63~T-67）**：vendor Playwright selectorGenerator、playwright 定位契约、录制期 LLM 消歧。这是最近的主体工作，也是本文档重点。

---

## 二、各阶段攻克了什么（按实证）

### 2.1 录制→分析→回放流水线（v1.x）

- **双时间戳动作关联**（T-29）：只用 `requestTs` 归属动作，慢响应不错位（有反例测试）。
- **依赖陷阱识别**（T-30）：`approverId + approvalToken` 跨请求依赖，录制 workday 回放 weekend 仍成功（e2e 反例验证非硬编码）。
- **写操作安全语义**（T-39/T-52）：`fetchStarted` 标志位机械分类 outcome；`drop_response` 三场景（无 postcondition 中止/有则收敛/提交前失败降级）submissions 全部 == 1。
- **全链路脱敏**（T-02/T-41）：结构化 fingerprint（同会话同值同指纹，跨编码格式一致），诊断包零明文凭证（CI grep 检查 `npm run check:constraints`）。

### 2.2 Entry 认证载体（v2.0，T-61/62 五项验收全过）

- **C16/C17 零凭证边界**：`packages/browser` 无一处 `.fill()` 登录动作；`assertNoPlainCredentials` 在 Schema 层拒绝 `grant_type=password`（§0.3 事故的直接防线）。
- **C18 会话分流实测**：Keycloak 管理台实测 `sessionType=bearer`、`bearerSource=cdp-inherit`（token 仅存 keycloak-js 内存闭包，storage/global 不可达），CDP 借用 Bearer 头调 Admin API 200。
- **T-59 六重入场景**：会话过期恢复/写步骤 postcondition 收敛/身份变更中止（IDENTITY_CHANGED）/超 maxReentries abort，submissions 全部 1。
- **Mock 双会话拓扑**：portalUser（持久）与 user（子系统）分离，`_debug/expire` 用 `regenerate` 只清子系统——旧实现 destroy 会连门户登出，无法表达真实内网拓扑。

### 2.3 定位引擎通用化（T-63~T-67，最新主体）

这是本交接文档的核心，过程含三次重要的**自我纠错**（见第四节），最终态：

```
录制点击 → pw-selector-generator（vendor 算法，noCSSId:true）
  ├─ 文案全局唯一 → internal:role=button[name="x"i]  [HIGH]（主路径）
  ├─ 文案撞车     → ... >> nth=N 兜底               [LOW]
  │     └─ onDisambiguation 回调（T-67b）
  │          └─ LLM 局部上下文提案 → Playwright 再验证
  │               （count==1 且命中===用户点击的原元素，标记法 oracle）
  │               ├─ 通过 → section:has-text(...) >> internal:role=... [HIGH]
  │               └─ 拒绝 → 保持 LOW（回放期 heal 兜底）
  └─ {strategy:'playwright', selector, confidence} 契约 → record.json → skill
回放 → channel-ui: page.locator(selector) 原生引擎解析执行
```

**六场景 no-id 实测**（T-66 修正 harness 后，产物原文）：

| 场景 | 产物 | 置信度 |
|---|---|---|
| A 全局唯一文案 | `internal:role=button[name="搜索A"i]` | HIGH |
| B 10 区域同名（heading 撞车） | `section:nth-child(8) > ._btn_9k2ld` | LOW（结构链） |
| C 双同构 form | `internal:role=button[name="搜索C"i] >> nth=1` | LOW |
| D 客户/订单管理 section | `internal:role=button[name="搜索D"i] >> nth=1` | LOW |
| E 真 rebuild 3 轮 | `internal:role=button[name="提交E"i]` | **HIGH，hash/data-v 全变仍稳定** |
| F 同文本不同 type | 两按钮均 role+name >> nth | LOW（可区分但带 nth） |

**结构链脆弱性（精确验证）**：前插 section 失效 / 后插恢复 / 内部包 div 失效——位置依赖 selector 的真实风险边界。

---

## 三、攻克过程中的关键决策（为什么这么做）

| 决策 | 备选 | 选择理由（实证） |
|---|---|---|
| vendor Playwright 算法而非继续自研 | 自研 sibling scoring | 审计确认自研 120 行单路径无消歧；vendor 与 `getByRole` 同源同引擎，md5 一致可验证 |
| `noCSSId: true` | 过滤特定 id 模式 | 实测组件库动态 id（`el-btn-gi5e33`）被 id 优先档采用且判 HIGH，渲染即断；宁弃稳定手写 id（内网罕见） |
| nth/nth-child 双降 LOW | 沿用 vendor 分数 | vendor 分数体系不区分位置依赖；降级保证 LOW 才进 LLM 消歧 |
| 录制期消歧而非仅回放期 heal | 回放期才处理 | 录制时有天然 oracle（用户点击的原元素）；T-66 后 HIGH 是主路径，LOW 才调 LLM，成本可控 |
| P0 修复走 Node 侧 `getByRole` | 修 IIFE resolver | implicit ARIA role 语义 Playwright 原生正确；IIFE 只保留 Element 特化策略 |
| Mock 双 session 拓扑 | 保持单 session | 单 session 下 `_debug/expire` 连门户一起登出，T-59 场景无法表达真实内网 |

---

## 四、写法方面的问题（诚实清单，接手者必读）

### 4.1 已发生并修复的（保留教训）

| # | 问题 | 教训 |
|---|---|---|
| 1 | **闭包 addInitScript 变量不序列化**（T-67a 发现）：`addInitScript(() => set(window.X, engine))` 里 `engine` 恒 undefined——feature flag 从未生效过，此前的"playwright 引擎"e2e 实际全走手动注入路径 | 必须用参数形式 `addInitScript((flag) => ..., engine)`。**任何 PW initScript 传变量都要检查这条** |
| 2 | **测试桩送分**（T-65 发现）：手写静态 id 让 A/E/F 拿到虚假 HIGH；E 场景"rebuild 通过"是循环论证（selector 是 id，从未触达 class hash） | 测试桩必须贴近真实形态：动态 id、hash class、data-v |
| 3 | **harness 配置 bug 伪装成算法缺陷**（T-66 发现）：桩对 `internal:*` 引擎 `return []` 等价于 `omitInternalEngines`，文案锚点候选全被误杀，得出"0 HIGH/6 LOW、LLM 必须是主路径"的错误架构结论 | 下架构结论前必须做独立信源对照（官方 codegen/getByRole） |
| 4 | **生成器/解析器不对称**（P0）：generator 对无 role 属性的原生 button 产 `role:'button'`，IIFE resolver 只查显式 `[role=...]`——纯 `<button>` 回放必炸，Mock 恰好显式写 role 掩盖了它 | 生成与解析必须同引擎（现均走 Playwright 语义） |
| 5 | **probeSession 忽略 jsonPath 布尔**：`$.loggedIn:false` 被当会话有效，会话过期完全检测不到 | 配置了 jsonPath 就必须按布尔判定（已修，entry.ts:116-120） |
| 6 | **express-session 赋 undefined 不触发 save**：`_debug/expire` 用赋值法静默失效 | 用 `regenerate` 重建（已修） |
| 7 | **诊断包双层转义逃逸**：`StepResult.raw.text` 内嵌 JSON 的 `\"access_token\":\"...\"` 逃过 sanitizeText | sanitize 递归展开内嵌 JSON（三层嵌套回归用例） |
| 8 | **依赖识别弱值假阳性**：布尔/空串与 281KB serverinfo 响应匹配出上万假依赖 | 按 DEPENDENCY 常量的五序弱值过滤（fingerprint 豁免） |

### 4.2 仍存在的写法问题（已知未修，接手者评估）

| # | 位置 | 问题 | 影响 | 建议 |
|---|---|---|---|---|
| 1 | `pw-selector-generator.ts:83-86` | `internal:attr`/`internal:label` 引擎未接桩，`return []` | **有 placeholder/label 的输入控件候选被误杀**，退化 nth——真实系统输入框普遍有 placeholder，这是当前最大的桩缺口 | 参照 roleEngine 方式 vendor `attrSelectorEngine`/`labelSelectorEngine` 或在桩内实现 |
| 2 | `analyzer/params.ts:97`、`cli/diff.ts:146` | 硬编码中文 label→参数名映射（加班类型→type） | 新系统草稿参数名用中文 label，能跑但质量下降 | fallback `label\|\|type` 已可用，删除映射表即可 |
| 3 | `browser/probe-session.ts:88` | `window.keycloak.token` 特化探测 | 死代码（实测 admin console 不暴露该实例）且违反通用层 | 删除或移到 entry 配置层 |
| 4 | `replayer/src/test-entry.ts` | 测试工厂放在 src/ 非 .test.ts | 构建产物含测试桩 | 移到各测试文件 |
| 5 | `analyzer/draft.ts:249,255` | postcondition 推断硬编码 `/history\|list/` 与 reason/startTime 字段名 | Mock 样本塑形核心 | 改为取首个 string/datetime 必填参数或留 TODO |
| 6 | `llm/disambiguate.ts:126-131` | verify 的 role 类型 cast（`as 'button'`） | 类型不安全 | 收窄 role 枚举 |
| 7 | **本机环境**：`node_modules/@dsh/*` Windows junction 损坏（`lstat UNKNOWN -4094`，管理员权限也无法穿透） | 用 shim package（main 相对路径指 dist）+ vitest 别名 + `tmp/dsh-loader.mjs` ESM loader 三层旁路 | `npm run build` 中 cli 包类型检查报 `Cannot find module '@dsh/llm'`（仅类型，运行时正常）；**换机器可能不复现**，先 `node -e "fs.readdirSync('node_modules/@dsh/core')"` 验证 | 若正常可直接删 shim 恢复 npm workspace junction |

### 4.3 架构层面的遗留判断（不是 bug，是边界认知）

- **vendor 的 parent 递归只产 css 结构链**（selectorGenerator.ts:414-435 源码确认），heading 文本不进候选——B/D 类场景（同名+区域区分）**结构性依赖 LLM 消歧**，这是算法固有不是 bug。
- **LLM 消歧是"文案撞车场景的补充"而非主路径**（T-66 定案），但 B 类（heading 区分）场景它现在是唯一出路。
- **Shadow DOM / iframe 不支持**（recorder-probe 用 event.target 非 composedPath；exposeBinding 只绑主 frame）——明确 TODO，勿顺手实现导致范围膨胀。

---

## 五、给 Codex 的后续开发清单（按优先级）

### P0（接手第一件事）

1. **补 `internal:attr`/`internal:label` 引擎桩**（4.2#1）——真实系统输入控件普遍有 placeholder，当前会全面退化 nth。参照 `internal:role` 的接法：从上游 vendor 对应 selectorEngine 文件（保持 md5 一致原则），在 `queryAllParts` 增加分支。
2. **验证本机 junction 状态**（4.2#7）——若正常，删 shim 恢复标准 workspace 结构，`npm run build` 应零错误。

### P1（cutover 前置）

3. **Legacy generator 对照回归**：`DSH_LOCATOR_ENGINE=playwright` 下完整跑一遍 `e2e/record.spec.ts` 级别的真实流程录制（加班表单全流程），对照 legacy 产物的技能可回放性。通过后把默认值切到 playwright（`recorder/session.ts:178`）。**cutover 前保留 legacy 至少一个版本周期。**
4. **playwright 契约的 fill 支持**：`channel-ui.ts` 目前只有 click 走 `page.locator(selector)`；fill/setDateTime 动作的 playwright 策略分支未接（录制输入框会产出 playwright target 但回放走不到）。
5. **B 类场景消歧实测**：用真实 LLM（DeepSeek）跑 `--disambiguate` 录制双同名按钮，验证提案质量与拒绝率（目前只有 mock 验证）。

### P2（质量清偿）

6. 清理 4.2#2-#6 的样本渗透与写法问题。
7. `disambiguation-context.ts` 的 sibling/ancestor 收集目前只为 button/a 优化，输入控件场景需扩展。
8. e2e 里 `process.env.DSH_LOCATOR_ENGINE = 'playwright'` 的测试与 legacy 测试存在 worker 级 env 污染风险（PW worker 复用进程），考虑改用 `test.use({ env })` 或拆文件隔离。

### 禁止事项（架构红线，违反即回退）

- 不得为让 network 通道可用而深入任何认证系统（C17/C18 边界，Keycloak 实验已划界）
- 不得在录制/回放链路引入自动填写凭证
- vendor 目录禁止修改上游算法（md5 校验，升级流程见 `vendor/playwright-injected/1.62.1/README.md`）
- LLM 输入禁止 page.content()/整页 DOM（只允许 `__DSH_DISAMBIG__`/`__DSH_SNAPSHOT__` 局部上下文）
- LLM 消歧产物必须过 Playwright 再验证（count==1 + 原元素 oracle），拒绝静默接受

---

## 六、验收与运行速查

```bash
npm test                    # 132 单测（vitest，含 @dsh/* 别名）
npx playwright test         # 全量 e2e（自动拉起 Mock 前后端 webServer）
npm run check:constraints   # C16/C17/C2/C11 grep 检查（CI 用）
node scripts/a3-loop.mjs    # rebuild 5 轮回放验收（核心 Demo 项）

# 定位引擎对比
DSH_LOCATOR_ENGINE=playwright npx playwright test e2e/locator-poc-no-id.spec.ts
npx playwright test e2e/disambiguation-poc.spec.ts    # LLM 消歧 oracle 验证
npx playwright test e2e/playwright-contract.spec.ts   # 契约闭环

# Keycloak（C18 回归靶）
KC_USER=... KC_PASS=... node scripts/dev-only/seed-keycloak-profile.mjs
node scripts/dev-only/probe-keycloak-session.mjs
```

---

## 七、时间线（commit 可追溯）

| 阶段 | 提交区间 | 内容 |
|---|---|---|
| v1.0 骨架+Mock | `6b88e63..944e8b9`（T-01~T-10） | monorepo、契约冻结、Mock OA 含依赖陷阱 |
| v1.x 定位器+载体 | `00317af..95a4f0d`（T-11~T-22） | Element IIFE 定位器、auth 四态、doctor |
| v1.x 录制→回放 | `0ffd743..3814e6a`（T-23~T-42） | 双时间戳录制、依赖识别、安全降级链、诊断包 |
| v1.x LLM+验收 | `f16f802..0be6366`（T-43~T-55） | 路由/标注/自愈、A1-A12 验收、文档 |
| 外场实测 | `5f9a795` | Keycloak 实测抓出 4 个真 bug（弱值假阳性/点号 key/双层转义/导航竞态） |
| v2.0 Entry 架构 | `60274bc` | C16-C23、ensureEntry、bearer 就地取用、reentry 六场景 |
| v2.0 收尾 | `f43a69a` | 五项验收、e2e 迁移、Keycloak C18 实测定案 |
| 定位引擎 P0 | `a79a28d` | role 不对称修复（implicit ARIA） |
| 定位引擎 POC | `eeef4c1` | vendor selectorGenerator + LLM 消歧 |
| 自我纠错 | `ae0e2b5`→`e2362ef` | no-id 重测证伪 → 对照实验定案 harness bug |
| 契约+集成 | `bf3ebe2`→`e6c6c6a` | playwright 契约正式化 + 录制期消歧闭环 |

---

**文档结束**。接手者请先读 §四（写法问题）和 §五（清单），再读 §二（现状）。有疑问以代码为准，本文件所有结论均可在对应 commit 与测试文件中复现。
