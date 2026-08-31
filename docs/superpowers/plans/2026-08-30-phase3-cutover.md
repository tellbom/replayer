# Phase 3 Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在删除前取得 legacy 无独有能力的最后证据，然后删除双录制模型和框架兼容遗留，只保留 Canonical IR 单一路径，并交付可独立阅读的架构总览。

**Architecture:** 3-1 是不可跨越的硬门：先分别运行 legacy 与 canonical probe，以用户意图动作作为能力单位对照完整 matrix 和真实系统；只有 legacy 独有能力为 0（或逐项证明为误报）后，才能依次切默认、观察、删除。删除后 Analyzer 直接接受 Canonical IR，通用 DOM/ARIA/IDL 能力、空 `adapters/` 信号、Safety Gate 和历史设计依据全部保留。

**Tech Stack:** TypeScript 5.7、Node.js 24、Playwright、Vitest、Zod、npm workspaces、Markdown。

**Spec:** `docs/history/phase3/DSH-Phase3-Cutover.md`

**Execution status (2026-08-31): COMPLETE.** G-3.1 的 fixture/真实系统证据先于删除取得；随后在同一隔离 worktree 连续完成 Cutover。原计划中的临时 legacy warning/分段 commit 没有作为永久产物保留，等价观察证据由删除前双路径对照、删除后 19 格矩阵与最终全量回归提供；最终采用一个实现提交加一个报告定稿提交，不改变 Gate 顺序。

## Global Constraints

- 3-1 fixture 与至少一个真实系统的能力对照未通过前，不得删除或弱化 legacy。
- 真实系统登录只能由用户在浏览器中完成；登录动作不进入录制证据。
- Mock OA、真实 OA、matrix、mock-portal、mock-legacy-sys 仅是 regression fixture；`packages/*` 只能使用浏览器、DOM、HTTP 和数据流通用规则。
- 不修改既有 fixture 形态来制造通过结果，不给 downgrade 补丁，不放松任何 Safety Gate。
- `selectOption`、`setDateTime`、`inDialog`、`tableRowButton` 与 navigation settling 等通用能力必须保留。
- `adapters/` 保留 `.gitkeep` 与 README；core 不得 import adapters。
- C9、C14 长期回归不得删除。
- 展示节点观测范围只评估，不实现。
- 历史文档只归档，不删除；主检出区未提交内容不得触碰。

---

### Task 1: Freeze the pre-delete comparison contract

**Files:**
- Create: `e2e/phase3-predelete-comparison.spec.ts`
- Create: `scripts/phase3/capture-real-system.mjs`
- Create: `docs/DSH-Phase3-Cutover-执行报告.md`
- Modify: `docs/superpowers/plans/2026-08-30-phase3-cutover.md`

**Interfaces:**
- Consumes: legacy `__DSH_RECORD__`, canonical `__DSH_CANONICAL_RECORD__`, the 19 `CELLS`, and the real-system browser session after user login.
- Produces: immutable pre-delete evidence containing per-intent capture booleans, raw action counts, legacy-only items, and environment/version metadata.

- [x] **Step 1: Define capability records before touching recorder code**

In the comparison spec, define a test-only record with exact fields:

```ts
interface CaptureCapability {
  intentId: string;
  interaction: string;
  legacyCaptured: boolean;
  canonicalCaptured: boolean;
  legacyEvidence: unknown[];
  canonicalEvidence: unknown[];
}
```

Each `intentId` comes from the operation script, not from raw event count. A legacy-only capability is `legacyCaptured && !canonicalCaptured`; raw pointer/input event multiplicity is retained as evidence but never treated as an independent business capability.

- [x] **Step 2: Write the fixture comparison test and verify RED**

Add a test that runs both probes independently against all 19 existing matrix cells, writes `tmp/phase3-predelete/fixture-comparison.json`, and asserts:

```ts
expect(report.cells).toHaveLength(19);
expect(report.legacyOnly).toEqual([]);
expect(report.cells.every((cell) => cell.intents.length > 0)).toBe(true);
```

