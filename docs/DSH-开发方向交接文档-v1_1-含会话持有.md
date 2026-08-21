# DSH Recorder · 定位引擎、交互状态与会话持有 · 开发方向交接文档

> 版本：1.1 ｜ 日期：2026-08-20
> 交接背景：前一执行模型（GLM）完成 T-63 ~ T-67，本文档交接给 GPT 继续。
> 上游规格：《DSH Recorder 开发执行规格 v2.0 完整版》（约束 C1–C23、契约、任务体系仍然有效）
>
> **v1.1 相对 v1.0 新增第五部分「会话持有」**，回答一个被忽略的基础问题：
> 录制时每次新起浏览器，那个浏览器里到底还有没有登录态？
>
> **本文档解决三件事**：
> 1. 前序工作哪些可信、哪些必须重新验证
> 2. 真实业务流程里的元素，很多在录制那一刻根本不存在
> 3. 会话到底存在哪里、什么情况下会消失、系统该怎么应对

---

# 第一部分 · 给 GPT 的第一件事

## 1.1 不要接着往前跑，先做信任审计

前序执行中发现一个埋藏缺陷：

> `addInitScript` 使用闭包捕获外层变量时**实测不序列化**，导致 `__DSH_LOCATOR_ENGINE__` 旗帜**从未真正注入过**。此前所有"playwright 引擎"的 e2e 产物，实际来自手动注入的旁路。

这句话的含义比它被记录的位置（"附带修复"）严重得多：

**T-63 / T-65 / T-66 的全部实测数据，跑的可能不是正式链路。** 而 T-65 得出的「六场景 0 HIGH / 6 LOW」这一结论，正是在这条从未生效的旗帜下测出来的，并据此把「LLM 消歧」从边缘补充上升为主路径——**一个影响整体成本模型的架构决策，建立在来源可疑的数据上**。

这也可能解释 T-65 中最反常的现象：A 场景按钮文本全页唯一，却退化到 `button >> nth=3`。Playwright 的设计排序是 role/label/placeholder/text 优先，唯一文本跌到 nth 不符合预期，更像是 options 传递不一致（例如 `omitInternalEngines` 被开启）导致内部引擎档位整体缺席。

### 必须先完成的审计项

| # | 审计项 | 判定 |
|---|---|---|
| A1 | T-66 定案（"文案唯一 → role+name 是主路径"）是在旗帜修复**前**还是**后**跑的 | 若在前，作废重跑 |
| A2 | T-65 六场景在正式链路下重跑 | 输出新的 HIGH/LOW 比例，与旧结论对比 |
| A3 | 打印调用 `generateSelector` 时传入的**完整 options 对象** | 确认 `omitInternalEngines`、`noCSSId`、`testIdAttributeName` 实际值 |
| A4 | `npx playwright codegen` 对同一 fixture 录一遍，贴 Inspector 原始产物 | 官方产物 vs 你们产物逐场景对照 |
| A5 | 全代码库搜索其他 `addInitScript` 闭包捕获外层变量的地方 | 同类缺陷可能不止一处 |

### 机械防护（本次必须加）

```ts
// packages/browser/src/context.ts —— launchDSHContext 内，注入后立即自检
const injected = await page.evaluate(() => ({
  locator:  typeof (window as any).__DSH_LOCATOR__,
  snapshot: typeof (window as any).__DSH_SNAPSHOT__,
  gen:      typeof (window as any).__DSH_GEN__,
  engine:   (window as any).__DSH_LOCATOR_ENGINE__,
}));
const missing = Object.entries(injected).filter(([, v]) => v === 'undefined' || v === undefined);
if (missing.length) {
  throw new Error(`[注入自检失败] ${JSON.stringify(injected)} — 缺失: ${missing.map(m => m[0]).join(',')}`);
}
```

**任何注入项缺失即抛错，禁止静默降级到"看起来能跑"的旁路。**

## 1.2 前序工作的可信度分级

| 结论/产物 | 状态 | 说明 |
|---|---|---|
| `{strategy:'playwright', selector, confidence}` 契约 | ✅ **可信，保留** | 走 `page.locator()` 原生解析是对的；`internal:role=...` 本就不是浏览器能懂的语法，此前伪装成 css 走 `querySelector` 能跑纯属侥幸 |
| 消歧 oracle 验证（count==1 且命中原元素） | ✅ **可信，保留** | 整个方案最有价值的部分，防住了"静默选中错误元素"这个最危险的失败模式 |
| 消歧负例测试（故意给错 scope 被拒绝） | ✅ **可信，保留** | 同上 |
| 动态 id 送分问题（`noCSSId`） | ✅ **可信** | `#el-btn-gi5e33-0` 被判 HIGH 确实是缺陷 |
| `nth-child` 结构链脆弱性实测 | ✅ **可信** | DOM 事实，与注入路径无关 |
| **Mock 的 session cookie 缺 maxAge** | ⚠️ **修复方式有问题** | 见第五部分 5.2——那不是 Mock 的 bug，是真实企业系统的常见配置，加 maxAge 让测试过了，但掩盖了真问题 |
| 「六场景 0 HIGH / 6 LOW」 | ⚠️ **存疑** | 待 A2 重跑 |
| 「LLM 消歧是主路径」 | ⚠️ **存疑** | 建立在上一行之上 |
| 「vendor 不会退到文案锚点，算法固有」 | ⚠️ **存疑** | 待 A3/A4 定案 |
| 「legacy generator 已被全面超越」 | ❌ **不成立** | 对比只在 button 上做过，见第三部分 |
| `onDisambiguation` 录制期集成 | ⚠️ **有竞态风险** | 见 1.3 |

## 1.3 一个必须确认的竞态

