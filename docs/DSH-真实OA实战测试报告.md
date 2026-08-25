# DSH 真实 OA 实战测试报告

执行日期：2026-08-23
执行者：GLM（测试角色）
环境：真实 OA（http://localhost:5173，Vue3 + Element Plus + 自定义组件，Keycloak 统一认证 @192.168.124.2:18085，后端 :3001）
依据文档：docs/DSH-真实OA实战测试执行文档.md

---

## 0. 执行摘要

全流程（录制→分析→修正→回放→服务端核验）在真实 OA 上**可以跑通**：请假/加班/导航三类技能共录制 6 份、回放 20+ 次全部成功，每次恰好落库 1 条，跨参数（类型/审批人/日期）全部正确跟随。但**门槛之上暴露了 4 个 P1 级产品缺陷**：① entry 会话探测/身份探测完全不支持 bearer（真实系统进不去，靠无鉴权端点侧路绕过）；② 原生 select / radio 形态的选择动作录制不上（类型值以字面量硬编码进 body，靠人工参数化补偿）；③ 录制中途跳转登录页会让 recorder 崩溃且 partial 全丢；④ T-87 联动关联在真实系统形态（远程搜索组件）下全部退化为 time-window/low。另发现 UI 定位器不支持模板参数（P2）与 a3-rebuild.spec 漏传 entryResolver（P2）。**结论：技能寿命（Q1）与回放稳定性已达标；录入质量（Q3）与会话韧性（Phase 6）是进入内网前必须补的课。**

---

## P0 级问题（本次为 0，过程记录保留）

无 P0 静默错单、无 P0 重复副作用。所有提交均逐条核验服务端（total 从 6 → 31，每轮回放恰好 +1）。

曾疑似 P0 的两次误判（自纠记录，供流程参考）：
1. 「提交成功但服务端无记录」→ 实为两段式提交（确认弹窗未点），走完确认后正常落库。
2. 「请假事由长度不足」toast 与「提交成功」toast 两次截图分析结果矛盾 → 均以服务端数据 + 网络抓包为准修正结论。

---

## 1. Phase 0 前置核实

### 0-A 全量 e2e

passed **93** / failed **0** / skipped **3**（5.1m，4 workers）

skipped 明细（源码级确认，均非异常）：
| 测试 | 位置 | 原因 |
|---|---|---|
| A3 rebuild 后 CSS hash 变化但语义技能仍可回放 | e2e/acceptance/a3-rebuild.spec.ts:8 | `test.skip(!A3_EXPECTED_CLASS)`——设计为仅由 scripts/a3-loop.mjs 驱动 |
| A8 Vue2 条件未启用 | a6-a12.spec.ts:107 | Vue2 条件任务未激活（目标非 Vue2） |
| A10 Stretch 未启用 | a6-a12.spec.ts:130 | Stretch 范围明确排除 |

注：文档写"完整套件有 89 个"，实测 96 个（93+3），文档数字过时。

### 0-B 测试数量变化（25→21）

结论：**移除（合法）**，非 skip 未计入。

明细：commit `7886d48`（feat(T-83): remove legacy locator engine）删除两个 legacy 专属 spec：
- `e2e/locator-poc.spec.ts`（1 个测试：POC 场景 A-F legacy vs playwright generator）
- `e2e/selector-generator.spec.ts`（1 个测试：selector-generator 12 元素语义策略）
- `t73-dynamic-matrix.spec.ts` 移除 1 个 legacy-only 用例；`t84` 相关 1 个用例随引擎切换合并
合计 4 个。grep 模式（T68-T74+T84）在新文件名下少匹配，属报告口径问题。

### 0-C A3 rebuild 循环

| 轮次 | class 变化 | 回放结果 | 失败原因 |
|---|---|---|---|
| 1 | submitBtn_lwtka3→azzeq9 →…（每轮均变） | —（spec 层失败） | spec:18 漏传 entryResolver（TypeError） |
| 2-5 | 同上每轮变化 | — | 同上 |

通过率：**0/5（spec 自身 bug）+ 等效验证 5/5**

