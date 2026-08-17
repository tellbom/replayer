# DSH 内网自动化 · 技术方向文档 v3（录制器 Demo 版）

> 版本：v3.0 ｜ 日期：2026-08-17
> 本文档合并并收敛 v1（调研）/ v2（平台方案），交付目标从"平台"降级为**一个可验证的录制器 Demo**
>
> **v3 的交付定义**：在公网开发环境中，做出一个能录制 Vue+Element Plus 业务流程、产出可人工修正的技能文件、并能稳定回放的**录制器 Demo**。内网验证通过后再迭代为框架。

---

## 0. 相对 v2 的收敛

| 维度 | v2（平台方案） | **v3（Demo）** |
|---|---|---|
| 交付物 | 用户自助技能平台 | **一个录制器 + N 个独立技能文件** |
| 用户 | 全公司自助创建 | **开发者手工录制、手工修正** |
| 技能生成 | 全自动参数化 | **半自动：录制器给草稿，人工改 YAML** |
| 通用性目标 | 一套引擎跑所有流程 | **录制器通用，每个业务流程各自独立，不追求跨流程复用** |
| LLM 参与 | 意图路由 + 参数抽取 + 录制辅助 | **Demo 阶段可以完全不接 LLM**（见 §1.3） |
| 开发环境 | 内网 | **公网开发 + 自建 Mock 环境，内网只做验证** |
| 周期 | 19 周 | **6 周** |

### 需要澄清的一点

> "每个业务流程都是独立的录制器"

准确说是：**录制器只有一个（通用），技能产物有 N 个（各自独立）**。

```
        ┌──────────────┐
        │  录制器（1个） │   ← 通用工具，这是你要开发的东西
        └──────┬───────┘
               │ 录一次产出一份
    ┌──────────┼──────────┬──────────┐
    ▼          ▼          ▼          ▼
 请假.yaml  加班.yaml  报销.yaml  出门条.yaml
    ↑          ↑          ↑          ↑
    └──── 各自独立，互不依赖，可单独手工修改 ────┘
               │
        ┌──────▼───────┐
        │  回放器（1个） │   ← 通用执行引擎
        └──────────────┘
```

这样区分很重要：**不追求跨流程复用的是"技能内容"，不是"工具本身"**。如果录制器也做成每个流程一份，Demo 就没有可迭代性了。

---

## 1. 核心设计：混合模式（Hybrid Mode）

### 1.1 两种通道

| 通道 | 机制 | 优势 | 局限 |
|---|---|---|---|
| **Network 通道** | 直接重放 HTTP 请求 | 毫秒级、零 token、100% 确定 | 需处理 CSRF/联动/会话；纯前端交互无对应请求 |
| **UI 通道** | 操作 DOM 元素 | 覆盖一切用户能做的事 | 慢、受渲染时序影响、需稳定定位 |

### 1.2 混合的粒度：**步骤级，不是技能级**

这是 v3 最重要的设计修正。

❌ **错误理解**：整个技能要么全走 HTTP，要么全走 UI，失败了整体降级。

✅ **正确设计**：**每一步独立选择通道**。一个技能天然就是混搭的。

以"提交加班申请"为例：

```
步骤1  导航到加班页面           → network (GET) 或 ui(navigate)
步骤2  选择"加班类型=工作日加班"  → ⚠️ 必须 UI 或 显式补调联动接口
         └─ 副作用：触发 POST /overtime/getApprover 返回审批人
步骤3  填开始/结束时间           → network（表单字段，无副作用）
步骤4  填事由                   → network
步骤5  点击提交                 → network (POST /overtime/submit)
```

**步骤 2 是关键**：它不只是"填一个字段"，它触发了一个联动请求，产出了后续步骤依赖的 `approverId`。

处理方式有两种，录制器要能识别并让人选：
- **方案 A**：这一步走 UI（点击 select，让页面自己发联动请求，再从页面读回 approverId）
- **方案 B**：这一步用 network，但**显式补一次 `getApprover` 调用**，把结果注入变量

Demo 优先做方案 B（快且稳），方案 A 作为降级。

### 1.3 Demo 阶段可以不接 LLM

录制器的产出是结构化 YAML，回放是确定性执行。**这条链路上没有必须用 LLM 的环节。**

LLM 只在两个地方有价值，都是锦上添花：
- 录制后帮忙给步骤/参数起名字（可以先手写）
- 自然语言 → 参数抽取（Demo 阶段直接传 JSON 就行）

**建议 Demo 完全不接 LLM。** 理由：少一个不确定因素，内网验证时排查问题更容易；而且这正好证明了"核心能力不依赖模型"，对内网无视觉模型的约束是个正面论据。

