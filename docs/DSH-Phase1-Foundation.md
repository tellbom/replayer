# DSH Browser Skill · Phase 1 · Foundation

版本：v1.0
日期：2026-08-28
用途：**交付 Codex 执行**（开发任务，非调研）
上游：Phase 0 验收通过（Gate 三项达标）
后续：Phase 1 完成后由 GLM 做 Gate 验证，见 §7

---

## 0. 交付对象与分工

| 角色 | 职责 | 时点 |
|---|---|---|
| **Codex** | 执行本文档全部任务，写代码 | 现在 |
| **GLM** | Phase 1 完成后做 Gate 验证（不变量验证，非格位验证） | Codex 交付后 |
| 裁决 | 评估 GLM 报告，决定是否进入 Phase 2 | GLM 交付后 |

**本文档是开发任务。** 其中 1-0 是开发前的排查，查完在同一轮内处置，不是独立评估报告。

---

## 1. 本阶段目标

### 1.1 一句话

> **把录制从「白名单决定记不记」改成「无条件记录 + 观察状态变化」。**

### 1.2 要解决的根因

Phase 0 让所有失败变得响亮，但**失败的数量没有减少**。摸底报告中大量格位失败的根因是同一个：

```
recorder-probe.ts 的两处白名单

白名单一（点击）：button / a / [role=button] / 组件库下拉项
白名单二（输入）：isTextInput()

命中 → 记录
未命中 → 静默丢失
```

导致：

| 格位 | 丢失内容 |
|---|---|
| C4 contenteditable | 零捕获 |
| C6 穿梭框 `li` 点击 | 未捕获 |
| C10/C11 只读日期输入的点击 | 未捕获，面板打不开 |
| C8 数字步进 | 点击记了，但程序化 value 变化不可见 |
| C12 开关 | 点击记了，但 `aria-checked` 状态不提取 |
| A6 `div onclick` | 未捕获 |

**照白名单补下去永远追不完**——补完 Element Plus 还有 Ant Design，补完常见控件还有各家自研组件。

### 1.3 新模型

```
旧：事件发生 → 是不是我认识的控件？→ 是则记录，否则丢弃

新：事件发生 → 无条件记录
            → 记下动作前的可观察状态
            → 动作发生
            → 记下动作后的可观察状态
            → 观察产生了什么变化（含其他元素）
            → 尽力分类；分不出来标 unknown，证据全留
```

**核心约束（不可让步）**：

> **分类只用于打标签，永不用于决定是否记录。**

### 1.4 效果示例

**C8 数字步进**（点 ＋ 按钮，值 1→2）

```
旧：JS 改 value 不触发 input → 未进白名单 → 值变化完全无记录
新：点击被无条件记录
    before: 某输入框 value = "1"
    after:  某输入框 value = "2"
    → 「点击该按钮导致某可提交值从 1 变为 2」
    → 不需要知道它是"数字步进器"
```

**C12 开关**（`role=switch`）

```
旧：click 记了，但不知道状态变成什么
新：before: aria-checked = "false"
    after:  aria-checked = "true"
    → 该状态即参数值
    → 不需要知道它是哪个组件库的 Switch
```

**同一套机制解掉两个完全不同的控件。** 这是"通用规则"与"逐个补丁"的分界。

---

## 2. 1-0 · 前置排查【最先执行，两项阻塞】

Phase 0 验收暴露两项需要在开工前查清的问题。**结论出来之前不要开始 1-1。**

### 1-0-A · 日期字段 DOM 值为空的归因【阻塞】

Phase 0 报告记录：

> fixture 的日期动作完成后 DOM 当前值为空。旧用例仍点击并报成功；当前安全门明确中止。

**表述指向 fixture，但也可能是产品缺陷。** 两种可能后果差别极大：

| 归因 | 含义 |
|---|---|
| fixture 的日期控件失焦后清空显示值 | 改 fixture 即可 |
| **`setDateTime` 写入的值被组件覆盖或未真正写入** | **所有日期字段的填值可能一直无效**——此前含日期的技能，提交值可能来自页面默认而非参数 |