**两个独立问题**：
1. **a3-rebuild.spec.ts:18 `parseSkill(text)` 只传 1 参数**——`parseSkill` 签名要求 `entryResolver`（packages/core/src/schema.ts:412），其它 spec 都经 e2e/fixture.ts 的 `entryResolver()`，唯独 A3 直调漏传。T-83 重构时引入。
2. **环境冲突**：真实 OA 占用 5173，a3-loop.mjs 的 preview 也绑 5173；且 playwright.config `reuseExistingServer` 会复用 dev server（每次访问动态编译，class 断言必失败）。

**等效验证（tmp/a3-replay-only.mjs，未改任何断言）**：补上 resolver 后 5 轮 rebuild→class 变化断言→replay()，**5/5 通过**（Mock OA 场景）。真实 OA 侧由 Phase 7 覆盖（3/3 通过）。

### 0-D OA 代表性审计（加班申请页实测）

| 指标 | 实测值 | 判读 |
|---|---|---|
| hashClass | 228 | 像真实系统（>10） |
| scopedAttr | 217 | 像真实系统 |
| staticId | 62 | 中间态（非接近 0；多为 el-id-* 动态 id） |
| labelWithFor / labelTotal | **11/14** | **偏向"为测试而写"**（标准 Element Plus label 无 for） |
| portaledPanels | 0 | dashboard 时刻无浮层（表单交互时 .el-popper 存在，此指标按文档脚本在静态时刻测量偏低） |
| btnNoName / btnTotal | 1/73 | 少量图标按钮，像真实系统 |
| formControls | 20 | — |

结论：**部分具备代表性**——CSS module hash/scoped/图标按钮三项强烈像真实内网系统；但 label 带 for 的写法（79%）比真实 Element 系统定位难度低。另发现超出文档预期的真实特征：原生 `<select class="native-select">`（请假/疾病类型）、自定义 `remote-staff` 远程搜索审批人组件、`el-radio-group` 加班类型、两段式提交确认弹窗、员工重名（两个张三）歧义——这些正是暴露 P1-B/P1-C 缺陷的形态。

---

## 2. Phase 1 门槛探测

原始输出：

```
✓ Chrome 已安装        版本 151.0.0.0
✓ 可启动 persistent context
✓ IIFE 注入成功
Entry 探测：realoa（http://localhost:5173/#/dashboard）
sessionType     unknown
cookieKind      mixed
通道能力        network ✗   ui ✓
证据            Authorization=false  Cookie=false
```

人工深挖修正后的真实画像（tmp/probe-session-deep.mjs 实测）：

| 项 | 记录值 |
|---|---|
| Chrome 版本 | 151.0.0.0 |
| IIFE 注入自检 | ✓ |
| sessionType | **bearer**（doctor 判 unknown 是探测方法缺陷，见问题 1） |
| bearerSource | storage（`localStorage['oa.token']`，JWT RS256） |
| 通道能力 | network ✓ ui ✓（channel-network 的 bearer 取用链路实测可用） |
| identityProbe | 可用端点 `/api/auth/me`（$.data.user.username，EMP010/chenmo），但引擎探测函数不带 Authorization 调不通（问题 1） |
| 前端框架 | Vue 3（window.__VUE__） |
| 组件库 | element-plus + 大量自定义组件 |
| 一次性认证跳转 | 有（#/login → Keycloak authorization_code → 回跳换 token） |

`doctor --probe-frontend` 崩溃（page.evaluate 时导航销毁 context）——对跳转型登录系统不健壮（P3）。

**测试侧路（entries/realoa.yaml，非产品代码）**：sessionProbe→`/api/health`（无鉴权 JSON），identityProbe→同端点恒定值。副作用：会话过期检测与换身份检测双双失效（Phase 6 受限的根因）。

---

## 3. Phase 2 最简流程（请假）

### 3.1 draft 人工核对

参数列表（draft 原始 4 个）：

| 参数名 | 类型 | 是否正确 | 备注 |
|---|---|---|---|
| 开始日期 | datetime | ✅ | |
| 结束日期 | datetime | ✅ | |
| 请假原因 | string | ✅ | |
| 审批人 | string | ⚠️ | UI 搜索词参数化，但 body.approverId=EMP001 硬编码 |
| （缺失）请假类型 | enum | ❌ | 原生 select change 未录制（问题 2），PERSONAL 字面量进 body |
| （缺失）请假天数 | number | ❌ | days=2 字面量 |