`onDisambiguation` 是异步回调，验证时依赖 `__dsh_last_clicked__` 作为 oracle。

**问题**：这个名字暗示它是单一全局变量。若用户点了 A、LLM 还在往返、用户又点了 B，则 oracle 已指向 B——**A 的消歧提案会被拿去和 B 比对**，验证通过但产出错误 selector，全程静默。

**要求**：改为按动作序号索引（`__dsh_clicked__[actionIdx]`），并补测试：连续快速点击两个 LOW 元素，验证两次消歧各自比对的是各自的原元素。

---

# 第二部分 · 核心问题重定义

## 2.1 此前的问题定义是不完整的

前序全部工作围绕一个假设：

> **给定页面上一个元素，生成一个能稳定重新找到它的 selector。**

六个测试场景全是静态页面上的按钮。但真实 OA 业务流程不是这样的：

```
点「考勤管理」菜单
  → 二级菜单展开（这些菜单项在点击前不存在）
点「加班申请」
  → SPA 路由切换，整页 DOM 替换
点「加班类型」下拉框
  → 选项面板挂到 body 末尾（点击前不存在）
选「工作日加班」
  → 触发联动请求，「审批人」字段被填充
  → 若选「节假日加班」，还会额外出现「调休说明」字段（点击前不存在）
点「添加明细」
  → 表格新增一行（点击前不存在）
在新行里填时长
  → 该行的输入框（点击前不存在）
点「提交」
  → 弹确认框（点击前不存在）
点确认框里的「确定」
  → 该按钮在页面上有 3 个同名兄弟，但只有弹窗里那个有效
```

**这条流程里，至少 6 个目标元素在录制该步骤之前根本不在 DOM 里。**

对这些元素而言，"生成一个全页唯一的 selector"这个命题本身就是错的——它们的唯一性**依赖于前置动作已经执行**。

## 2.2 正确的问题定义

> **给定一个交互序列，为序列中每一步生成：**
> **① 执行前必须满足的状态条件**
> **② 在该状态下唯一的定位描述**
> **③ 执行后应等待出现的新状态**

定位从「元素 → selector」变成「(状态, 元素) → (前置, scope, selector, 后置)」。

## 2.3 这个重定义顺带解决了消歧问题的大半

前序发现的 B/C/D 三个场景（同名控件无法区分，退化到 nth，需要 LLM 消歧），有相当比例其实是**作用域问题伪装成的歧义问题**。

举例：确认框里的「确定」按钮，全页有 3 个同名。

- **当前做法**：page-global 生成 → 撞车 → 退化 nth → 调 LLM → LLM 猜出应该 scope 到弹窗
- **应该的做法**：录制时观测到"上一步点击后，`.el-dialog` 这个容器**刚刚出现**" → 自动把 scope 锚定到它 → 在 scope 内「确定」唯一 → **HIGH，零 LLM**

**这个信息在录制那一刻是免费可得的**（MutationObserver），不需要模型推理。

同理：下拉面板 append-to-body、表格新增行、条件渲染字段，全是同一模式。

**预期效果**：真正需要 LLM 消歧的比例会大幅下降到「同一时刻出现的两个同构区块」这种真歧义场景，而不是当前认为的「几乎每次点击」。

---

# 第三部分 · 真实业务形态清单

## 3.1 前序桩的系统性偏差

六个测试场景**全部是 `<button>`**，一个输入控件、一个下拉框、一个弹窗、一次路由切换都没有。

而目标系统是 OA 表单：请假、加班、报销。**这些页面上绝大多数交互元素是输入控件和下拉框，不是按钮。**

所以「legacy generator 已被全面超越」这个裁决**不能成立**——对比只在最不像 OA 表单的那类元素上做过。

## 3.2 必须补齐的场景矩阵

### 组 A · 表单控件（静态存在）

| # | 场景 | 形态 | 期望锚点 | 风险 |
|---|---|---|---|---|
| G1 | 显式 label 关联 | `<label for="x">事由</label><textarea id="x">` | `internal:label=事由` | 低 |
| G2 | 仅 placeholder | `<input placeholder="请输入事由">` | `internal:attr=[placeholder="..."]` | 引擎未接桩，会误杀 |
| **G3** | **Element Plus 表单项** | label 无 `for`，input 无 `id` | ⚠️ **通用引擎大概率失效** | **最高** |
| G4 | 同 label 不同区块 | 「开始时间」出现在两个 section | 需 scope | 中 |
| G5 | 单选/复选组 | `el-radio-group` 内多个选项 | role=radio + name | 中 |

**G3 是本组的关键**：

```html
<div class="el-form-item">
  <label class="el-form-item__label">事由</label>      <!-- 无 for -->
  <div class="el-form-item__content">
    <textarea class="el-textarea__inner"></textarea>   <!-- 无 id -->
  </div>
</div>
```

label 与 control 之间**只有 DOM 邻接关系，没有任何语义关联**。标准 `getByLabel` 匹配不上，这正是当初写 `el-locator.byFormItem` 的原因。

**若 G3 上通用引擎也退化到 nth**，则结论是：通用引擎在 Element 表单结构上存在结构性盲区，`el-locator` 的 `label → form-item → control` 推导逻辑**不能删除**，应作为**补充候选源**接入 pw-generator 的候选池或消歧层。这直接影响 cutover 决策。

### 组 B · 动态出现的元素