日期在 OA 表单中极常见（请假起止、加班时段、报销日期）。若是第二种，这是又一个静默错误，只是恰好被 0-6 的载体校验挡住了。

**排查方法**：

```
1. 回放一个日期步骤
2. 在 setDateTime 执行后立即读取：
   a. 该 input 的 DOM value 属性
   b. 该 input 的 value 属性（IDL）
   c. 组件内部 model 值（若可读）
   d. 提交请求体中该字段的实际值
3. 判断：值是写进去了又被清掉，还是根本没写进去
4. 若提交值与传入参数不一致 → 属于产品缺陷，记录并纳入 Phase 1 修复范围
```

**产出**：归因结论 + 证据。若判定为产品缺陷，在 1-2 的 state observation 中一并解决（`before`/`after` 状态观察天然覆盖"写进去了没有"）。

### 1-0-B · multipart 拒绝判据明确化【阻塞】

Phase 0 实现了 `UnsupportedMultipartError`，但报告表述为「当前执行器无可验证 multipart 载体时」，判据不明确。

**风险**：部分框架的普通表单（无文件）也用 multipart 编码。若判据是「只要 Content-Type 是 multipart 就拒绝」，那类系统的**所有提交**都会被误伤。

**排查方法**：

```
1. 查明当前实现的实际触发条件（贴代码）
2. 构造两个场景：
   a. multipart + 含文件引用
   b. multipart + 纯文本字段，无文件
3. 观察行为
```

**处置**：

```
若场景 b 也被拒绝 → 收窄判据：
  仅当请求含无法重建的文件载体时拒绝
  纯文本 multipart 应能正常发送（浏览器可自行编码）

若已正确区分 → 记录判据，无需改动
```

### 1-0-C · 关卡一畸形输入健壮性【非阻塞，可并行】

Phase 0 的关卡一扫描的是**未经 Schema 校验的原始 YAML 对象**，结构可能任意。

补测：循环引用（YAML 锚点可构造）、超深嵌套（栈溢出）、非常规类型。

**要求**：明确报错，不得未捕获异常（C27）。

### 1-0-D · merged 载体防线的长期回归标记【记录即可】

Phase 0 报告说明：原 A 组场景现被参数校验（`EnumMappingError` / `UnknownParameterError`）先行拦截，merged 载体校验未被触发；防线由独立用例验证。

**这不是问题**（两道防线都在），但有前瞻风险：

> Phase 2 修好 enum 值域后，参数校验不再失败，A 组场景会走到 merged 那道防线。

**要求**：把该独立用例标记为长期回归，并在 Phase 2 完成后重跑完整 A 组场景，确认 merged 防线真的接得住。

---

## 3. 1-1 · Canonical Action IR

### 3.1 设计原则

- **Browser-neutral / framework-neutral / fixture-neutral**
- Analyzer 只消费 IR，不认识具体 recorder
- **复用 T-96 已有的因果体系**（`actionIdx` / `activeAction` / request causality），**不另造平行身份体系**

### 3.2 类型定义

```ts
// packages/core/src/ir.ts（新增）

export interface CanonicalAction {
  id: string;
  /** 复用 T-96 因果体系，与 RecordedRequest.actionIdx 对应 */
  actionIdx: number;
  timestamp: number;

  /**
   * 动作分类。仅用于打标签，不用于决定是否记录。
   * 'unknown' 是必需成员——没有它，本枚举就是新一代白名单。
   */
  kind: 'activate' | 'edit' | 'select' | 'check'
      | 'key' | 'upload' | 'navigate' | 'unknown';

  target?: SemanticTarget;

  before?: ObservableState;
  after?: ObservableState;

  effects?: {
    domMutations?: DomEffect[];
    /** 引用 RecordedRequest.requestId，不复制请求内容 */
    requestIds?: string[];
    navigation?: NavigationEffect;
  };

  /** unknown 及诊断用的原始证据 */
  raw: {
    eventTypes: string[];      // 合并前的原始事件序列
    trusted: boolean;          // Event.isTrusted
    unclassifiedReason?: string;
  };

  source: 'playwright-probe';  // 第一版仅此一种
}

export interface SemanticTarget {
  tag?: string;
  role?: string;
  accessibleName?: string;
  name?: string;               // name 属性
  inputType?: string;
  placeholder?: string;

  locatorEvidence?: {
    generatedSelector: string; // vendor selectorGenerator 产物
    confidence: 'HIGH' | 'LOW';
    cssCandidates?: string[];  // 仅作证据，不作身份
  };

  neighborhood?: {
    ancestorRoles?: string[];
    labelText?: string;        // 含无 for 关联的邻近 label
    formScope?: string;        // 所属 form 的可访问名
  };
}
```