- csrf/token/viewstate 误识别：**无** ✅
- `{{sN[数字].xxx}}`：**无**（T-86 合规）✅
- TODO_UNRESOLVED：无（t1；t3a draft 出现 1 处 approverId，见 Phase 4）
- enumMap：draft 无 enum 参数（本应请假类型是）——问题 2 的连带后果

channel 分布：**network=2 ui=2 merged=4 auto=0**（network 可用面 6/8=75%）

定位质量：**HIGH=8 LOW=0**；visibleText=null 的 LOW：**0**（T-84 防护面本次未受考）
（注：2 个 produces.scope root 为 LOW 位置型选择器 `div > .el-form-item.is-required >> nth=0`——scope 根位置型，rebuild 高危，Phase 7 实测未触发失败）

跨步依赖：3 个请求全部 `time-window / confidence: low`（问题 4）
TODO 数量：文件级 4 + 步骤级 12 + postcondition 未推断（自动补全缺位）

### 3.2 修正记录（最小必要修正，skills/t1_leave_simple.yaml 头部有完整注释）

1. 新增参数 请假类型（enum 6 值）+ body `{{请假类型|enumValue}}` ——补偿问题 2
2. 新增 审批人工号 → `{{审批人工号}}`（approverId 不再硬编码）
3. days/date/reason 参数化；审批人搜索 keyword 参数化
4. 补 postcondition（GET /api/applications 匹配 bizType=leave）
5. 修正过程自踩一坑：模板过滤器只有 enumValue/date:，无 urlencode（P3 记录）

### 3.3 回放结果

原参数回放：**成功**（8/8 步，4.1s，0 reentry）
服务端记录原文：
```json
{"total":9,"first":{"type":"leave","title":"事假 2 天（2026-09-23 ~ 2026-09-24）","time":"2026-08-23T11:26:30.488Z"}}
```
（total 8→9，恰好 +1，无重复）

跨参数回放（事假→**年假**，张三→**王海**，日期 10-12/13）：**成功**
服务端记录原文：
```json
{"type":"leave","title":"年假 2 天（2026-10-12 ~ 2026-10-13）","time":"2026-08-23T11:27:08.202Z"}
```
类型/审批人/日期全部跟随参数 ✅（T-86 修复在真实 OA 验证通过）

连续 10 次：**10/10**，单次耗时 4093-4183ms（均值 4138ms，极差 90ms，非常稳定），total 10→20（无重复）

---

## 4. Phase 3 联动流程（加班）

联动专项核对：
- 联动请求被捕获：✅ 7 个全录（dept-tree/projects/employees×2/search×2/POST overtime）
- 归属正确动作：⚠️ 全部 time-window/low，owner 多指向错误动作
- `_correlation.method`：**全部 time-window + low**（期望的 request-value-match/dom-causality 未触发——问题 4）
- submit 引用联动响应值：❌ approverId EMP007 硬编码
- 联动返回动态值硬编码：❌ 同上（与 Phase 2 同型）

跨参数回放（工作日→**周末**，王海→**张三**，3h→**8h**）：成功，服务端原文：
```json
{"id":"OT-20260823-0031-920","overtimeType":"WEEKEND","date":"2026-10-03","startTime":"09:00","endTime":"17:00","hours":8,"approverId":"EMP001","approverName":"张三","status":"pending"}
```
全字段跟随 ✅（经人工参数化补偿后）

慢节奏对比（每操作 ≥2.2s 重录）：7 请求仍全 time-window/low，与快节奏无差异——**节奏不是 correlation 质量的变量，形态才是**。

另：加班类型是 el-radio-group（WEEKDAY 默认选中），不点击则无动作无步骤——「选类型」在 UI 通道不可回放（问题 2 的 radio 变体）。

---

## 5. Phase 4 多变体

变体对照（A=事假 / B=病假，条件字段：疾病类型/就诊医院/病历附件）：