---

## 2. 测试环境（Mock OA）

这是 v3 新增的核心内容。**Mock 环境的质量直接决定 Demo 的可信度**——如果 mock 太干净，公网跑通到内网必崩。

### 2.1 设计原则：必须复刻痛点

Mock OA 的目的不是"能用"，而是**把内网真实 OA 的坑一个不漏地复现出来**。

| # | 必须复现的坑 | 内网真实场景 | Mock 实现 |
|---|---|---|---|
| K1 | Element Plus `el-select` 面板 `append-to-body` | 选项渲染在 `<body>` 末尾，不在 select 内 | 默认行为即是，不要关掉 |
| K2 | `el-date-picker` 面板挂 body + 格式化 | 日期控件点不中 | 用标准 date-picker，禁用直接输入 |
| K3 | `el-dialog` 遮罩动画期间拦截点击 | 弹窗按钮点了没反应 | 保留默认 300ms 动画 |
| K4 | scoped CSS 哈希属性 | `data-v-7f3a9c2e` 每次 build 变 | Vue SFC scoped style 默认行为 |
| K5 | CSS Modules 哈希 class | `_submitBtn_1x9km_12` | 部分组件用 `<style module>` |
| K6 | **字段联动异步请求** | 选类型→带出审批人 | `POST /api/overtime/approver` |
| K7 | CSRF Token | 提交必须带 token | meta 标签 + 请求头校验 |
| K8 | Session Cookie 登录态 | SSO 后的会话 | express-session |
| K9 | 表格虚拟滚动 | 目标行不在 DOM | 历史记录页用 `el-table-v2` |
| K10 | 异步渲染时序 | 页面骨架先出，数据后到 | 接口人为延迟 300–800ms |
| K11 | **Legacy 页面**（可选但建议） | JSP/ASP.NET 老系统 | 一个纯 SSR 页面带 `__VIEWSTATE` 隐藏字段 |

> **K4/K5 特别说明**：要在构建配置里让哈希**每次 build 都变**（关掉确定性 hash），这样才能验证"重新构建后技能是否还能回放"——这是你最担心的问题，必须能测。

### 2.2 技术栈

```
mock-oa/
├── frontend/                 # Vue 3 + Element Plus + Vite
│   ├── src/
│   │   ├── views/
│   │   │   ├── Login.vue
│   │   │   ├── Home.vue           # 首页，含导航
│   │   │   ├── LeaveApply.vue     # 请假申请（含 K1 K2 K3）
│   │   │   ├── OvertimeApply.vue  # 加班申请（含 K6 联动）
│   │   │   └── History.vue        # 历史记录（含 K9 虚拟滚动）
│   │   └── styles/                # 含 CSS Modules 组件
│   └── vite.config.ts             # 关闭确定性 hash
├── backend/                  # Express + express-session
│   ├── routes/
│   │   ├── auth.js
│   │   ├── leave.js
│   │   ├── overtime.js
│   │   └── legacy.js              # K11 SSR 页面
│   └── middleware/csrf.js
└── docker-compose.yml
```

### 2.3 关键接口设计

```
POST /api/login                 { username, password } → 种 session cookie
GET  /api/csrf                  → { token }（也注入到页面 meta）

GET  /api/overtime/types        → [{value:'workday',label:'工作日加班'}, ...]
POST /api/overtime/approver     { type, hours } → { approverId, approverName }
                                   ⚠️ 联动接口，K6 核心
POST /api/overtime/submit       { type, startTime, endTime, reason,
                                   approverId, _csrf } → { code:0, no:'OT-...' }

GET  /api/leave/types           → [...]
POST /api/leave/balance         { type } → { remainDays }   ⚠️ 另一个联动
POST /api/leave/submit          { ... } → { code:0, no:'LV-...' }

GET  /legacy/overtime           → SSR HTML，含 __VIEWSTATE / __TOKEN 隐藏字段
POST /legacy/overtime/submit    → form-urlencoded，校验隐藏字段
```

### 2.4 关键前端代码片段（复刻坑点）