Run `npx playwright test e2e/phase3-predelete-comparison.spec.ts --grep fixture --workers=1`. The initial run must fail because the comparison harness/evidence file is not complete, not because a fixture was changed.

- [x] **Step 3: Implement the minimum fixture harness and verify GREEN**

Reuse `CELLS`, `startMatrixServer`, the shipped probe bundles and existing operation callbacks. Do not change matrix markup or interaction shape. For each cell, record legacy and canonical on separate clean pages, map emissions to the declared intent windows, and preserve unmatched raw emissions for manual attribution.

Run the focused comparison until all 19 cells have evidence. If any `legacyOnly` item remains, stop Task 1 and classify it as canonical miss, legacy false positive, or undecidable; do not continue to Task 2.

- [x] **Step 4: Prepare the real-system comparison without automating login**

The script must launch/attach a visible persistent browser, navigate to `http://localhost:5173`, wait for the user to finish authentication, then start capture only after the authenticated application shell is visible. It must exercise at least:

```text
native/Element input, radio, checkbox, date control,
portal listbox option, custom div selector, dialog action,
dynamic field, table-row action
```

Write raw evidence to `tmp/phase3-predelete/real-system-comparison.json`; never write credentials or bearer tokens.

- [x] **Step 5: Run the real-system comparison and enforce G-3.1**

Start `E:/Web/replayer-web-test/server` and `web` without altering their source or data shape. Ask the user only for the required browser login action. After login, run both probes against the same interaction list and assert `legacyOnly=[]`.

If the system cannot run or authentication cannot be completed, record the concrete limitation and stop before deletion. Fixture-only evidence is not sufficient for G-3.1.

- [x] **Step 6: Archive the hard-gate report and commit it**

Populate the fixture and real-system tables in `docs/DSH-Phase3-Cutover-执行报告.md`, including source revision, probe bundle hashes, action counts, legacy-only attribution and the G-3.1 conclusion. Commit only the task document, plan, harness and report:

```powershell
git add docs/DSH-Phase3-Cutover.md docs/DSH-Phase3-Cutover-执行报告.md docs/superpowers/plans/2026-08-30-phase3-cutover.md e2e/phase3-predelete-comparison.spec.ts scripts/phase3/capture-real-system.mjs
git diff --cached --check
git commit -m "test: archive pre-cutover recorder comparison"
```

### Task 2: Canonical default observation gate

