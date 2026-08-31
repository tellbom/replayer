# Phase 2 Dataflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Analyzer consume Canonical IR directly, model every parameter with ValueLineage, and execute only explicitly planned value carriers.

**Architecture:** Canonical capture remains the evidence source. Analyzer converts CanonicalAction and RecordedRequest evidence into lineage-aware parameters and explicit carriers without a legacy structural bridge. Replayer validates and executes the frozen plan; it never invents a carrier at runtime.

**Tech Stack:** TypeScript, npm workspaces, Zod, Vitest, Playwright, browser-injected dependency-free TypeScript.

**Spec:** `docs/history/phase2/DSH-Phase2-Dataflow.md`

## Global Constraints

- Do not modify `packages/locator/src/recorder-probe.ts` or otherwise change the legacy recorder path.
- Do not weaken any Phase 0 Safety Gate.
- Do not add framework, fixture, endpoint, business-field, or authentication-product rules under `packages/*`.
- Do not change the frozen Canonical Action IR structure except the approved SemanticTarget capture timing fix.
- Do not simplify existing `e2e/matrix/` fixture shapes; additional independent shapes are allowed.
- Derive page values from existing `domMutations`; do not broaden `after.affected` to whole-page text observation.
- Stop after Task 1 and report. If action splitting is a targetKey defect, wait for adjudication.
- Stop after Task 2 and report replayable matrix count. If fewer than 8 of 19 are replayable, analyze each failure and wait before Task 3.
- Data correctness is proven by the service's stored record, never HTTP 200 or `ok=true` alone.

---

### Task 1: Phase 2-0 canonical identity timing and settle boundary

**Files:**
- Modify: `packages/locator/src/canonical-recorder-probe.ts`
- Modify: `packages/core/src/constants.ts`
- Create: `e2e/phase2-recorder-boundary.spec.ts`
- Create: `docs/DSH-Phase2-Dataflow-执行报告.md`

**Interfaces:**
- Consumes: existing `PendingAction`, `SemanticTarget`, `CANONICAL_CAPTURE`.
- Produces: immutable `PendingAction.semanticTargetAtStart`; one CanonicalAction for one delayed pointer sequence on a stable target.

- [x] **Step 1: Write the self-changing target regression test**

```ts
test('records the accessible name observed at pointerdown when the button renames itself', async ({ page }) => {
  await installCanonicalProbe(page, 40);
  await page.setContent('<button aria-label="＋ 华东" onclick="this.setAttribute(\'aria-label\', \'－ 华东\')">toggle</button>');
  await page.getByRole('button', { name: '＋ 华东' }).click();
  await flushCanonical(page);
  expect(actions.find((action) => action.kind === 'activate')?.target?.accessibleName).toBe('＋ 华东');
});
```

- [x] **Step 2: Run the test and verify RED**

Run: `npx playwright test e2e/phase2-recorder-boundary.spec.ts --workers=1`

Expected: target is `－ 华东` on the unmodified Phase 1 code.

- [x] **Step 3: Capture SemanticTarget with before-state**

```ts
interface PendingAction {
  semanticTargetAtStart: Record<string, unknown>;
}

// New pending action:
semanticTargetAtStart: semanticTarget(target),

// Emitted action:
target: action.semanticTargetAtStart,
```

- [x] **Step 4: Write and run the settle-split reproducer**

The test dispatches `pointerdown`, crosses the configured settle boundary, then dispatches `pointerup` and `click` on the exact same Element. It records action count, target evidence, timestamps, and raw event sequences. It must first reproduce two actions on Phase 1 code.

- [x] **Step 5: Classify and minimally fix timing if targetKey is stable**

If both fragments have the same targetKey, classify as `(a) timing`. Keep a recently closed action for a named merge-grace duration and upsert it when the same Element/targetKey receives the complementary pointer tail. Do not merge two complete click sequences.

```ts
export const CANONICAL_CAPTURE = {
  mutationSettleMs: 800,
  pointerMergeGraceMs: 250,
  maxAffected: 20,
  maxInnerHTMLLength: 8192,
} as const;
```

If the keys differ for the same Element, classify as `(b) targetKey defect`, write evidence to the report, and stop without implementing a new identity scheme.

- [x] **Step 6: Verify Task 1 and write stop-point evidence**

Run:

```powershell
npm run build --workspace @dsh/locator
npx playwright test e2e/phase2-recorder-boundary.spec.ts e2e/phase1-canonical-recorder.spec.ts --workers=1
npm test -- --run packages/recorder/src/canonical.test.ts
```

Record the pre-click accessible name, split reproduction condition, classification, fix, and legacy-path diff count in the execution report. Stop and report to the user.

### Task 2: Analyzer direct Canonical IR consumption and C5 resilience