```vue
<!-- OvertimeApply.vue —— 复刻 K1/K3/K6/K10 -->
<template>
  <el-form ref="formRef" :model="form" label-width="120px">
    <!-- K6：选择类型触发联动请求 -->
    <el-form-item label="加班类型">
      <el-select v-model="form.type" @change="loadApprover" placeholder="请选择">
        <el-option v-for="t in types" :key="t.value"
                   :label="t.label" :value="t.value" />
      </el-select>
    </el-form-item>

    <!-- K2：日期时间控件 -->
    <el-form-item label="开始时间">
      <el-date-picker v-model="form.startTime" type="datetime"
                      :editable="false" format="YYYY-MM-DD HH:mm"
                      value-format="YYYY-MM-DD HH:mm" />
    </el-form-item>

    <el-form-item label="事由">
      <el-input v-model="form.reason" type="textarea" :rows="3" />
    </el-form-item>

    <!-- 联动结果：只读展示 -->
    <el-form-item label="审批人">
      <span v-loading="loadingApprover">{{ form.approverName || '—' }}</span>
    </el-form-item>

    <el-form-item>
      <!-- K5：CSS Modules 哈希 class -->
      <div :class="$style.submitBtn" role="button" @click="openConfirm">提交</div>
    </el-form-item>
  </el-form>

  <!-- K3：弹窗动画 -->
  <el-dialog v-model="confirmVisible" title="确认提交" width="420px">
    <p>确认提交该加班申请？</p>
    <template #footer>
      <el-button @click="confirmVisible = false">取消</el-button>
      <el-button type="primary" @click="doSubmit">确定</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
async function loadApprover() {
  loadingApprover.value = true
  await sleep(500)                                  // K10 异步延迟
  const r = await api.post('/api/overtime/approver', { type: form.type })
  form.approverId = r.approverId
  form.approverName = r.approverName
  loadingApprover.value = false
}
</script>

<style module>
.submitBtn { /* CSS Modules → 编译后 class 名带哈希 */ }
</style>
```

```ts
// vite.config.ts —— 关键：让 hash 每次 build 都变，用于验证技能稳定性
export default defineConfig({
  css: {
    modules: {
      // 加入随机种子，模拟"每次构建 class 名都变"
      generateScopedName: `[local]_${Math.random().toString(36).slice(2,8)}_[hash:base64:5]`
    }
  },
  build: { rollupOptions: { output: {
    entryFileNames: `assets/[name].${Date.now()}.js`
  }}}
})
```

### 2.5 验收：Mock 必须先"能坑住人"

搭好后先做一件事：**用最朴素的 CSS 选择器写一遍自动化，确认它会失败**。

```js
// 这段代码必须失败，否则 mock 不合格
await page.click('.el-select');
await page.click('.el-select .el-option:has-text("工作日加班")');  // ❌ 找不到，面板在 body
await page.click('._submitBtn_1x9km_12');                          // ❌ 重新 build 后失效
```

失败了才说明 mock 有效。然后再用你的录制器去攻克它。

---

## 3. 基于 Playwright 的二次重构

### 3.1 复用什么，改造什么

| Playwright 能力 | Demo 中的用法 | 是否改造 |
|---|---|---|
| `chromium.launchPersistentContext` | 保存登录态，避免重复登录 | 直接用 |
| `page.route` / `page.on('request'/'response')` | 录制网络请求 | 直接用 |
| `context.addInitScript` | 注入录制探针 + 定位辅助 | 直接用 |
| `getByRole/getByLabel/getByText` | 稳定定位 | 直接用 |
| **`selectorGenerator`**（`packages/injected/src/`） | 生成稳定选择器 | **移植 + 改造**（见 3.2）|
| codegen 录制器 | 参考其录制探针实现 | 参考，不直接用 |

### 3.2 selectorGenerator 的改造点

Playwright 原生生成器已经很好（优先 role/label/text，避开哈希 class），但对 Element Plus 需要加规则：

```ts
// 新增：Element Plus 专用定位策略，优先级高于通用策略
const EL_STRATEGIES = [
  {
    // 表单控件 → 用 el-form-item 的 label 文本
    match: (el) => el.closest('.el-form-item'),
    generate: (el) => {
      const label = el.closest('.el-form-item')
        .querySelector('.el-form-item__label')?.textContent.trim()
        .replace(/[:：*\s]/g, '');
      const kind = detectControlKind(el);   // input|select|datepicker|textarea|radio
      return { strategy: 'el-form-item', label, kind };
    }
  },
  {
    // 下拉选项 → 记录它属于哪个 select（通过打开顺序关联）
    match: (el) => el.closest('.el-select-dropdown__item'),
    generate: (el) => ({ strategy: 'el-option', text: el.textContent.trim(),
                          ownerLabel: currentOpenSelectLabel() })
  },
  {
    // 弹窗内元素 → 记录弹窗标题作为 scope
    match: (el) => el.closest('.el-dialog'),
    generate: (el) => ({ strategy: 'el-dialog-scoped',
                          dialogTitle: el.closest('.el-dialog')
                            .querySelector('.el-dialog__title')?.textContent.trim(),
                          inner: generateGeneric(el) })
  },
  {
    // 表格行内按钮 → 用行内唯一文本定位行，再取列
    match: (el) => el.closest('.el-table__row'),
    generate: (el) => ({ strategy: 'el-table-cell',
                          rowAnchorText: pickRowAnchor(el.closest('.el-table__row')),
                          buttonText: el.textContent.trim() })
  }
];
```