| # | 场景 | 触发方式 | 触发前是否存在 | 核心难点 |
|---|---|---|---|---|
| H1 | 下拉选项面板 | 点 `el-select` | ❌ | append-to-body，与触发控件无父子关系 |
| H2 | 级联/远程下拉 | 点开 + 输入关键字 | ❌ | 选项异步加载，需等请求返回 |
| H3 | 日期选择面板 | 点 `el-date-picker` | ❌ | 面板挂 body；通常应绕开面板直接写值 |
| H4 | 确认弹窗 | 点「提交」 | ❌ | 遮罩动画期间点击被吞；按钮名撞车 |
| H5 | 条件渲染字段 | 选择某个下拉值后 | ❌ | 依赖前置选择，可能反复出现/消失 |
| H6 | 表格动态增行 | 点「添加明细」 | ❌ | 每行同构，靠行内数据或行序区分 |
| H7 | 折叠面板 | 点标题展开 | ❌（懒渲染） | 展开前内容不在 DOM |
| H8 | 分步向导 | 点「下一步」 | ❌ | 上一步 DOM 被替换 |
| H9 | 抽屉/侧滑 | 点「详情」 | ❌ | 同弹窗，可能多层叠加 |
| H10 | 虚拟滚动表格 | 滚动 | ❌（视口外不渲染） | 需先滚动/搜索定位 |

### 组 C · 导航与状态切换

| # | 场景 | 难点 |
|---|---|---|
| I1 | 顶部菜单 → 二级展开 → 点叶子项 | 二级菜单点击前不存在；hover 触发 vs click 触发 |
| I2 | SPA 路由切换 | 整页 DOM 替换；URL 变化但无页面加载事件 |
| I3 | 标签页切换（`el-tabs`） | 面板可能懒渲染，也可能全渲染只是隐藏 |
| I4 | 面包屑返回 | 回到的页面状态可能与去时不同（表单已填） |
| I5 | 新开浏览器标签页 | 需要跨 page 上下文 |
| I6 | iframe 嵌套老系统 | 需 frameLocator |

### 组 D · 会话状态（v1.1 新增）

| # | 场景 | 难点 |
|---|---|---|
| J1 | 浏览器关闭后重开，会话是否还在 | 取决于 cookie 类型，见第五部分 |
| J2 | 录制中途会话过期 | 已录部分是否保留？后续如何续录 |
| J3 | 回放中途会话过期 | 已有 T-59 重入引擎处理 |
| J4 | 长时间空闲后会话失效（Idle 超时） | 无声失效，下一个动作才发现 |
| J5 | 多个子系统会话生命周期不同步 | 门户还活着但 OA 已掉 |
| J6 | 用户在另一个浏览器登录导致本会话被踢 | 单点登录常见策略 |

---

# 第四部分 · 定位与状态的架构方向

## 4.1 核心机制：录制期 DOM 变更观测

**优先级高于一切定位器优化。**

在录制时，每个动作前后用 `MutationObserver` 观测 DOM，记录本次动作**新增了哪些子树根节点**。

```ts
// packages/locator/src/mutation-tracker.ts（新增，浏览器侧，零依赖）

interface AppearedRoot {
  node: Element;
  descriptor: LocatorStrategy;      // 该节点的稳定定位描述
  appearedAfterMs: number;
  kind: string;                     // dialog|drawer|listbox|menu|datepicker|table-row|panel|unknown
  portaled: boolean;                // 是否挂在 body 末尾
}

window.__DSH_MUTATION__ = {
  begin(actionIdx: number): void,
  end(actionIdx: number, settleMs?: number): Promise<AppearedRoot[]>,
};
```

**实现要点**：
- 只记录**子树根**，不记录内部所有新增节点（一个弹窗算 1 个 root，不是 200 个）
- 观测窗口在动作后持续 `settleMs`（建议 800ms，可配），覆盖异步渲染
- `kind` 通过 role/类名启发式判定：`role=dialog` / `.el-dialog` / `.el-drawer` → dialog；`role=listbox` / `.el-select-dropdown` → listbox；`.el-picker-panel` → datepicker；`role=menu` / `.el-menu--popup` → menu；`.el-table__row` → table-row
- `portaled`：新增根的父节点是否为 `body` 或其直接子容器

## 4.2 由观测结果推导 scope 与依赖

```
对每个动作 A[i]：
  1. 取 A[i-1] 的 appearedRoots
  2. 若 A[i] 的目标元素在某个 appearedRoot 内部：
       → A[i].scope = A[i-1].produces.scopeId
       → A[i].requires = A[i-1].id
       → selector 在该 scope 内重新生成（而非 page-global）
       → A[i-1] 的 waitAfter 设为「该 root 出现」
  3. 若不在任何 appearedRoot 内 → page-global 生成（现有逻辑）
```

**纯规则，不需要 LLM。**

### 效果示例

原来（撞车）：
```yaml
- id: s6
  desc: 点击确定
  ui:
    target: {strategy: playwright, selector: 'button >> nth=7', confidence: LOW}
    # → 触发 LLM 消歧
```

现在（scope 锚定）：
```yaml
- id: s5
  desc: 点击提交
  ui:
    target: {strategy: playwright, selector: 'internal:role=button[name="提交"i]'}
  produces:
    scopeId: sc2
    root: {strategy: playwright, selector: 'internal:role=dialog[name="确认提交"i]'}
    kind: dialog
    appearedAfterMs: 320
  waitAfter:
    scopeReady: sc2
    settleMs: 200                # 遮罩动画余量

- id: s6
  desc: 点击确定
  requires: [sc2]
  ui:
    scope: sc2                   # ← 在弹窗内定位，不是全页
    target: {strategy: playwright, selector: 'internal:role=button[name="确定"i]', confidence: HIGH}
    # → 零 LLM
```

**回放时**：`page.locator(scopeSelector).locator(targetSelector)`，Playwright 原生支持链式作用域。

## 4.3 契约扩展提案（定位与状态部分）