### 3.3 ObservableState

**这是解掉 C8 / C12 / C15 的核心。** 关键是它不只观察目标元素自身——很多控件的效果发生在**别的元素**上（点 ＋ 按钮，值变在输入框里）。

```ts
export interface ObservableState {
  /** 目标元素自身 */
  self?: ElementState;

  /**
   * 受该动作影响的其他元素。
   * 由 DOM mutation 观察得出，不依赖控件类型知识。
   */
  affected?: Array<{
    locator: LocatorStrategy;
    state: ElementState;
  }>;

  /** 页面级状态 */
  page?: {
    url: string;
    focusedLocator?: LocatorStrategy;
  };
}

export interface ElementState {
  value?: string | string[] | null;   // 多选 select 为数组
  checked?: boolean;
  selected?: boolean;
  textContent?: string;
  innerHTML?: string;                 // contenteditable
  files?: Array<{ name: string; size: number; type: string }>;
  /** 标准 ARIA 状态属性，键为属性名去掉 aria- 前缀 */
  aria?: Record<string, string>;
  disabled?: boolean;
  readonly?: boolean;
}
```

**`aria` 采集范围（第一批）**：`checked` / `selected` / `expanded` / `valuenow` / `valuetext` / `pressed` / `disabled` / `invalid`。

**采集边界**：
- `affected` 只记录**值发生变化**的元素，不做全页快照
- `affected` 数量上限走具名常量（建议 20），超限截断并标记
- `innerHTML` 长度上限走具名常量（建议 8192），超限截断并标记
- 全部经 `sanitize` 后落盘（C11）

### 3.4 与现有类型的关系

`RecordedSession` 增加 IR 通道，**旧字段保留**（shadow compare 需要）：

```ts
export interface RecordSession {
  meta: { ... };
  actions: RecordedAction[];        // 旧路径产物，Phase 1 保留
  canonicalActions?: CanonicalAction[];  // 【新增】新路径产物
  network: RecordedRequest[];
  pageSnapshots: PageSnapshot[];
  recorderPath: 'legacy' | 'canonical';  // 【新增】本次录制走的路径
}
```

**约束**：`recorderPath` 决定本次录制走哪条路径，**一次录制只能选一条**（C6：不允许运行时混合）。

---

## 4. 1-2 · PlaywrightCanonicalRecorder

### 4.1 无条件记录的具体含义

监听以下事件，**全部在捕获阶段，不做任何 target 过滤**：

| 事件 | 用途 |
|---|---|
| `pointerdown` / `pointerup` / `click` | 激活类交互 |
| `beforeinput` / `input` | 编辑类交互 |
| `change` | 值提交（select / checkbox / radio / file） |
| `keydown` | 仅语义键：`Enter` / `Tab` / `Escape` / 方向键 |
| `compositionstart` / `compositionend` | 输入法 |
| `focus` / `blur` | 焦点转移，用于动作边界判定 |
| `drop` | 拖放 |
| 页面级 `framenavigated` | 导航 |

**不得**对 `event.target` 做任何标签、类名、role 的过滤判断。

### 4.2 动作合并（这是合并，不是过滤）

无条件记录会产生大量原始事件，需要合并为语义动作。**合并规则不看控件类型，只看事件序列与目标同一性**：