**核心思想**：不生成 CSS 路径，生成**语义化的定位描述**。回放时由定位器解释执行。这样重新 build、class 变了也不影响。

### 3.3 定位器运行时（`el-locator.js`）

```js
// 注入到页面，供录制和回放共用
window.__DSH_LOCATOR__ = {

  // 按表单标签定位控件
  byFormItem(label, kind) {
    const norm = s => s.trim().replace(/[:：*\s]/g, '');
    const lbl = [...document.querySelectorAll('.el-form-item__label')]
      .find(l => norm(l.textContent) === norm(label));
    if (!lbl) throw new Error(`form-item not found: ${label}`);
    const item = lbl.closest('.el-form-item');
    const map = {
      input:      '.el-input__inner',
      textarea:   '.el-textarea__inner',
      select:     '.el-select',
      datepicker: '.el-date-editor input',
      radio:      '.el-radio',
      checkbox:   '.el-checkbox'
    };
    const el = item.querySelector(map[kind] || map.input);
    if (!el) throw new Error(`control not found in ${label} (${kind})`);
    return el;
  },

  // 下拉选择（处理 append-to-body）
  async selectOption(label, optionText) {
    const sel = this.byFormItem(label, 'select');
    sel.click();
    const panel = await this.waitFor(() => {
      const ps = [...document.querySelectorAll('.el-select-dropdown')]
        .filter(p => p.style.display !== 'none' &&
                     !p.classList.contains('el-select-dropdown--hidden'));
      return ps[ps.length - 1];
    }, 3000);
    const opt = [...panel.querySelectorAll('.el-select-dropdown__item')]
      .find(o => o.textContent.trim() === optionText);
    if (!opt) throw new Error(`option not found: ${optionText}`);
    opt.click();
    await this.sleep(120);           // 等 v-model 更新 + 联动请求发出
  },

  // 日期时间（避开面板，直接写值并触发响应式）
  async setDateTime(label, value) {
    const input = this.byFormItem(label, 'datepicker');
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, 'value').set;
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // Element Plus 需要回车确认
    input.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'Enter', keyCode: 13, bubbles: true }));
    await this.sleep(100);
    document.body.click();           // 关闭面板
  },

  // 弹窗内定位（等动画结束）
  async inDialog(title, fn) {
    const dlg = await this.waitFor(() =>
      [...document.querySelectorAll('.el-dialog')]
        .find(d => d.querySelector('.el-dialog__title')?.textContent.trim() === title
                && getComputedStyle(d).opacity === '1'), 5000);
    await this.sleep(200);           // 遮罩动画余量，K3
    return fn(dlg);
  },

  // 表格行内按钮
  tableRowButton(rowAnchorText, buttonText) {
    const row = [...document.querySelectorAll('.el-table__row')]
      .find(r => r.textContent.includes(rowAnchorText));
    if (!row) throw new Error(`row not found: ${rowAnchorText}`);
    const btn = [...row.querySelectorAll('button, .el-button, [role=button]')]
      .find(b => b.textContent.trim() === buttonText);
    if (!btn) throw new Error(`button not found in row: ${buttonText}`);
    return btn;
  },

  // 工具
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  async waitFor(fn, timeout = 5000, interval = 80) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try { const v = fn(); if (v) return v; } catch (e) {}
      await this.sleep(interval);
    }
    throw new Error('waitFor timeout');
  }
};
```

---

## 4. 录制器设计

### 4.1 架构

```
┌──────────────────────────────────────────────┐
│  Playwright launchPersistentContext           │
│   （headed，人工操作）                          │
│                                               │
│   ┌────────────────────────────────────────┐ │
│   │ addInitScript 注入：                     │ │
│   │  · el-locator.js（定位器运行时）          │ │
│   │  · recorder-probe.js（事件探针）          │ │
│   └────────────────────────────────────────┘ │
│                                               │
│   page.on('request'/'response')  ← 网络录制    │
└───────────────────┬───────────────────────────┘
                    │
          ┌─────────▼──────────┐
          │  录制会话（Node）    │
          │  · UI 动作流         │
          │  · 网络请求流        │
          │  · 时间戳对齐        │
          └─────────┬──────────┘
                    │ 结束录制
          ┌─────────▼──────────┐
          │  分析器              │
          │  · 过滤噪音请求      │
          │  · 动作-请求关联     │
          │  · 参数候选标注      │
          └─────────┬──────────┘
                    ▼
        ┌──────────────────────────┐
        │  skill.draft.yaml         │  ← 草稿，带 TODO 标记
        └───────────┬──────────────┘
                    │ 【人工修正】← Demo 的关键环节
                    ▼
        ┌──────────────────────────┐
        │  skill.yaml               │  ← 最终技能
        └───────────┬──────────────┘
                    ▼
              回放器执行
```