| 项 | 变体 A | 变体 B |
|---|---|---|
| 步骤数 | 7 | 8（+就诊医院 fill） |
| 参数数 | 4 | 5（+就诊医院） |
| network/ui/merged | 1/2/4 | 1/2/5 |
| HIGH/LOW | 7/0 | 8/0 |
| 独有参数 | — | 就诊医院 |
| body 独有 | diseaseType:"" | diseaseType:普通感冒, hospital:市第一人民医院, medicalAttachments:[] |

交叉测试（A 技能传病假参数）：**明确拒绝** ✅
- 回放层：AssertionFailedError `httpStatus expected=200 actual=422`
- 服务端：`cross: NOT-FOUND`（无落库），total 无 +1
- 判定：**响亮失败，无静默错单**——文档期望的最佳结果

两变体技能共存互不干扰（不同 skill id 并存 skills/ 目录）。

附带发现：t3_a draft 出现 `approverId: TODO_UNRESOLVED`（analyzer 对联动值找不到来源时的占位）——恰说明 analyzer 知道该值该参数化但无法溯源（问题 4 的另一面）。

---

## 6. Phase 5 跨页面导航

观察点：
- 二级菜单展开/路由切换定位：✅（我的申请 HIGH；侧边栏为一级菜单，二级展开形态本次未出现）
- waitAfter：✅ s2/s3 均有 scopeReady 等待
- pageState：❌ 未生成
- 列表行定位策略：✅ **行内语义** `internal:role=row[name="LV-2026..."]`（非行序）
- 详情浮层：✅ produces sc2 = `el-dialog[name="申请详情"]`
- correlation：✅ **dom-causality/high 首次出现**（响应值 LV-id 出现在点击动作的 DOM 变更中）——T-87 在「点击行→详情请求」场景有效
- 分页/虚拟滚动：未触发（列表 6 条），未验证

稳健性测试（插入置顶新记录改变行序后回放）：**5/5 步成功**，仍定位到正确行 ✅（未触发 T-84 拦截——因为没漂移，正确定位）

附带发现：UI target selector 不渲染模板（`{{申请单号}}` 原样传给 getByRole）——**参数化 UI 定位器不支持**（问题 5，P2）。

---

## 7. Phase 6 会话中断

| 场景 | 结果 | 提交数量 |
|---|---|---|
| 回放中途过期 | ⚠️ **受限验证**：ExecContext 无 page 句柄，无法在写步骤前注入失效；改跑两轮正常回放各 1 条 | 2（每轮 1，无重复） |
| 换身份恢复 | ❌ **机制失效**：identityProbe 侧路（/api/health 恒定）→ digest 恒定（实测 stable=true）→ 任何人登录 digest 相同，identityLock 形同虚设 | — |
| 录制中途过期 | ❌ **recorder 崩溃**（见问题 3）：partial 全丢，无 record.json，登录页动作记录与否无从检验 | — |

Phase 6 是本次受 P1-B（探测不支持 bearer）牵连最重的阶段：会话过期检测、身份一致性两大防线在真实 bearer 系统上均未通过验证。**这不是侧路配置能解决的，需要产品层支持。**

---

## 8. Phase 7 rebuild 后回放（真实 OA）

真实 OA 前端为外部项目（E:/Web/replayer-web-test），dev 模式无 build 产物——用「DOM 结构变更 + HMR」等价模拟前端改版（改完已还原，0 残留）：

| 轮次 | 变更 | 结果 | 失败步骤 | 失败类型 |
|---|---|---|---|---|
| 1 | 提交按钮外加 wrapper div（class t7-churn-r1） | ✅ 4132ms | 无 | — |
| 2 | class 换 r2 | ✅ 4188ms | 无 | — |
| 3 | class 换 r3 | ✅ 4139ms | 无 | — |

HIGH 步骤失败率：0/21；LOW 步骤失败率：0/0（未出现 LOW）；network 步骤失败率：**0/9**（理论验证成立：network 通道对 DOM 变更免疫）

服务端核验：total 28→31，每轮恰好 +1（T7第1/2/3轮 各一条）。