**Files:**
- Delete: `packages/analyzer/src/ir-downgrade.ts`
- Delete: `packages/analyzer/src/ir-downgrade.test.ts`
- Modify: `packages/analyzer/src/index.ts`
- Modify: `packages/analyzer/src/correlate.ts`
- Modify: `packages/analyzer/src/params.ts`
- Modify: `packages/analyzer/src/preflight.ts`
- Modify: `packages/analyzer/src/draft.ts`
- Modify: `packages/recorder/src/session.ts`
- Modify: `packages/recorder/package.json`
- Test: `packages/analyzer/src/draft.test.ts`
- Test: `packages/analyzer/src/params.test.ts`
- Test: `packages/analyzer/src/correlate.test.ts`
- Test: `e2e/matrix/matrix.spec.ts`

**Interfaces:**
- Consumes: `RecordSession.canonicalActions` for canonical sessions and `RecordSession.actions` only for legacy sessions.
- Produces: Analyzer steps directly from `CanonicalAction`; canonical session `actions` remains empty.

- [x] **Step 1: Add failing direct-IR naming and binding tests**

Use literal CanonicalAction fixtures with accessibleName, labelText, name, before/after, affected, enumOptions, raw events, and requestIds. Assert human names and request leaf templates; never construct expected output with Analyzer helpers.

- [x] **Step 2: Add five malformed-input tests for C27/C5**

Cover missing target, null-like accessible name from untyped input, missing before/after, empty value, and malformed enum evidence. Each must return a draft, retain the action as a step or diagnostic note, and throw no ZodError.

- [x] **Step 3: Verify RED**

Run: `npx vitest run packages/analyzer/src/draft.test.ts packages/analyzer/src/params.test.ts packages/analyzer/src/correlate.test.ts`

Expected: Canonical actions are ignored or produce fallback names; malformed C5 input throws.

- [x] **Step 4: Introduce an internal normalized Analyzer view without recreating RecordedAction**

```ts
interface AnalyzedAction {
  actionIdx: number;
  kind: CanonicalAction['kind'];
  target?: SemanticTarget;
  value?: string | string[] | boolean;
  before?: ObservableState;
  after?: ObservableState;
  requestIds: string[];
  rawEventTypes: string[];
}
```

This is an Analyzer view over IR evidence, not a public compatibility contract and not a legacy downgrade.

- [x] **Step 5: Generate steps for key and unknown actions**

`key` emits a keyboard UI action using recorded semantic key evidence. `unknown` emits a replayable click/edit only when raw evidence and target make the operation unambiguous; otherwise it emits a non-executable diagnostic step plus `_notes` containing `TODO_UNRESOLVED`.

- [x] **Step 6: Remove the bridge and canonical action derivation**

Delete bridge files/exports/imports. In recorder, canonical callbacks update only `canonicalActions`; `actions` is populated only when `recorderPath === 'legacy'`. Remove recorder→analyzer package dependency.

- [x] **Step 7: Replace shadow compare with independent count evidence**

Remove the Phase 1 structural shadow test. Add/report a harness that records the same matrix cells once with legacy and once with canonical and prints independent action counts without aligning structures.

- [x] **Step 8: Verify Task 2 and enforce the second stop point**

Run Analyzer unit tests, build, constraints, Phase 0/1 focused E2E, and the 19-cell matrix replay. Report replayable count and a concrete cause for every unrecovered cell. If count is below 8, stop before ValueLineage.

### Task 3: ValueLineage model, naming, cardinality, enum, derived and environment

**Files:**
- Create: `packages/core/src/lineage.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/schema.ts`
- Create: `packages/analyzer/src/lineage.ts`
- Create: `packages/analyzer/src/lineage.test.ts`
- Modify: `packages/analyzer/src/params.ts`
- Modify: `packages/analyzer/src/draft.ts`
- Modify: `packages/replayer/src/channel-ui.ts`
- Test: `packages/core/src/schema-template.test.ts`
- Test: `e2e/matrix/matrix.spec.ts`

**Interfaces:**
- Produces: `ValueLineage`, `ValueSource`, `ValueRepresentation`, `LineageIdentity` exactly as frozen in the Phase 2 spec.
- Consumes later: Channel Planner consumes one lineage per parameter.

- [x] **Step 1: Add failing schema and lineage inference tests**

Tests cover different controls with equal values, naming collisions, same-name checkbox group, non-default single checkbox value, conservative enum fallback, complete DOM option map, contextual upstream-linked options, derived mutation, and environment-only request leaf.

- [x] **Step 2: Verify RED**

Run: `npx vitest run packages/analyzer/src/lineage.test.ts packages/core/src/schema-template.test.ts`.

- [x] **Step 3: Add frozen lineage types and schema**

Implement the exact source/representation/cardinality/identity model from `docs/DSH-Phase2-Dataflow.md`; no `constants` contract is added.

- [x] **Step 4: Implement source identity and eight-level naming**

Use action provenance + standard DOM semantics + locator fingerprint. Different sources remain separate; collisions receive suffixes. Request leaf name is level six. Action kind fallback always adds an unresolved diagnostic.

- [x] **Step 5: Implement checkbox cardinality and value-based distribution**

Same `name` group with more than one member becomes `multiple enum`; non-default value becomes single enum; insufficient evidence becomes single enum, never boolean. Replay checks values by the controls' recorded value, never array position.