### 4.2 双通道录制

**UI 探针**（注入页面）：

```js
// recorder-probe.js
(function () {
  let openSelectLabel = null;

  function emit(action) {
    window.__DSH_RECORD__({ ...action, ts: Date.now() });  // exposeBinding
  }

  document.addEventListener('click', e => {
    const el = e.target;

    // 记录当前打开的 select（用于关联后续 option 点击）
    const selWrap = el.closest('.el-select');
    if (selWrap) {
      openSelectLabel = selWrap.closest('.el-form-item')
        ?.querySelector('.el-form-item__label')?.textContent.trim();
      return;  // select 本身的点击不单独记录
    }

    const opt = el.closest('.el-select-dropdown__item');
    if (opt) {
      emit({ type: 'select', label: openSelectLabel,
             value: opt.textContent.trim() });
      openSelectLabel = null;
      return;
    }

    emit({ type: 'click', target: window.__DSH_GEN__(el),
           text: el.textContent.trim().slice(0, 30) });
  }, true);

  document.addEventListener('change', e => {
    const el = e.target;
    if (!['INPUT','TEXTAREA','SELECT'].includes(el.tagName)) return;
    if (el.closest('.el-date-editor')) {
      emit({ type: 'datetime', target: window.__DSH_GEN__(el), value: el.value });
    } else {
      emit({ type: 'fill', target: window.__DSH_GEN__(el), value: el.value });
    }
  }, true);
})();
```

**网络录制**（Node 侧）：

```js
const NOISE = [
  /\.(js|css|png|jpg|svg|woff2?|ico|map)(\?|$)/i,
  /\/(heartbeat|ping|track|collect|analytics|log)/i,
];

page.on('response', async (res) => {
  const req = res.request();
  const url = req.url();
  if (NOISE.some(r => r.test(url))) return;
  if (req.resourceType() !== 'xhr' && req.resourceType() !== 'fetch'
      && req.method() === 'GET') return;

  session.network.push({
    ts: Date.now(),
    method: req.method(),
    url,
    headers: req.headers(),
    postData: req.postData(),
    status: res.status(),
    body: await res.text().catch(() => null),
    mutating: req.method() !== 'GET'
  });
});
```

### 4.3 动作-请求关联

规则（不需要 LLM）：

1. **时间窗关联**：请求发生在某 UI 动作后 0–2000ms 内 → 归属该动作
2. **副作用标记**：动作后有 `mutating` 请求 → 标记该动作 `hasSideEffect: true`
3. **依赖识别**：请求 B 的参数值出现在请求 A 的响应中 → `B depends on A`
4. **终态识别**：最后一个 mutating 请求 → 候选 `submitStep`

产出草稿时，把这些关系写进注释，人工一眼能看懂。

### 4.4 草稿产物示例（带 TODO 供人工修正）