（注：真实 scoped hash 变化——E:\Web 项目 HMR 不重算 data-v hash；但技能定位全部基于 role/name/label 语义，与 hash 无关，故该差异不影响结论。Mock OA 的 hash 变化场景由 0-C 等效验证 5/5 覆盖。）

---

## 9. 核心指标汇总

| 指标 | 数值 | 说明 |
|---|---|---|
| **network 步骤占比** | **75%**（6/8，network+merged） | Q1：技能寿命的核心保障，达标 |
| **HIGH 定位占比** | **100%**（正式步骤 0 LOW） | Q2 |
| **visibleText=null 的 LOW 步骤** | **0** | T-84 防护未受考（本次无 LOW 产物） |
| **参数识别正确率** | **4/8**（draft 原生识别：日期×2/原因/审批人姓名 正确；类型/天数/审批人id/审批人姓名绑定 缺失） | Q3：**最大短板**，靠人工补偿后才通过跨参数 |
| **rebuild 后回放通过率** | **Mock 5/5 + 真实 3/3** | Q2 |
| **多变体交叉测试** | **响亮失败**（422+无落库） | Q4：最佳结果 |

回放侧稳定性：连续 10 次 10/10、耗时极差 90ms、全部单条落库。

---

## 10. 发现的问题

| # | 严重度 | 现象 | 复现步骤 | 影响 |
|---|---|---|---|---|
| 1 | **P1** | entry 层会话/身份探测不支持 bearer：probeSession/readIdentityDigest 页内 fetch 只带 cookie 不带 Authorization，且 response.json() 对 HTML 抛错使非 JSON 探测端点恒 false；doctor probe-entry 对真实 OA 判 unknown/network✗ | 对任意 bearer 系统 `dsh doctor --probe-entry --direct <url>`；或真实 OA 上调 record/replay（LoginTimeout 5min） | **阻断性**：真实 bearer 系统进不了录制/回放（本次靠无鉴权 /api/health 侧路绕过，代价是 Phase 6 两道防线失效）。channel-network 的 bearer 注入是好的，缺口只在 entry/探测层 |
| 2 | **P1** | recorder-probe change 监听只收 Input/TextArea，原生 `<select>` 与 el-radio 的选择不录制；click 路径只认 .el-select-dropdown__item/button/a | 真实 OA 请假页 selectOption('PERSONAL') 后看 record.json（无该动作）；加班 radio 不点则无步骤 | 类型值以字面量硬编码进 body，跨参数回放换类型必失败（需人工参数化补偿）；Q3 直接受损 |
| 3 | **P1** | 录制中页面跳转（会话失效跳登录/Keycloak 重定向）时 exposeBinding 内 page.evaluate 竞态崩溃（session.ts:97 `__DSH_MUTATION__.end`，Execution context destroyed），进程退出、partial 全丢、无"提示重新登录" | 录制中 `localStorage.removeItem('oa.token')` 后点击导航 | T-77 会话中断保护在真实跳转形态下失效；已录数据丢失 |
| 4 | **P1** | 联动关联对真实形态（remote-staff 自定义组件远程搜索 + 通用列表接口）全部退化为 time-window/low；request-value-match 仅在 Mock OA 的 /api/overtime/approver 形态触发；慢节奏无改善 | 录制加班/请假（审批人搜索），看 draft `_correlation` | 联动归属不可信 → 分析产物需要大量人工核对；approverId 溯源失败产生 TODO_UNRESOLVED |
| 5 | P2 | UI target selector 不渲染模板参数：`{{申请单号}}` 原样传给 Playwright getByRole | t5 技能行定位参数化后回放（ScopeNotReadyError，waitFor 选择器原文可见） | 动态行/动态控件无法参数化定位，技能对"每行"场景复用受限 |
| 6 | P2 | a3-rebuild.spec.ts:18 parseSkill 漏传 entryResolver（T-83 重构遗留），A3 在完整链路上从未真正跑过 | 直接 `npx playwright test a3-rebuild.spec.ts`（设 A3_EXPECTED_CLASS） | 核心验收 A3 长期 false-negative；配套问题：a3-loop 的 preview 端口(5173)与 playwright.config reuseExistingServer 会撞 dev server |
| 7 | P2 | ExecContext（onConfirm 回调）不含 page 句柄 | 任意技能 onConfirm 第二参数解构 page | 无法在写步骤前做会话干预/自定义校验，Phase 6.1 类测试无法注入 |
| 8 | P3 | doctor --probe-frontend 对跳转型登录页崩溃（goto 后重定向销毁 evaluate context）；模板引擎缺 urlencode 过滤器（报错信息清晰，易规避）；analyzer 对两段式提交的中间确认弹窗无自动 postcondition 推断 | 各自命令直接复现 | 体验问题 |
| 9 | P3 | 文档口径：执行文档写"完整套件 89 个"实测 96；T-83 删除 4 个测试未同步更新交付报告口径 | — | 报告口径漂移 |