```ts
export const ProducesSchema = z.object({
  scopeId: z.string(),
  root: LocatorStrategySchema,
  kind: z.enum(['dialog','drawer','listbox','menu','datepicker','table-row','panel','unknown']),
  portaled: z.boolean().default(false),
  appearedAfterMs: z.number().optional(),
});

export const WaitAfterSchema = z.object({
  scopeReady: z.string().optional(),
  urlPattern: z.string().optional(),
  networkIdle: z.boolean().optional(),
  requestUrlPattern: z.string().optional(),
  notEmpty: LocatorStrategySchema.optional(),
  settleMs: z.number().optional(),
  timeoutMs: z.number().default(8000),
});

export const StepSchema = z.object({
  // ... v2.0 原有字段全部保留
  requires: z.array(z.string()).default([]),
  produces: ProducesSchema.optional(),
  waitAfter: WaitAfterSchema.optional(),
  pageState: z.string().optional(),
});

export const UiActionSchema = z.object({
  // ... 原有字段
  scope: z.string().optional(),
});
```

**回放期 scope 解析**：

```ts
function resolveLocator(page: Page, step: Step, ctx: ExecContext): Locator {
  const t = step.ui!.target!;
  if (!step.ui!.scope) return page.locator(toSelector(t));
  const scopeDef = ctx.scopes[step.ui!.scope];
  if (!scopeDef) throw new ScopeNotReadyError(step.ui!.scope);
  return page.locator(toSelector(scopeDef.root)).locator(toSelector(t));
}
```

## 4.4 消歧层的定位调整

```
生成 selector
  ├─ 在 scope 内唯一 → HIGH，零 LLM              ← 新增，预期覆盖大部分动态元素
  ├─ page-global 唯一（role/label/text 锚点） → HIGH，零 LLM
  ├─ 撞车但可用语义祖先区分 → 规则化 scope 提升   ← 新增，见下
  └─ 真歧义（同时存在的同构区块）→ LLM 消歧        ← 只剩这一类
```

**规则化 scope 提升**（在调 LLM 之前先试）：

对撞车的候选，向上遍历祖先，找第一个满足以下任一条件的容器：
- 有 `role=region` / `role=form` / `role=group` 且有可访问名
- 是 `section` / `fieldset` 且内部有 `h1`–`h6` 或 `legend`
- 是 `.el-card` / `.el-collapse-item` / `.el-tab-pane` 且能取到标题文本

若该容器能让目标唯一，生成 `internal:role=region[name="订单管理"i] >> internal:role=button[name="搜索"i]`。

**这正是 vendor 算法缺失的那一档**（前序已源码确认：parent 递归只产 CSS 结构链，heading 文本不进候选）。补上这一档是纯规则实现，成本远低于 LLM。

## 4.5 状态与导航

```yaml
- id: s2
  desc: 点击「加班申请」菜单
  requires: [sc1]                   # 二级菜单已展开
  ui:
    scope: sc1
    target: {strategy: playwright, selector: 'internal:role=menuitem[name="加班申请"i]'}
  waitAfter:
    urlPattern: "/overtime/apply"
    notEmpty: {strategy: playwright, selector: 'internal:role=heading[name="加班申请"i]'}
    timeoutMs: 8000
  pageState: overtime-apply
```

**回放时的状态校验**：执行 `pageState` 不同的步骤前，先确认当前页面状态匹配；不匹配则报错而非硬试——避免在错误页面上误点同名元素。

**SPA 路由无 load 事件**，`waitAfter.urlPattern` + `notEmpty` 双条件比 `waitForNavigation` 可靠。

## 4.6 异步联动的显式化

```yaml
- id: s4
  desc: 选择加班类型
  requires: [sc3]
  ui:
    scope: sc3
    target: {strategy: playwright, selector: 'internal:role=option[name="工作日加班"i]'}
  waitAfter:
    requestUrlPattern: "/api/overtime/approver"
    notEmpty: {strategy: playwright, selector: 'internal:label=审批人'}
    timeoutMs: 8000
```

录制器应能自动推导：**动作后 2 秒内发生的 XHR** → `requestUrlPattern`；**动作后从空变非空的字段** → `notEmpty`。两条信息录制时都能观测到。

---

# 第五部分 · 会话持有【v1.1 新增】

## 5.1 直接回答：不确定，所以必须探测

> 「录制时每次都是新起一个浏览器，你确定这个浏览器带的有登录信息？浏览器一关闭登录信息还在？」

**答案是：取决于会话存在哪一层。有些层存活，有些层必然丢失。**

`launchPersistentContext(userDataDir)` 让浏览器把状态写进磁盘目录，所以**部分**状态跨进程存活。但不是全部。

### 会话的五层存储模型

| 层 | 存储位置 | 浏览器关闭后 | 说明 |
|---|---|---|---|
| **L1 持久 Cookie**（有 Expires / Max-Age） | user data dir 的 Cookies 数据库 | ✅ **存活** | 唯一天然可靠的一层 |
| **L2 会话 Cookie**（无 Expires） | 内存 | ❌ **丢失** | 企业系统出于安全常用这种 |
| **L3 localStorage** | user data dir | ✅ 存活 | |
| **L4 sessionStorage** | 内存，且限单标签页 | ❌ 丢失 | 换标签页都可能没有 |
| **L5 JS 内存 token**（keycloak-js 等） | 内存 | ❌ 丢失 | 但若 L1 存活，页面加载时可静默重新换取 |

**关键推论**：

- 若目标系统用 **L1 持久 Cookie** → 关掉浏览器再开，登录态还在 ✅
- 若目标系统用 **L2 会话 Cookie** → 关掉浏览器就没了，`launchPersistentContext` 也救不回来 ❌
- 若是 **L5 内存 token**（如 Keycloak 管理台）→ token 必然丢失，但只要支撑它的 L1 cookie 还在，重新打开页面时会静默拿到新 token；若那个 cookie 是 L2，则直接跳登录页