```yaml
# skill.draft.yaml  —— 录制器自动生成，请人工检查所有 TODO 标记
skill:
  id: "oa_overtime_submit"          # TODO: 确认命名
  name: "提交加班申请"                # TODO: 确认
  system: "mock-oa"
  baseUrl: "http://localhost:5173"
  recordedAt: "2026-08-17T14:32:00+08:00"
  recordedBy: "dev"

params:                              # TODO: 确认参数列表与类型
  - { name: type,      type: enum,     values: [工作日加班, 周末加班, 节假日加班] }
  - { name: startTime, type: datetime, format: "YYYY-MM-DD HH:mm" }
  - { name: endTime,   type: datetime, format: "YYYY-MM-DD HH:mm" }
  - { name: reason,    type: string }

steps:

  - id: s1
    desc: "打开加班申请页"
    channel: network                 # 也可改为 ui
    network:
      method: GET
      url: "/overtime/apply"
    ui:
      action: navigate
      url: "/overtime/apply"

  - id: s2
    desc: "选择加班类型"
    # ⚠️ 录制器检测到：此动作触发了 mutating 请求，且其响应被 s5 使用
    hasSideEffect: true
    channel: network                 # TODO: 若 network 回放失败，改为 ui
    network:
      method: POST
      url: "/api/overtime/approver"
      body: { type: "{{type|enumValue}}" }
      extract:
        approverId: "$.approverId"   # 供 s5 使用
    ui:
      action: selectOption
      label: "加班类型"
      value: "{{type}}"
      waitFor:
        selector: ".el-form-item:has-text('审批人') span"
        notEmpty: true
      extract:
        approverId: "js:document.__vueApproverId"   # TODO: UI 通道取值方式待确认

  - id: s3
    desc: "填写开始时间"
    channel: merged                  # 合并到 s5 的提交请求中，不单独发请求
    ui:
      action: setDateTime
      label: "开始时间"
      value: "{{startTime}}"

  - id: s4
    desc: "填写事由"
    channel: merged
    ui:
      action: fill
      label: "事由"
      kind: textarea
      value: "{{reason}}"

  - id: s5
    desc: "提交"
    channel: network
    riskLevel: write                 # TODO: 确认是否需要执行前确认
    network:
      method: POST
      url: "/api/overtime/submit"
      headers:
        X-CSRF-TOKEN: "{{csrf}}"     # TODO: 确认 csrf 来源（见 preflight）
      contentType: json
      body:
        type: "{{type|enumValue}}"
        startTime: "{{startTime}}"
        endTime: "{{endTime}}"
        reason: "{{reason}}"
        approverId: "{{s2.approverId}}"
    ui:
      action: click
      strategy: el-dialog-scoped     # 提交会弹确认框
      dialogTitle: "确认提交"
      buttonText: "确定"
      preAction:
        action: click
        strategy: css-module
        text: "提交"

preflight:                           # 录制器检测到页面存在 CSRF
  - name: csrf
    source: "meta[name=csrf-token]@content"

assertions:                          # TODO: 确认成功判据
  - { type: httpStatus, expect: 200 }
  - { type: jsonPath, path: "$.code", expect: 0 }
  - { type: extract, name: bizNo, path: "$.no" }

# ── 录制器分析笔记（供人工参考，回放时忽略）──
_notes:
  - "s2 的响应 approverId=1023 出现在 s5 的请求体中，已自动建立依赖"
  - "共捕获 14 个请求，过滤掉 11 个静态资源/心跳，保留 3 个"
  - "检测到 el-select 使用 append-to-body，UI 通道已采用 selectOption 策略"
  - "s3/s4 未触发任何请求，已标记 channel=merged"
```

### 4.5 人工修正是设计的一部分，不是缺陷

Demo 阶段明确接受人工修正，且要**让修正变容易**：

- 草稿里所有不确定处打 `# TODO`
- `_notes` 段落写清楚录制器"为什么这么判断"
- 提供 `dsh replay skill.yaml --params params.json --dry-run` 快速验证
- 提供 `dsh diff` 对比两次录制，帮助识别哪些值是变量

---

## 5. 回放器设计

### 5.1 执行策略

```
对每个 step：
  ├─ channel == merged  → 只记录值，不执行，等待被后续 network step 引用
  ├─ channel == network → 发 HTTP 请求
  │     ├─ 成功 + 断言通过 → 下一步
  │     └─ 失败 → 若配置了 ui，降级到 ui 通道重试一次
  ├─ channel == ui      → 调 el-locator 执行 DOM 操作
  │     ├─ 成功 → 下一步
  │     └─ 失败 → 截图 + 保存 DOM 快照 + 中止，产出诊断包
  └─ channel == auto    → 先试 network，失败降级 ui
```

### 5.2 混合执行的会话统一

**关键点**：network 通道和 ui 通道**必须共用同一个浏览器会话**，否则 Cookie/CSRF 对不上。

```js
// network 步骤也在页面上下文里发，而不是用 node 的 fetch
async function execNetworkStep(page, step, ctx) {
  return await page.evaluate(async ({ method, url, headers, body, contentType }) => {
    const res = await fetch(url, {
      method,
      credentials: 'include',
      headers: {
        'Content-Type': contentType === 'json'
          ? 'application/json' : 'application/x-www-form-urlencoded',
        ...headers
      },
      body: contentType === 'json'
        ? JSON.stringify(body) : new URLSearchParams(body).toString()
    });
    const text = await res.text();
    return { status: res.status, text };
  }, resolveTemplate(step.network, ctx));
}
```

这样做同时解决了三件事：Cookie 自动带、同源无 CORS、内网迁移时行为一致。**这也是 v2 里"页面内同源执行"的直接落地。**