- [x] **Step 6: Implement enum domain and contextual evidence**

Complete interaction-time DOM options can provide the domain only when independent stability evidence says static. Response mapping is stored as a static label→value table. Add a code comment distinguishing this from forbidden runtime `{{sN[0].value}}` indexing.

- [x] **Step 7: Implement derived via domMutations and environment refusal**

Use the causally owned `DomEffect.locator` as a `page-derived` source/carrier candidate. Do not broaden affected capture. DOM-invisible submit-time values become unresolved with the mandated readable note and cannot load as executable skills.

- [x] **Step 8: Verify server-stored multi-value and cross-parameter results**

Record value A, generate without manual edits, replay value B, then query the fixture service and print the stored JSON. Assert the stored set/value equals B. Also grep generated drafts for forbidden step-result numeric indexing.

### Task 4: Explicit Channel Planner and file/redirect carriers

**Files:**
- Create: `packages/core/src/carrier.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/schema.ts`
- Create: `packages/analyzer/src/channel-planner.ts`
- Create: `packages/analyzer/src/channel-planner.test.ts`
- Modify: `packages/analyzer/src/draft.ts`
- Modify: `packages/replayer/src/engine.ts`
- Modify: `packages/replayer/src/channel-ui.ts`
- Modify: `packages/replayer/src/channel-network.ts`
- Test: `packages/replayer/src/engine.test.ts`
- Create: `e2e/phase2-carriers.spec.ts`

**Interfaces:**
- Produces: `ValueCarrier` with exactly one primary carrier per parameter and optional preplanned UI recovery attached to the owning step.
- Consumes: ValueLineage and action/request/navigation causality.

- [x] **Step 1: Add failing planner invariant tests**

Assert zero carriers and duplicate carriers both fail draft validation; runtime cannot invent fallback; preplanned network→UI recovery is allowed only for `not_sent` or proven no-side-effect failure and only when every dependency has a UI carrier.

- [x] **Step 2: Add failing upload and redirect E2E**

Upload records metadata only, replays a different path with `setInputFiles`, queries stored file metadata, and verifies missing path sends no submit. Redirect tests require causal navigation on the mutating step and reject missing postcondition.

- [x] **Step 3: Verify RED**

Run planner unit tests and `e2e/phase2-carriers.spec.ts`; expected failures are missing carrier schema/runtime support.

- [x] **Step 4: Add carrier model and planner**

Implement `network-body/header/url`, `ui-fill/select/check/upload`, and `page-derived`. Each parameter has exactly one primary carrier. Any unplanned or unresolved carrier writes `TODO_UNRESOLVED`, which existing Phase 0 load guards reject.

- [x] **Step 5: Remove runtime carrier invention**

Engine may execute only the primary carrier or a recovery carrier serialized by Analyzer. Preserve four-state outcome and C12 no-retry behavior. Do not weaken merged carrier checks.

- [x] **Step 6: Implement UI upload**

Validate path existence before browser action, call Playwright `setInputFiles`, warn on recorded metadata mismatch, and never build multipart manually.

- [x] **Step 7: Fix causal redirect planning**

Set `expectsRedirect` only when a mutating request/action owns a navigation effect through actionIdx/requestIds lifecycle evidence. Such steps omit HTTP status assertions and require a postcondition. Fill steps cannot receive `expectsRedirect` merely by temporal proximity.

- [x] **Step 8: Run full A-group and carrier verification**

Rerun the complete A-group now that enum validation no longer masks the merged gate. Record that the merged carrier guard stops the unsafe path before submission.

### Task 5: Gate evidence, full regression, report, and branch commit

**Files:**
- Modify: `docs/DSH-Phase2-Dataflow-执行报告.md`
- Modify: `docs/superpowers/plans/2026-08-29-phase2-dataflow.md`

**Interfaces:**
- Produces: GLM-ready evidence and a single bounded Phase 2 branch history.

- [x] **Step 1: Audit every acceptance item**

Map V-A-1..8, V-B-1..13, V-C-1..8, and G-2.1..5 to a test command and captured result. List a specific cause for every unrecovered matrix cell.

- [x] **Step 2: Answer the ten-parameter four-question audit**

For at least ten generated parameters, report source, representation, cardinality, and carrier from serialized draft evidence.

- [x] **Step 3: Run final verification**

```powershell
npm run build
npm test
npm run check:constraints
npx playwright test --workers=1
```

Run task-file lint separately. Report existing repository-wide lint baseline separately if it remains outside task scope.

- [x] **Step 4: Verify repository boundaries**

Confirm `packages/locator/src/recorder-probe.ts` has no branch diff, framework CI passes, `ir-downgrade.ts` has zero references, no numeric step-result indexing exists, and main checkout user files were never staged or modified.

- [x] **Step 5: Commit only Phase 2 files**

```powershell
git add docs packages e2e/phase2-*.spec.ts e2e/matrix scripts package.json package-lock.json
git diff --cached --check
git commit -m "feat: implement Phase 2 dataflow planning"
```

Do not merge into `main`; hand off branch `codex/phase2-dataflow` and commit hash for user review.