## 5.2 你们已经撞上过这个问题，但修错了方向

GLM 的 v2.0 报告里有这么一条"发现并修复的真实缺陷"：

> session cookie 生命周期：Mock 原用会话 cookie（浏览器关闭即失效），导致 profile 持久会话不可能——与真实企业门户行为不符，已加 maxAge

**"与真实企业门户行为不符"这个判断是错的。**

会话 Cookie（无 Max-Age）在企业系统里非常常见，而且往往是**刻意的安全配置**——就是要让用户关掉浏览器即登出。给 Mock 加 `maxAge` 让测试通过了，但它做的事情是：**把一个真实存在的困难场景从测试环境里删掉了。**

**要求**：Mock 必须**同时**支持两种 cookie 模式，由开关控制：

```
POST /api/login?cookieMode=persistent   → Set-Cookie 带 Max-Age
POST /api/login?cookieMode=session      → Set-Cookie 不带 Max-Age（默认）
```

两种模式下的录制、回放、重入行为都要测。**默认应该是 session 模式**——因为那是更困难、更需要被覆盖的那一种。

## 5.3 三种应对策略

### 策略 1 ⭐ 会话常驻进程（推荐为主路径）

**思路**：把「持有会话的浏览器」和「执行任务的进程」分开。浏览器不关，会话就不会掉——L2/L4/L5 全都还在。

```bash
# 用户上班时执行一次，浏览器打开并保持
dsh session start --entry oa
# → 启动 persistent context，执行 ensureEntry
# → 未登录则前台横幅提示用户登录
# → 登录成功后浏览器保持打开，进程常驻
# → 输出 CDP endpoint 到 .dsh/session-oa.json

# 之后所有录制与回放都附着到这个会话
dsh record --entry oa ...      # 内部 connectOverCDP 附着，不新起浏览器
dsh replay skills/xxx.yaml     # 同上

dsh session status             # 查看各 entry 会话存活状态
dsh session stop --entry oa
```

**优点**：
- 彻底绕开 L2/L4/L5 丢失问题
- 录制与回放共用同一会话，行为一致
- 用户只需在开始工作时登录一次
- 与 v2.0 的「DSH 不代替用户登录」（C16）完全一致——只是把用户那次登录的成果保持得更久

**要点**：
- session daemon 必须**只做会话保持**，不执行任何业务动作
- 会话失效时（Idle 超时、被踢）daemon 检测到后把窗口推前台请用户重新登录，不自行处理
- daemon 进程崩溃/机器重启后，`session status` 必须如实报告"无会话"，不得让 record/replay 误以为有

### 策略 2 · storageState 快照（浏览器必须关闭时的补充）

Playwright 的 `context.storageState()` 能把当前 cookies（**包括会话 Cookie**）与 localStorage 导出为 JSON，之后重新注入。这可以把 L2/L3 抢救回来。

```ts
// 保存
const state = await context.storageState();
await fs.writeFile('.dsh/state-oa.json', JSON.stringify(state));

// 恢复（launchPersistentContext 不接受 storageState 参数，需手动注入）
const ctx = await launchDSHContext({ profileDir });
const saved = JSON.parse(await fs.readFile('.dsh/state-oa.json', 'utf8'));
await ctx.addCookies(saved.cookies);
for (const origin of saved.origins ?? []) {
  const page = await ctx.newPage();
  await page.goto(origin.origin);
  await page.evaluate((items) => {
    for (const { name, value } of items) localStorage.setItem(name, value);
  }, origin.localStorage);
  await page.close();
}
```

**⚠️ 安全要求（必须落实，否则违反 C8）**：

- `state-*.json` 里是**真实会话凭证**，等价于登录态
- 必须写入 `.gitignore`
- 文件权限设为 `0600`
- 必须设 TTL（建议不超过 entry 的会话 idle 时长），过期即删除
- **不得**上传、不得进诊断包、不得进 LLM trace
- 在 `docs/` 中明确写出：这个文件泄漏等同于账号被盗

**这条策略优先级低于策略 1。** 只在无法保持浏览器常驻时使用。

### 策略 3 · 永远探测，绝不假设（无论用哪种策略都要做）

这一条已经在 v2.0 契约里（`entry.sessionProbe` + `ensureEntry`），但需要强化到每个入口：

```
dsh record 开始前   → ensureEntry → 未登录则前台请用户登录
dsh replay 开始前   → ensureEntry（已实现）
录制过程中每 N 秒    → 轻量 sessionProbe，掉线立即提示（见 5.4）
回放每步失败时       → 先判 AuthState，再判业务失败（已实现）
```

**核心原则**：系统的任何位置都不得写出「上次登录过所以现在应该还在」这样的假设。**唯一可信的是当下探测的结果。**

## 5.4 录制中途会话过期（J2，此前完全未处理）

回放侧有 T-59 重入引擎，**录制侧目前没有任何处理**。

真实场景：用户录到第 7 步，会话 Idle 超时，第 8 步点击后页面跳回登录页。当前行为大概率是：探针继续记录登录页上的点击，产出一份混入登录动作的垃圾录制——**而这恰好违反 C16**。

**要求实现**：

```
录制期后台每 30 秒（可配）执行一次轻量 sessionProbe
  ├─ 仍有效 → 继续
  └─ 失效 →
       1. 立即置 __DSH_RECORDING__ = false（停止记录，防止登录动作入库）
       2. 冻结当前已录动作序列（写入临时文件，防丢）
       3. 前台横幅：「会话已过期，请重新登录；登录后可继续录制」
       4. 轮询等待 ensureEntry 完成
       5. 身份校验（C21）：与录制开始时的 identityDigest 比对
            ├─ 不一致 → 中止录制，保留已录部分并标记 identityChanged
            └─ 一致 → 继续
       6. 提示用户：页面状态可能已重置，请回到中断前的位置
       7. 恢复 __DSH_RECORDING__ = true，续录
       8. 在 record.json 中标记断点：{ type: 'session-interrupt', atActionIdx, resumedAt }
```