### 5.3 诊断包

任何失败都产出一个目录，方便排查（尤其是内网现场排查）：

```
runs/2026-08-17T14-40-12/
├── result.json          # 每步状态、耗时、通道
├── step-s2-before.png
├── step-s2-after.png
├── step-s2-dom.html     # 失败时的 DOM 快照
├── network.har
└── console.log
```

---

## 6. 公网开发 → 内网迁移

Demo 在公网 mock 上跑通，到内网必然有差异。提前列清单，迁移时逐项对照。

| 差异点 | 公网 mock | 内网真实 | 迁移动作 |
|---|---|---|---|
| 登录方式 | 表单登录 | SSO / AD 域集成认证 | 用 `launchPersistentContext` 人工登录一次；若是 Kerberos/NTLM 需配 `--auth-server-allowlist` |
| CSRF | meta 标签 | 可能是 Cookie-to-Header、可能没有 | 录制器已自动检测，看草稿 preflight 段 |
| Element Plus 版本 | 最新 | 可能是 Element UI (Vue2) | **类名差异**：`el-select-dropdown__item` 基本一致，但 Vue2 版部分类名不同，需在 el-locator 加版本适配 |
| 页面加载速度 | 本地毫秒级 | 内网可能几秒 | 所有 timeout 参数化，内网调大 |
| 接口路径 | `/api/...` | 各系统各异 | 技能 YAML 里 baseUrl + path 都可配 |
| 浏览器版本 | 最新 Chrome | 可能是老版本/国产浏览器 | 提前确认；若是 IE 内核兜底页面，Playwright 不支持，需另议 |
| 代理 | 无 | 内网代理/PAC | Playwright `proxy` 配置 |
| 网络录制 | 直连 | 可能有网关改写 | 录制时注意 Referer/Origin 头 |

**迁移验证顺序**：先只跑 UI 通道（最不依赖接口细节）→ 再录一遍真实接口 → 再启用 network 通道。

> ⚠️ **Vue2 + Element UI（非 Plus）的差异需要提前确认**。内网 OA 如果是几年前的项目，很可能是 Vue2 + Element UI 2.x。类名主体相同（`el-form-item__label`、`el-select-dropdown__item` 都在），但 `el-dialog` 结构、`append-to-body` 默认值有出入。**建议 mock 环境同时做一个 Vue2 版本页面**，成本不高，能省掉迁移期的返工。

---

## 7. Demo 边界（明确不做什么）

为了 6 周交付，以下明确排除：

- ❌ Web 管理界面 / 技能市场（用 CLI + 文件）
- ❌ LLM 意图路由（参数直接传 JSON）
- ❌ 自动参数化（给候选，人工定）
- ❌ 元素指纹自愈（失败就报错，人工改 YAML）
- ❌ 多用户 / 权限 / 审计后台（只留本地日志）
- ❌ 视觉 grounding（无 VL 模型，也不需要）
- ❌ 跨技能工作流编排
- ❌ 浏览器扩展形态（用 Playwright 独立进程）

**这些不是砍掉，是排到 Demo 之后。** v2 文档里的平台设计仍然有效，Demo 验证的是它的地基。

---

## 8. 验收标准

Demo 交付时必须能演示：

| # | 验收项 | 判定 |
|---|---|---|
| A1 | 在 mock OA 上录制"提交加班申请"全流程 | 产出 draft.yaml |
| A2 | 人工修正后回放成功 | 连续 10 次成功 ≥ 9 次 |
| A3 | **前端重新 build（class hash 全变）后，同一技能仍能回放** | ✅ 核心验证项 |
| A4 | 录制"提交请假申请"，复用同一录制器无需改代码 | 证明录制器通用 |
| A5 | network 通道跑通加班提交 | 单次耗时 < 2 秒 |
| A6 | 手动破坏一步（改按钮文案）→ 回放失败并产出诊断包 | 失败可诊断 |
| A7 | Legacy SSR 页面（含 `__VIEWSTATE`）录制回放 | 验证老系统路径 |
| A8 | Vue2 + Element UI 版本页面同样可录可放 | 降低内网迁移风险 |

**A3 是最重要的一条**，它直接回答你最担心的问题。

---

## 9. 路线图（6 周）