```
同一目标元素 + 时间窗内的事件序列 → 合并为一个 CanonicalAction

pointerdown + pointerup + click        → activate ×1
连续多次 input（同一元素）              → edit ×1，value 取最终态
focus → input... → blur                → edit ×1
compositionstart ... compositionend    → edit ×1（输入法整段）
change（select/checkbox/radio）         → select / check ×1
change（file input）                    → upload ×1
```

**时间窗与目标同一性判据复用 T-96 的 `activeAction` 机制**（`targetKey` 构造、`activeWindowMs`、`blurGraceMs`），不另写一套。

**合并后仍无法分类的**：

```
kind: 'unknown'
raw.eventTypes: ['pointerdown','pointerup','click']
raw.unclassifiedReason: '未观察到任何状态变化'
target / before / after / effects 全部保留
```

**绝不丢弃。**

### 4.3 before / after 采集时机

```
动作开始前（第一个原始事件的捕获阶段）：
  采集 target 自身 ElementState → before.self
  记录页面 url / focus → before.page

动作完成后（合并窗口结束 + settleMs）：
  采集 target 自身 → after.self
  从 MutationObserver 结果中筛出值发生变化的元素 → after.affected
  记录页面 url / focus → after.page
```

**`settleMs` 走具名常量**（建议复用 T-70 的 mutation settle 窗口，800ms）。

**复用 T-70 的 mutation-tracker**，不新建观察器。

### 4.4 与 T-96 因果体系的对接

```
CanonicalAction.actionIdx 与 RecordedRequest.actionIdx 使用同一序号空间
CanonicalAction.effects.requestIds 引用 RecordedRequest.requestId
```

**禁止**（Stop-A）：新建一套与 T-96 平行且无法复用的动作身份体系。若发现必须新建，**停止并提数据模型方案**。

### 4.5 Analyzer 的过渡适配器

Phase 1 **不改 Analyzer 逻辑**（那是 Phase 2）。为让新 IR 能被现有 Analyzer 消费，建一个过渡件：

```ts
// packages/analyzer/src/ir-downgrade.ts（过渡件，Phase 2 删除）
export function downgradeToLegacyActions(
  actions: CanonicalAction[]
): RecordedAction[];
```

**要求**：
- 文件头必须写明「过渡件，Phase 2 ValueLineage 完成后删除」
- 只做结构转换，**不得**在其中加入任何推断逻辑
- 转换中丢失的信息（`before`/`after`/`affected`/`unknown` 动作）记入 `_notes`

**这样 shadow compare 可以在同一个 Analyzer 上比较两种 recorder 的产物**，变量只有捕获层。

---

## 5. 1-3 · Replayer Actionability 清理

### 5.1 删除

| 删除内容 | 位置 | 替代 |
|---|---|---|
| `count()` 即时唯一性预检 | `channel-ui.ts` | Playwright strict mode |
| 手写 visible 检查 | 同上 | Playwright auto-wait |
| 手写 enabled 检查 | 同上 | Playwright actionability |
| 手写 stable / boundingBox 检查 | 同上 | 同上 |

**原则**：

```
DSH 负责 target resolution
Playwright 负责 actionability
DSH 负责 postcondition
```

### 5.2 一个必须验证的陷阱

`count()` 预检里混着一个**合法用途**：strict multiple 检测（禁止 `.first()`）。

Playwright 的 strict mode 本身会在多匹配时抛错，所以确实冗余。**但删除时必须确认 strict mode 是开的**——否则会从"多匹配报错"退化成"静默取第一个"，那是 P0 级倒退。

**验收要求**：构造多匹配场景，确认仍报错而非取第一个。

### 5.3 保留

以下不属于 actionability 重复实现，**保留**：

- T-84 语义漂移断言（校验"定位到的元素对不对"）
- Phase 0 的 UI 载体完整性校验（校验"值有没有写进去"）
- `settleNavigation`（导航稳定判定，Playwright 无等价物）

**这三者与 actionability 正交，都要保留。**

---

## 6. 1-4 · Adapters 层建立