**分析器必须能识别这个断点标记**，并在 draft.yaml 中：
- 把断点处设为一个 `reentry.anchor` 候选
- 在 `_notes` 中写明「此处录制曾中断，前后步骤的 scope 关系可能不连续，请人工确认」

**scope 关系尤其要注意**：中断前建立的 scope（比如已展开的下拉面板）在重新登录后必然消失。断点后的第一个动作**不得**继承断点前的 `requires`。

## 5.5 多子系统会话不同步（J5）

门户会话与各子系统会话是**独立计时器**，子系统通常更短。

好消息：子系统会话失效可通过 `ensureEntry` 重走门户跳转重建，**只要门户会话还活着**。

所以：
- **真正的生命线是门户会话**
- 子系统会话失效不必惊动用户，静默重建即可
- 门户会话失效才需要用户介入

`dsh session status` 应分层显示：

```
Entry: oa
  门户会话      ✓ 有效（探测于 2 秒前）
  子系统会话    ✗ 已失效 → 可静默重建
  身份          sha256:a1b2c3d4（与 session start 时一致）

Entry: keycloak
  会话          ✓ 有效
  sessionType   bearer（global: keycloak.token）
  ⚠ token 为内存态，浏览器关闭后需重新静默换取，依赖底层 cookie 存活
```

## 5.6 现场必测项（决定策略选择）

**这些数据不写代码就能拿到，且决定采用策略 1 还是策略 2。**

| 项 | 怎么查 | 为什么重要 |
|---|---|---|
| 门户认证 cookie 是 L1 还是 L2 | 浏览器 DevTools → Application → Cookies，看 Expires 列是 `Session` 还是具体时间 | 若是 `Session`，关浏览器即失效，**策略 1 成为必需** |
| 各子系统 cookie 同上 | 同上 | |
| Keycloak `KEYCLOAK_IDENTITY` 是 L1 还是 L2 | 同上 | Keycloak 的 Remember Me 设置会影响这一点，**需在 realm 配置中确认** |
| **SSO Session Idle** | Keycloak → Realm Settings → Sessions | ⚠️ **与 Max 是两个独立计时器**。Max 设 7 天但 Idle 30 分钟时，闲置半小时就掉 |
| SSO Session Max | 同上 | 已知设为 7 天 |
| 门户 token 的 idle / max | 需向门户方确认 | 门户不归项目方管 |
| 是否单点登录互斥 | 在另一台机器登录同一账号，看原会话是否被踢 | 决定 J6 是否需要处理 |
| **真实可用窗口 = min(以上所有)** | | 决定 daemon 需要多久提醒一次重登 |

## 5.7 会话相关的契约扩展

```ts
/** Entry 增补字段 */
export const EntrySchema = z.object({
  entry: z.object({
    // ... v2.0 原有字段全部保留

    /** 【v1.1 新增】会话持有策略 */
    sessionHolding: z.object({
      strategy: z.enum(['daemon', 'storage-state', 'probe-only']).default('daemon'),
      /** 录制/回放期的会话巡检间隔 */
      probeIntervalMs: z.number().default(30_000),
      /** storage-state 策略的快照 TTL，不得超过实际 idle 时长 */
      stateTtlMs: z.number().default(1_800_000),
      /** cookie 类型，由现场探测填写，仅作提示与告警 */
      cookieKind: z.enum(['persistent', 'session', 'mixed', 'unknown']).default('unknown'),
    }).default({}),
  }),
});
```

`dsh doctor --probe-entry` 应自动填充 `cookieKind`：读取落地后的 cookie，检查是否存在 Expires/Max-Age。

若探测到 `cookieKind: 'session'` 且 `strategy: 'storage-state'`，doctor 应告警：**会话 cookie 依赖快照文件保存真实凭证，风险较高，建议改用 daemon**。

---

# 第六部分 · 任务序列

## T-68 · 信任审计与注入硬化【最高优先级】

**依赖**：无

**交付**：
- 注入自检（1.1 代码）
- A1–A5 五项审计的书面结论
- `__dsh_last_clicked__` 竞态修复（改按 actionIdx 索引）+ 快速连点测试
- 全库排查 `addInitScript` 闭包捕获问题

**DoD**：在 A2/A3/A4 出结论前，**不得**进行任何 cutover 决策、不得修改成本模型、不得删除 legacy generator。

---

## T-69 · 场景矩阵补齐（组 A）

**依赖**：T-68

**交付**：
- 场景 G1–G5 桩（no-id 形态）+ 每场景产物原文与 confidence
- **明确回答**：Element Plus 表单结构（G3）下，通用引擎是否需要 `el-locator.byFormItem` 作为候选补充
- `internal:attr` / `internal:label` 引擎接桩

---

## T-70 · DOM 变更观测器【核心新增能力】

**依赖**：T-68

**交付**：`packages/locator/src/mutation-tracker.ts`（浏览器侧，零依赖，遵守 C9）

**验收**：
- 点 `el-select` → 观测到 1 个 `kind=listbox` `portaled=true` 的 root
- 点「提交」→ 1 个 `kind=dialog`
- 点「添加明细」→ 1 个 `kind=table-row`
- 选择联动值 → 观测到条件渲染字段出现
- **噪音控制**：一次动作产出的 root 数量 ≤ 3（若上百，说明只记子树根没做对）

---

## T-71 · Scope 推导与契约扩展

**依赖**：T-70

**交付**：契约扩展（4.3）、录制后处理推导（4.2）、scope 内 selector 重生成、回放期 scope 解析