**Files:**
- Modify: `packages/cli/src/record.test.ts`
- Modify: `packages/cli/src/record.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: G-3.1 PASS evidence.
- Produces: canonical default behavior and a temporary legacy deprecation warning used only during the observation run.

- [x] **Step 1: Write failing CLI tests**

Assert that omitting `--recorder-path` selects canonical and explicitly selecting legacy prints the exact deprecation warning from §3.1. Run the focused CLI test and observe the warning assertion fail before implementation.

- [x] **Step 2: Add the warning without changing either capture path**

Keep canonical as the default. Emit one warning only when `legacy` is explicitly requested. Update README so ordinary recording requires no path flag.

- [x] **Step 3: Run the observation regression**

Run build, unit, constraints, the 19-cell matrix, C9/C14, Phase 0/1 safety tests and full E2E. Any Safety Gate regression stops the cutover; do not proceed to deletion.

- [x] **Step 4: Commit the observation gate**

Commit the CLI test, temporary warning and README update separately so the pre-delete state remains reproducible.

### Task 3: Delete the legacy recorder model

**Files:**
- Delete: `packages/locator/src/recorder-probe.ts`
- Modify: `packages/locator/build.mjs`
- Modify: `packages/recorder/src/session.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/analyzer/src/action-view.ts`
- Modify: `packages/analyzer/src/draft.ts`
- Modify: `packages/analyzer/src/params.ts`
- Modify: `packages/cli/src/record.ts`
- Delete or rewrite: `e2e/recorder-probe.spec.ts`, `e2e/phase1-canonical-recorder.spec.ts`, and tests whose only purpose is selecting legacy

**Interfaces:**
- Consumes: archived G-3.1 evidence and a green canonical observation run.
- Produces: `RecordSession` with canonical actions as its only action truth source and a recorder with no path switch.

- [x] **Step 1: Write contract tests that describe the single-path state**

Tests must fail while `actions`, `recorderPath`, the legacy CLI flag and legacy bundle still exist. Keep behavioral tests by porting them to Canonical IR; delete only assertions whose sole subject is the removed compatibility path.

- [x] **Step 2: Remove recorder selection and legacy probe**

Delete the probe source and build entry. Make session capture unconditional on canonical. Remove the CLI option and its temporary warning after the observation commit.

- [x] **Step 3: Remove legacy action conversion from Analyzer**

Delete `fromLegacy`, `legacyKind`, `AnalyzedAction.legacy` and every legacy scope/hint branch. Preserve canonical scope, target, event sequence, request causality and navigation behavior directly from Canonical IR.

- [x] **Step 4: Remove the frozen `RecordSession.actions` contract**

Delete `actions`, `recorderPath` and temporary loss notes from the schema/types and update every fixture/test builder to emit canonical sessions. Record this as an intentional contract break with no stored-record migration.

- [x] **Step 5: Verify deletion and generic capability preservation**

Run targeted recorder/analyzer tests and grep for the removed probe bundle/path switch. Separately run the standard-semantic tests for listbox, dialog, date, table row and navigation settling to prove they were not mistaken for legacy.

- [x] **Step 6: Commit the single-path cutover**

Stage only the legacy deletion and canonical test migrations; use commit message `refactor: remove legacy recorder path`.

### Task 4: Remove framework-named compatibility strategies

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/schema.ts`
- Modify: `packages/locator/src/dom-locator.ts`
- Modify: `scripts/check-no-framework-specifics.mjs`
- Create: `adapters/README.md`
- Preserve: `adapters/.gitkeep`

**Interfaces:**
- Consumes: single canonical path from Task 3.
- Produces: no framework-named production strategy and an empty, documented adapter boundary.

- [x] **Step 1: Add failing schema/constraint assertions**

Assert all four removed strategy values fail schema parsing and the framework checker contains no `@deprecated` exception. Verify RED before deleting the branches.

- [x] **Step 2: Remove the four type/schema/runtime branches**

Delete only `el-form-item`, `el-option`, `el-dialog-scoped`, and `el-table-cell`. Keep the generic functions they formerly delegated to.

- [x] **Step 3: Remove the CI exemption and add adapter README**

Make every framework token in production fail. Add the exact adapter invariants from §5.3 while keeping the directory otherwise empty.

- [x] **Step 4: Verify and commit framework cleanup**

Run constraints, schema tests and a production grep excluding vendor/adapters/tests. Commit as `refactor: remove framework compatibility strategies`.

### Task 5: Close Phase 2 residual evidence

**Files:**
- Modify: `e2e/fallback.spec.ts`
- Modify: `e2e/matrix/cells.ts` only to add evidence-producing interaction metadata; existing markup/behavior must not change
- Modify: `docs/DSH-Phase3-Cutover-执行报告.md`

**Interfaces:**
- Consumes: current `ChannelCarrierMissingError` gate and A-group evidence.
- Produces: either a full-chain merged defense result or a proved-unreachable conclusion, plus a quantified display-node observation assessment.

- [x] **Step 1: Attempt a full merged-chain test without weakening earlier gates**

Construct legal parameters and evidence-backed label/wire mapping using standard DOM option value or recorded HTTP response evidence. The test must reach a `not_sent` network outcome and then assert:

```ts
await expect(replay(/* complete recorded skill */)).rejects.toBeInstanceOf(ChannelCarrierMissingError);
expect(requestCount).toBe(0);
expect(serverRecords).toHaveLength(0);
expect(uiSubmitCount).toBe(0);
```