### 6.1 目录结构

```
packages/
  core/
  locator/          ← 保留通用部分
  recorder/
  analyzer/
  replayer/
  browser/

adapters/           ← 【新增】
  element-plus/
  element-ui/
```

### 6.2 迁移清单

| 从 | 到 | 说明 |
|---|---|---|
| `packages/locator/src/el-locator.ts` | `adapters/element-plus/` | 组件库执行兼容（浮层挂载位置、动画等待等） |
| `packages/locator/src/compat.ts` | `adapters/element-ui/` | Element UI 2.x 兼容层 |

**历史说明**：T-83 曾把 `el-locator` 作为「执行层兼容代码」豁免于 C24。**这个豁免一直是个例外，现在有了更干净的归宿。**

### 6.3 Adapter 约束

```
① core 不 import 任何 adapter
② adapter 只能【增加】证据，不能绕过任何 core invariant
③ adapter 失效时，core 走通用路径降级，不崩
④ adapter 不得影响 Safety Gate（Phase 0 建立的任何守卫）
⑤ framework class 只能存在于 adapter，core 中一律禁止
```

### 6.4 现有违规盘点

迁移前先做一次 inventory，列出 `packages/*` 中所有框架特化路径：

```bash
grep -rniE "\.el-|\.ant-|\.arco-|\.Mui|element-plus|element-ui" packages/ \
  --include="*.ts" | grep -v "\.test\.\|\.spec\."
```

对每一条判定：

```
能表达成 DOM / ARIA / Browser 通用语义 → 重写为 core 通用规则
只能依赖框架私有 class              → 移到 adapter
只是 fixture 特判                    → 删除
```

**结果贴进报告。**

---

## 7. 1-5 · CI Import 边界检查

### 7.1 规则

```
① packages/analyzer 不得 import packages/recorder 的具体实现类型
   （只能 import packages/core 的 CanonicalAction）
② packages/core 不得 import 任何 adapters/*
③ packages/{core,analyzer,replayer,browser} 不得 import adapters/*
④ 浏览器侧代码（packages/locator/src/*）不得 import 任何 npm 包（C9）
```

### 7.2 实现

加一个 CI 检查脚本，违反即 fail。

**规则 ①的价值**：它免费保证了 IR 的 recorder 中立性，**不需要真的建第二个 recorder adapter 来证明**（这是推迟 Chrome Recorder adapter 的依据）。

---

## 8. 禁止修改范围

| 禁止 | 归属阶段 |
|---|---|
| ❌ Analyzer 的参数识别 / 类型推断逻辑 | Phase 2（ValueLineage） |
| ❌ Channel 决策逻辑（`draft.ts` 的 channel 判定） | Phase 2（Channel Planner） |
| ❌ enum 值域扩展 | Phase 2 |
| ❌ 参数命名优先级链 | Phase 2 |
| ❌ 文件上传能力（`setInputFiles` 回放） | Phase 2 |
| ❌ **Phase 0 建立的任何 Safety Gate**（只能加强，不能放松） | — |
| ❌ 删除 legacy recorder path | Phase 3 |
| ❌ 引入 rrweb / Chrome Recorder / Puppeteer | 已裁决不做 |
| ❌ 新增任何 framework 特化进 core | 永久 |

**特别强调**：Phase 1 只交付基础设施。**不要顺手把某个控件修绿**——控件表现是 Phase 2 的结果。

---

## 9. Gate

### 9.1 Shadow Compare 判据

Phase 1 的 Gate 是 shadow compare，**判据不能是"一致"**——新路径应该捕获得比旧的多，那正是重构目的。

```
硬性（全部满足）：
  ① 新路径捕获的动作集合 ⊇ 旧路径
     （旧路径捕获到的任何动作，新路径都必须有对应项）
  ② 同一动作的 semantic target 语义等价
     （accessibleName / role / name 一致）
  ③ 回放结果不劣化
     （旧路径通过的格位，新路径必须也通过）
  ④ Safety Gate 无退化
     （Phase 0 的 Silent Wrong Success = 0 保持）

允许（预期发生）：
  · 新路径捕获更多动作（C4/C6/C10/C12 等旧路径丢失的）
  · 新路径产生更多 TODO_UNRESOLVED
    （因为捕获了更多但 Analyzer 暂时判不了）
```