| 周 | 内容 | 产出 |
|---|---|---|
| **W1** | Mock OA 环境（Vue3+Element Plus 版，请假/加班/历史） | 可运行环境 + 朴素选择器失败验证 |
| **W2** | `el-locator.js` 定位器运行时 + 手写脚本跑通加班流程 | 证明定位策略有效（不含录制器）|
| **W3** | 录制器：UI 探针 + 网络录制 + 会话管理 | 能产出原始录制 JSON |
| **W4** | 分析器：噪音过滤、动作-请求关联、依赖识别 → draft.yaml | 草稿生成 |
| **W5** | 回放器：混合通道执行、模板引擎、断言、诊断包 | 端到端回放 |
| **W6** | Mock 补齐（Vue2 版 + Legacy SSR 页）、验收测试、文档 | Demo 交付 |

内网验证（W7–W8，需现场配合）：迁移清单逐项对照 → 真实 OA 录制 → 问题清单 → 决定是否进入框架阶段。

---

## 10. 任务清单（给 GPT / 编码助手）

### M · Mock 环境
- **M1** Vue3 + Element Plus + Vite 前端骨架，含登录/首页/请假/加班/历史五个页面
- **M2** 复刻坑点 K1–K10（见 §2.1 表），特别注意 K6 联动接口与 K3 弹窗动画
- **M3** Vite 配置：CSS Modules 哈希每次 build 变化
- **M4** Express 后端 + session + CSRF 中间件 + 全部接口（见 §2.3）
- **M5** Legacy SSR 页面（`__VIEWSTATE` + form POST）
- **M6** Vue2 + Element UI 2.x 版本的加班页面（迁移风险验证）
- **M7** 反向验证脚本：用朴素 CSS 选择器操作，确认会失败
- **M8** docker-compose 一键启动

### L · 定位器
- **L1** `el-locator.js`：byFormItem / selectOption / setDateTime / inDialog / tableRowButton / waitFor
- **L2** Element UI 2.x 兼容层（版本探测 + 类名映射）
- **L3** 手写脚本验证：用 L1 跑通加班全流程，连续 20 次

### R · 录制器
- **R1** Playwright 会话管理（launchPersistentContext + 登录态保存）
- **R2** `recorder-probe.js` UI 事件探针（click/change/select/datetime）
- **R3** 选择器生成器：移植 Playwright selectorGenerator + Element 策略（§3.2）
- **R4** 网络录制 + 噪音过滤
- **R5** 录制会话编排（开始/暂停/结束、时间戳对齐）
- **R6** CLI：`dsh record --url <url> --out <dir>`

### A · 分析器
- **A1** 动作-请求时间窗关联
- **A2** 副作用标记（mutating 请求归属）
- **A3** 依赖识别（响应值 → 后续请求参数）
- **A4** 参数候选标注（用户输入过的值、日期值）
- **A5** preflight 检测（CSRF / ViewState / 隐藏字段）
- **A6** draft.yaml 生成器（含 TODO 与 _notes）

### P · 回放器
- **P1** 技能 YAML Schema + 校验
- **P2** 模板引擎（`{{param}}`、`{{stepId.field}}`、过滤器如 `enumValue`/`date:fmt`）
- **P3** network 通道执行器（页面内 fetch，见 §5.2）
- **P4** ui 通道执行器（调 el-locator）
- **P5** merged 通道处理（值收集，不执行）
- **P6** 降级链 + 重试
- **P7** 断言引擎（httpStatus / jsonPath / textPresent / regex extract）
- **P8** 诊断包生成（截图 / DOM / HAR / console）
- **P9** CLI：`dsh replay <skill.yaml> --params <json> [--dry-run] [--channel ui|network]`
- **P10** `dsh diff <record1> <record2>` 辅助参数识别

### V · 验收
- **V1** A1–A8 验收用例自动化
- **V2** A3 专项：build → 回放 → build → 回放，循环 5 次
- **V3** 内网迁移清单文档（§6 表格 + 现场检查项）

---

## 附录 · 与 v1/v2 的对应关系

| v1/v2 概念 | v3 中的状态 |
|---|---|
| L0 真实 API（MCP 薄层） | 暂不涉及（部门不配合，已放弃） |
| L1 接口重放 | **→ network 通道**，Demo 核心之一 |
| L2 结构化 UI 操作 | **→ ui 通道 + el-locator**，Demo 核心之一 |
| L3 视觉 grounding | 排除（无 VL 模型） |
| L4 人工接管 | Demo 阶段简化为"失败报错 + 诊断包" |
| 技能固化 | **→ skill.yaml**，Demo 核心产物 |
| 元素指纹 + 自愈 | 简化为语义定位策略，自愈排到框架阶段 |
| 页面内同源执行 | **→ §5.2 network 通道实现方式** |
| 技能平台 / 市场 | 排到 Demo 之后 |
| 浏览器扩展形态 | 排到 Demo 之后（Demo 用 Playwright 进程） |

---

**文档结束**