**验收**：
- 确认框「确定」：**不再需要 LLM**，scope 内 HIGH
- 下拉选项：scope 到面板，HIGH
- 表格行内按钮：scope 到行，HIGH
- **量化对比**：同一录制流程，引入 scope 前后的 LLM 触发次数

**DoD**：这个量化对比是回答"LLM 是不是主路径"的真正依据，优先级高于任何成本模型讨论。

---

## T-72 · 规则化 scope 提升

**依赖**：T-71

**交付**：4.4 的祖先容器提升规则，作为 LLM 消歧的前置尝试

**验收**：原 D 场景（两个 section 各有「搜索」按钮）**不调 LLM 即可区分**

---

## T-76 · 会话常驻进程【v1.1 新增，可与 T-70/71 并行】

**依赖**：T-68

**交付**：
- `dsh session start / status / stop`
- daemon 持有 persistent context，附着方式（`connectOverCDP` 或共享 context）
- `dsh record` / `dsh replay` 优先附着已有会话，无会话时按 `sessionHolding.strategy` 决定行为
- `EntrySchema.sessionHolding` 契约（5.7）
- `dsh doctor --probe-entry` 自动填充 `cookieKind`

**❌ 禁止**：
- daemon **不得**执行任何业务动作，只做会话保持与探测
- daemon **不得**代替用户登录（C16 不因本任务放宽）
- 会话失效时 daemon 只能提示，不得自行处理

**验收**：
- Mock 在 `cookieMode=session` 下：daemon 保持浏览器不关，录制→回放全程会话有效
- 手动 kill daemon → `session status` 如实报告"无会话"，`dsh record` 不得误以为有会话而继续
- daemon 运行期间调 `/api/_debug/expire` → status 在一个巡检周期内转为失效并提示

---

## T-77 · Mock 双 cookie 模式 + 录制期会话中断【v1.1 新增】

**依赖**：T-76

**交付**：
- Mock 支持 `cookieMode=persistent | session`（5.2），**默认 session**
- 录制期会话巡检与中断处理全流程（5.4 八步）
- `record.json` 的 `session-interrupt` 断点标记
- 分析器识别断点：设为 `reentry.anchor` 候选 + `_notes` 警告 + **断点后首个动作不继承断点前的 `requires`**

**验收**：
| 场景 | 期望 |
|---|---|
| 录到第 7 步会话过期 | 立即停止记录，已录 7 步完整保留 |
| 过期后用户重新登录（同身份） | 可续录，record.json 含断点标记 |
| 过期后换身份登录 | 中止录制，标记 identityChanged，**不续录** |
| 登录页上的点击 | **不得**出现在 record.json 中（C16） |
| 断点前建立的 scope | 断点后不被继承 |
| `cookieMode=session` 下关闭浏览器重开 | 会话确实丢失，`ensureEntry` 正确识别并请用户登录 |
| `cookieMode=persistent` 下同上 | 会话存活，直接进入 |

---

## T-73 · 动态场景补齐（组 B + 组 C）

**依赖**：T-71

**交付**：H1–H10、I1–I6 全部场景桩与实测

重点：
- H2 远程下拉：录制输入 + 等待请求 + 等待选项出现
- H5 条件渲染：字段反复出现/消失时 scope 的失效与重建
- H10 虚拟滚动：优先搜索/筛选缩小范围，其次分段滚动
- I2 SPA 路由：`waitAfter` 双条件验证
- I6 iframe：frameLocator 支持

---

## T-74 · 异步联动推导

**依赖**：T-70, T-71

**交付**：录制器自动推导 `waitAfter.requestUrlPattern` 与 `waitAfter.notEmpty`

**验收**：加班类型选择步骤自动带上审批人接口与字段等待条件，回放不再依赖固定 sleep

---

## T-78 · storageState 快照【v1.1 新增，可选】

**依赖**：T-76

> **仅在现场确认无法保持浏览器常驻时才做。** 优先级低于 T-76。

**交付**：5.3 策略 2 的快照与恢复，含全部安全要求（gitignore、0600、TTL、不进诊断包/LLM trace）

**验收**：`cookieMode=session` 下关闭浏览器 → 恢复快照 → 会话有效；TTL 过期后文件被删除且 `ensureEntry` 正确请用户重登

---

## T-75 · Cutover 决策

**依赖**：T-69, T-71, T-72, T-73

**决策依据必须包含**：
- 修复后的六场景 HIGH/LOW 比例（T-68 A2）
- 表单场景 G1–G5 结果，尤其 G3（T-69）
- scope 引入前后的 LLM 触发次数对比（T-71）
- 规则化提升的覆盖率（T-72）
- 动态场景通过率（T-73）

**只有全部数据齐备后**才允许切换 `DSH_LOCATOR_ENGINE` 默认值或删除 legacy。

---

# 第七部分 · 给 GPT 的行为要求

## 7.1 结论必须与证据同级

前序最大的问题不是能力，是**用未验证的实验数据下架构级结论**：在旗帜从未生效的情况下测出 0 HIGH，据此把 LLM 从边缘补充提升为主路径，并重估整个成本模型。

**要求**：
- 任何影响架构的结论，必须先证明测试链路本身是正确的
- 官方工具（`npx playwright codegen`）能一分钟对照的事，不要靠推理
- 报告中区分「实测」「推断」「未验证」三类表述，不要混用

前序做得好的地方也要保留：它主动把自己判 HIGH 的 B 场景改判 LOW，还去翻 vendor 源码确认行为是否固有。**这种自我纠错值得延续。**

## 7.2 不要把困难场景从测试里删掉

Mock 的 session cookie 事件是个典型：发现测试环境里会话不能持久，于是给 Mock 加了 `maxAge` 让它持久——**测试过了，但真实困难消失了**。