**第 ④ 条与"允许"的第二条要一起读**：新路径捕获更多 → 更多值需要溯源 → 可能产生更多 TODO。**这是好事**，只要它们被正确拦截而非静默提交。

### 9.2 Phase 1 不追求的

```
❌ 矩阵格位变绿
❌ 覆盖率提升
❌ 任何控件"支持"
```

**Phase 1 之后，绿格数量大概率不变，TODO 数量可能上升。** 这是预期结果。

---

## 10. GLM 的验证方法（Phase 1 交付后）

**GLM 不再验证"某个控件是否支持"，改为验证不变量。**

### 10.1 不变量清单

| 原格位 | 改为验证的不变量 |
|---|---|
| C4 | contenteditable 属于标准 editable 语义，其 edit interaction 与 state transition 可被通用 recorder 表达 |
| C6 | 非 `button` 标签的真实 pointer activation 不因 tag 白名单而丢失 |
| C8 | 程序化 value 变化经 before/after 对比可观察 |
| C10 | readonly input 的 activation 不因不可编辑而丢失 |
| C12 | ARIA state transition 进入 after-state |
| C15 | 动态出现元素上的 interaction 可被捕获 |
| C16 | 多 action 累积出的 array lineage 与 derived dependency 不丢失 |

### 10.2 跨形态证明要求

**每条不变量至少在两种不同形态上证明**：

```
原生 HTML 形态  +  自定义组件 DOM 形态
```

**目的**：防止单一 fixture 特征回流进 core。

例如 C6 的不变量，要同时用 `<li>` 和 `<div role="option">` 两种形态证明。

---

## 11. 报告格式

```
1-0 前置排查
  A · 日期 DOM 值归因:
    归因结论:        [fixture 问题 / 产品缺陷]
    证据:            DOM value=____ IDL value=____ 提交值=____
    若为产品缺陷:    处置方式 ______
  B · multipart 判据:
    当前触发条件:    ______（贴代码）
    纯文本 multipart 场景:  [被拒绝 / 正常发送]
    是否需要收窄:    [是/否]，处置 ______
  C · 畸形输入健壮性:  [已补测/未补测]，结果 ______
  D · merged 长期回归标记:  [已标记/未标记]

1-1 Canonical Action IR
  ir.ts 位置:        ______
  kind 枚举含 unknown: [是/否]
  actionIdx 与 T-96 同一序号空间: [是/否]
  affected 上限常量:  ______
  ObservableState aria 采集项:  ______

1-2 CanonicalRecorder
  监听事件清单:      ______
  target 过滤:       [无 / 有——位置 ______]  ← 必须为"无"
  合并规则复用 T-96 activeAction: [是/否]
  unknown 动作证据保留项:  ______
  ir-downgrade.ts:   [已建/未建]，文件头过渡件标注 [有/无]

1-3 Actionability 清理
  删除项逐项:        count() [已删/保留] visible [已删/保留] ...
  strict mode 确认:  多匹配场景 → [报错 / 取第一个]  ← 必须"报错"
  保留项确认:        T-84 [保留] Phase0 载体校验 [保留] settleNavigation [保留]

1-4 Adapters
  目录建立:          [是/否]
  迁移清单:          el-locator → ______ / compat → ______
  违规盘点 grep:     命中 __ 处
    重写为通用:      __ 处
    移到 adapter:    __ 处
    删除:            __ 处
    保留（说明理由）: __ 处

1-5 CI Import 边界
  四条规则实现:      逐项 [是/否]
  违规时是否 fail:   [是/否]

Gate · Shadow Compare
  ① 动作集合 ⊇:     PASS / FAIL
     旧路径动作数:   __
     新路径动作数:   __
     旧有新无的动作: __ 个（必须为 0），若非 0 逐项列出
  ② semantic target 等价:  PASS / FAIL，差异项 ______
  ③ 回放结果不劣化:  PASS / FAIL
     旧通过新失败的格位: __ 个（必须为 0）
  ④ Safety Gate 无退化:  PASS / FAIL
     Silent Wrong Success = __（必须为 0）

  新路径额外捕获:    __ 个动作（预期 > 0）
  新路径 TODO 变化:  旧 __ → 新 __（上升属预期）

回归
  unit / e2e 全量 / T68-T74+T84 / Phase0 验收项
  （skipped 逐项说明）

总结
  本阶段状态 / 遗留问题 / 未能完成项及原因
  是否可进入 Phase 2
```