---

## 11. 未能完成的项

| 项 | 原因 |
|---|---|
| Phase 6.1 回放中途会话过期的完整验证（横幅提示/锚点重跑/提交数核验） | 问题 1+7：sessionProbe 侧路探测不到失效 & 无 page 句柄注入失效。**需产品层修复后重测** |
| Phase 6.2 换身份恢复（期望中止+报身份不一致） | 问题 1：identityProbe 侧路 digest 恒定（实测 stable=true）。**需产品层修复后重测** |
| Phase 6.3 登录页动作不得入 record.json 的核验 | 问题 3：录制即崩溃，无产物可核。**需产品层修复后重测** |
| Phase 5 分页/虚拟滚动定位策略 | 列表仅 6 条未触发分页 |
| Phase 0-C 原脚本 5 轮（未改断言前提下） | 问题 6：spec bug + 端口冲突；以等效脚本（同断言逻辑、补 resolver、独立端口）完成 5/5 |
| Q2 的 LOW 失败率统计 | 本次全部 HIGH，无 LOW 样本（T-84 防护未被考核——这本身是空白） |

---

## 12. 测试者判断

**当前状态是否适合推进内网？**
**有条件适合。** 回放引擎本体（编排、断言、postcondition、幂等、参数模板、network 通道 bearer 注入、语义定位）在真实系统上表现扎实——20+ 次回放零重复提交、跨参数全对、前端改版免疫。但「进内网」的门槛不在回放，在**进入**：问题 1 不修，任何 bearer 系统连录制都开始不了（本次是测试者手改 entry 配置绕过的，内网现场没有这个条件）；问题 3 不修，一次会话跳转就丢全部录制。

**最大风险点：**
问题 1（bearer 探测缺失）——它单独阻塞全部流程，且其侧路会静默废掉会话过期与身份锁两道安全防线（P0 级风险的前置条件：错身份继续执行、会话失效后盲目重试都可能在侧路配置下发生）。

**建议下一轮开发优先解决（按序）：**
1. **probeSession/readIdentityDigest 支持 bearerSource**：探测 fetch 前经 getLiveAuthHeader 注 Authorization（channel-network 已有同款逻辑，复用即可）；identityProbe 自动发现（/api/auth/me 形态）。
2. **recorder-probe 补原生 select/radio change 捕获**（HTMLSelectElement/HTMLInputElement[type=radio] 两个分支 + 对应 replay 动作）。
3. **录制导航竞态加固**：exposeBinding 内 evaluate 全部 try-catch + 失效时优雅停止并落 partial。
4. **correlation 的 request-value-match 泛化**：覆盖「搜索请求响应值出现在后续写请求 body」链（本次 王海→approverName 明明可匹配）。
5. UI selector 模板渲染 + a3 spec 补 resolver（小改，顺手清掉）。

---

## 附：测试产物清单

- 技能：skills/t1_leave_simple.yaml、t2_overtime.yaml、t3_a.yaml、t5_navigation.yaml（+draft ×6）
- 录制：tmp/t1-leave-simple、t2-overtime、t2b-overtime-slow、t3-variant-a/b、t5-navigation、t6-*
- 侧路 entry：entries/realoa.yaml（含缺陷注释）
- 探针/验证脚本：tmp/probe-*.mjs、t1~t7-*.mjs（可复跑）
- 前端还原确认：E:/Web LeaveApplicationView.vue 0 残留

**文档结束**