**要求**：当测试环境的某个特性让实现变困难时，先判断这个特性在真实系统里是否存在。存在，就把它保留下来并让实现去适应；不存在，才改测试环境，并在提交信息里写明判断依据。

## 7.3 优先用规则，LLM 排最后

```
1. 语义锚点（role / label / placeholder / text）
2. scope 锚定（由 DOM 变更观测推导）      ← 本次新增
3. 规则化祖先提升（有标题的容器）          ← 本次新增
4. 元素指纹多特征打分（可选，见 7.5）
5. LLM 消歧                              ← 只到这一步
6. 位置兜底（nth），标记 LOW
```

每往下一档，成本上升一个量级。**在第 5 档投入之前，把第 2、3 档做透。**

## 7.4 静默的错误比失败更危险

自愈/消歧领域公认的最危险失败模式：引擎选中一个视觉相似但功能错误的元素，测试通过，错误上线。

前序的 oracle 验证 + 负例测试防住了这一点，**必须保留并扩展到新增机制**：
- scope 解析出多个容器 → 报错，不取第一个
- scope 不存在 → 报错，不降级到 page-global
- 消歧提案验证失败 → 保持 LOW，不勉强采用
- **会话探测结果为 unknown → 按未登录处理，不乐观假设**

## 7.5 不要重复造轮子

| 项目 | 可借鉴 | 不要引入 |
|---|---|---|
| `healenium/healenium` | 树编辑距离匹配（能优雅处理"外面又包了一层布局"，正对应 nth-child 内包一层就断的问题）；`score-cap` 阈值；治愈报告与截图留痕 | 整套 Selenium 代理架构 + Docker + Postgres 后端 |
| `healenium/healenium-example-playwright-nodejs` | Playwright 侧接入形态参考 | — |
| `VadimToptunov/self-healing-locators` | 策略阶梯设计（LLM 排最后、"没有报告的治愈是陷阱"） | 指南仓库，无代码可用 |
| Playwright `selectorGenerator.ts` | 已 vendor，保持逐字节一致 | 不要改 vendor |

**元素指纹（第 4 档）是可选项**：内网系统改版频率低，若 scope + 语义锚点已把 HIGH 比例做上去，指纹层可以不做。**先测数据再决定，不要预先实现。**

## 7.6 里程碑停止点

延续 v2.0 规格 §0.2 规则 9：每完成一个任务停下汇报，等确认后再进入下一个。

**T-68 尤其不可跳过**——它决定后面所有结论的地基是否可信。

---

# 附录 A · 与 v2.0 规格的关系

| v2.0 内容 | 状态 |
|---|---|
| 约束 C1–C23 | **全部有效**，尤其 C9（浏览器侧零依赖）、C4（自愈 resolve-only）、C7（不生成脆弱 CSS 路径）、**C16（技能不含登录）**、**C8（凭证不落 DSH 存储）** |
| 第二部分冻结契约 | **有效**，本文档 4.3 / 5.7 是**扩展**而非替换 |
| M0–M8 任务体系 | **有效**，T-68 ~ T-78 是 M2/M3 的深化，插在 M6 之前 |
| entry / 认证 / 重入 / postcondition 体系 | **有效**，第五部分是对它的补强而非替换 |
| §6 坑位表 | **有效**，附录 B 的新增项请追加进去 |

# 附录 B · 新增坑位（请追加到 v2.0 §6）

| 坑 | 表现 | 正确做法 |
|---|---|---|
| `addInitScript` 闭包捕获外层变量 | 变量不序列化，注入静默失效，实际跑的是旁路 | 参数形式传递；注入后立即自检，缺失即抛错 |
| 为动态元素生成 page-global selector | 元素在录制前不存在，唯一性依赖前置动作，必然撞车退化到 nth | 由 DOM 变更观测推导 scope，在 scope 内生成 |
| oracle 用单一全局变量 | 异步消歧期间用户继续点击，验证比对的是错误元素 | 按 actionIdx 索引 |
| 只在 button 上做定位器对比 | 结论无法迁移到表单控件，而 OA 页面主要是表单 | 场景矩阵必须覆盖 input/select/datepicker/dialog/table |
| SPA 路由用 `waitForNavigation` | 无 load 事件，等不到 | `waitAfter.urlPattern` + `notEmpty` 双条件 |
| 联动请求用固定 sleep | 内网慢时不够，快时浪费 | 录制期推导 `requestUrlPattern` + `notEmpty` |
| scope 解析出多个容器时取第一个 | 静默操作错误弹窗/错误行 | 报错，不取第一个 |
| **假设 profile 目录能保住所有会话** | 会话 Cookie、sessionStorage、内存 token 关闭即失效，`launchPersistentContext` 救不回来 | 五层模型逐层判断；主用 daemon 常驻；永远探测不假设 |
| **把会话 Cookie 改成持久 Cookie 让测试通过** | 真实困难被从测试环境里删掉了 | Mock 双模式，默认 session |
| **录制中途会话过期未处理** | 登录页上的点击被录进技能，违反 C16 | 巡检发现即停止记录、冻结已录、请用户登录、身份校验后续录 |
| **断点后继承断点前的 scope** | 重新登录后弹窗/下拉面板早已消失，scope 必然失效 | 断点后首个动作清空 `requires` |
| storageState 快照当普通文件放着 | 文件泄漏等同账号被盗 | gitignore + 0600 + TTL + 不进诊断包/LLM trace；优先改用 daemon |
| 把 Keycloak 的 SSO Session **Max** 当成可用窗口 | Max 7 天但 Idle 30 分钟，闲置半小时就掉线 | 两个计时器分别实测，取 min |

---

**文档结束**