---

## 12. 注意事项

### 12.1 分类只打标签，永不过滤

这是本阶段唯一不可让步的约束。

审查自己的实现时，问一个问题：**有没有任何一处代码，因为"没认出来"而不记录？**

有 → 就是白名单换了位置。

### 12.2 `kind: 'unknown'` 必须第一版就有

`kind` 本身也是封闭枚举。**没有逃生口，它就是新一代 tag whitelist。**

C4 那种"零捕获"会以另一种形式重现——只是这次丢失发生在分类阶段而非监听阶段。

### 12.3 affected 是解 C8 的关键，不要只观察 target 自身

很多控件的效果发生在**别的元素**上：

- 点 ＋ 按钮 → 值变在输入框
- 点穿梭框的 ＞ → 项目从左列表移到右列表
- 选级联上级 → 下级选项集合变化

**只观察 target 自身，这些全都看不见。**

### 12.4 不要另造因果体系（Stop-A）

T-96 已有 `actionIdx` / `activeAction` / request causality。Phase 1 必须复用。

若发现必须新建一套平行身份体系 → **停止，先提数据模型方案**。

三套身份体系（recorder 一套、IR 一套、analyzer 一套）是这个项目最不能承受的债务。

### 12.5 ir-downgrade 是过渡件，必须标注

它存在的唯一理由是让 shadow compare 能在同一个 Analyzer 上做。

**文件头必须写明 Phase 2 删除。** 不标注的话，Phase 2 时它会被当成正常模块保留下来，形成永久的双模型。

**且不得在其中加任何推断逻辑**——只做结构转换。加了推断，它就变成了第二个 analyzer。

### 12.6 Phase 1 不让格子变绿

再强调一次：Phase 1 只交付基础设施。

**捕获到了 ≠ 能正确参数化。** 新捕获到的 contenteditable 编辑动作，Analyzer 暂时还不知道该怎么推断它的参数类型——那是 Phase 2 的 ValueLineage。

所以 Phase 1 之后，很多格位会从「静默丢失」变成「明确的 TODO」。**这就是本阶段的成功。**

### 12.7 v2.0 约束继续有效

| 约束 | 相关 |
|---|---|
| **C9** 浏览器侧零依赖 | recorder probe 与 state 采集 |
| **C11** 落盘前统一脱敏 | `innerHTML` / `textContent` / `affected` 全部要过 sanitize |
| **C15** 关联用 requestTs | 不变 |
| **C24** 通用化 | 捕获逻辑不得出现框架类名、业务字段名 |
| **C25** 用户动作可追溯 | IR 的 `effects.requestIds` 承载 |
| **C27** 分析器容错 | `ir-downgrade` 遇到无法转换的动作应降级而非崩溃 |

### 12.8 不要扩范围

发现值得做但不在本阶段的，**记录在报告「建议」段落**，标注归属 Phase 2 还是 Phase 3，不要实现。

---

## 13. 一句话总结

> Phase 0 让所有失败变得响亮，但没有减少失败的数量。
> Phase 1 从根上改掉失败最主要的来源：**把「白名单决定记不记」换成「无条件记录 + 观察状态变化」**。
>
> 判据只有一条：**有没有任何一处代码，因为"没认出来"而不记录？**
> 有，就是白名单换了位置。

---

**文档结束**