If the architecture cannot produce a network step that both has a planned carrier and still depends on a merged step, stop trying to force the scenario and document why the guard is unreachable.

- [x] **Step 2: Measure display-node observation cost without product changes**

Use a disposable measurement script against matrix and the real system to compare current value-carrier count with changed text-node count per action, serialized byte estimates, observer callback duration, and sanitized text volume. Do not modify `captureObservableElements()` or any production capture constant.

- [x] **Step 3: Record recommendation and commit evidence**

Report performance/data/PII trade-offs, estimated benefit count, and a Phase 3-postponed recommendation. Confirm explicitly that display-node observation was not implemented.

### Task 6: Converge documentation and archive history

**Files:**
- Create: `docs/DSH-Architecture-Overview.md`
- Modify: `README.md`
- Modify: `docs/skill-authoring.md`
- Modify: `docs/DSH-Phase0-SafetyGate.md`
- Move with history preserved: Phase 0–3 task/execution reports into `docs/history/phase0/` through `docs/history/phase3/`
- Modify: links that point to moved documents

**Interfaces:**
- Consumes: final single-path code and all phase reports.
- Produces: a standalone maintainer overview and preserved historical rationale.

- [x] **Step 1: Inventory C1–C28 from authoritative documents**

For every constraint, quote its short canonical meaning, then classify it as `有效`, `被后续裁决取代`, or `因架构变化不再适用`. Include the replacing decision/document where applicable; do not infer missing constraints from numbering alone.

- [x] **Step 2: Write the standalone architecture overview**

Cover the recording→IR→Analyzer→ValueLineage→Channel Planner→Replay chain, C1–C28 status, unsupported boundaries, three non-negotiable principles, CI guards, and C9/C14 long-term regressions. A reader must not need a historical document to understand current behavior.

- [x] **Step 3: Update user-facing flow and boundaries**

README must show one default recording path. Skill authoring must explain derived source evidence and C16/V6 limitations. Safety Gate must retain the field-level persisted-value definition of Silent Wrong Success.

- [x] **Step 4: Archive without deleting history**

Use `git mv` only for identified phase task/report files. Preserve content and repair repository-relative links. Do not move the architecture overview, skill authoring guide, or Phase 0 Safety Gate.

- [x] **Step 5: Verify links and commit documentation**

Run a local Markdown-link checker or deterministic script over moved paths, inspect `git diff --summary` for renames, and commit as `docs: converge Phase 3 architecture guidance`.

### Task 7: Final Gate and handoff

**Files:**
- Modify: `docs/DSH-Phase3-Cutover-执行报告.md`
- Modify: `docs/superpowers/plans/2026-08-30-phase3-cutover.md`

**Interfaces:**
- Consumes: Tasks 1–6 commits.
- Produces: GLM-ready Phase 3 Gate evidence and the final branch commit range.

- [x] **Step 1: Run complete verification**

```powershell
npm run build
npm test -- --run
npm run check:constraints
npx eslint <all changed TypeScript files>
npx playwright test --workers=1
```

Also run matrix 19 cells and explicit C9/C14 filters; report every skipped E2E and highlight any core skip.

- [x] **Step 2: Run deletion and boundary greps**

Prove zero recorder-path switches, zero legacy probe references, zero deprecated framework strategies, adapters containing only `.gitkeep`/README, and all generic locator helpers still present.

- [x] **Step 3: Re-run Safety Gate accounting**

Require Silent Wrong Success=0, TODO literal submissions=0, 16/19 replayable with field-level persisted comparison, and zero unverified successes.

- [x] **Step 4: Complete the report and inspect the branch**

Fill every report field from §10, list the intentional `RecordSession.actions` contract break, display-node evaluation, unsupported boundaries, commit range and remaining limitations. Run `git diff --check`, inspect staged files, and confirm the main checkout's pre-existing changes were never staged or modified.

- [x] **Step 5: Commit final report without merging**

Commit the report/plan update, leave the isolated branch for GLM review, and do not merge or push unless explicitly requested.
