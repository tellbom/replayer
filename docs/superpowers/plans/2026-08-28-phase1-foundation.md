# DSH Phase 1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce the framework-neutral Canonical Action IR as the recording truth source while preserving one-way legacy shadow comparison and every Phase 0 safety invariant.

**Architecture:** The canonical browser probe reuses the existing T-96 action identity and T-70 mutation observer, then the Node recorder sanitizes and persists canonical actions and derives legacy actions through a pure downgrade bridge. Replay uses Playwright strict/actionability semantics, multipart support is limited to reconstructable text fields, and package-level framework-specific production logic is rewritten to DOM/ARIA semantics or rejected by CI.

**Tech Stack:** TypeScript, Playwright, Vitest, esbuild browser IIFEs, Zod/YAML, npm workspaces.

**Spec:** `docs/DSH-Phase1-Foundation.md`

## Global Constraints

- Mock OA and every named portal are regression fixtures only; production decisions use browser, DOM, ARIA, HTTP, or data-flow facts.
- Reuse T-96 `actionIdx`, `activeAction`, `targetKey`, `activeWindowMs`, and `blurGraceMs`; do not introduce parallel action identity.
- Reuse the T-70 MutationObserver; do not add a second observer for canonical affected-state collection.
- `canonicalActions` is the sole canonical capture truth; `actions` is a one-way derived shadow field on canonical recordings.
- Preserve all Phase 0 `not_sent`, identity, credential, idempotency, and postcondition gates.
- New drafts must never emit deprecated `el-*` strategies.
- Production files under `packages/` must pass the framework-specific CI scanner.

---

### Task 1: Phase 0 gate corrections

**Files:**
- Modify: `packages/core/src/safety.ts`
- Modify: `packages/core/src/errors.ts`
- Modify: `packages/core/src/safety.test.ts`
- Modify: `packages/replayer/src/channel-network.ts`
- Modify: `packages/replayer/src/channel-network.test.ts`
- Modify: `packages/replayer/src/engine.ts`
- Modify: `packages/replayer/src/engine.test.ts`
- Modify: `e2e/fallback.spec.ts`

**Interfaces:**
- Produces: `classifyMultipartCarrier(value): 'none' | 'text' | 'unsupported'` and bounded executable-value traversal.

- [ ] Add failing tests proving cyclic/deep/unusual executable YAML fails with a named safety error instead of `RangeError`.
- [ ] Run the core safety tests and confirm the new cases fail against the recursive scanner.
- [ ] Implement iterative cycle/depth/type validation and rerun the tests green.
- [ ] Add failing network tests proving text-only multipart is sent as browser `FormData` while file-like/unreconstructable multipart remains `not_sent`.
- [ ] Run the replayer tests and confirm the text-only case fails because all multipart is currently rejected.
- [ ] Implement text-only browser encoding and narrow UI fallback blocking to unsupported carriers; rerun green.
- [ ] Add an E2E assertion that UI carrier retention reads the live IDL `value`/`checked` state and tag the merged defense test as long-term.

### Task 2: Canonical IR and one-way downgrade

**Files:**
- Create: `packages/core/src/ir.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/constants.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/analyzer/src/ir-downgrade.ts`
- Create: `packages/analyzer/src/ir-downgrade.test.ts`
- Modify: `packages/analyzer/src/index.ts`

**Interfaces:**
- Produces: `CanonicalAction`, `SemanticTarget`, `ObservableState`, `ElementState`, `downgradeToLegacyActions(actions)` with an `_notes` loss ledger.

- [ ] Add failing tests for activate/edit/select/check/navigate structural mapping and unknown/key/upload loss accounting.
- [ ] Run the downgrade tests and confirm missing exports fail.
- [ ] Add the IR types, named capture limits, RecordSession path fields, and pure downgrade bridge.
- [ ] Rerun core/analyzer tests green and verify no inference is present in the bridge.

### Task 3: PlaywrightCanonicalRecorder

**Files:**
- Create: `packages/locator/src/canonical-recorder-probe.ts`
- Modify: `packages/locator/src/mutation-tracker.ts`
- Modify: `packages/locator/build.mjs`
- Create: `packages/recorder/src/canonical.ts`
- Create: `packages/recorder/src/canonical.test.ts`
- Modify: `packages/recorder/src/session.ts`
- Modify: `packages/recorder/src/index.ts`
- Modify: `packages/cli/src/record.ts`
- Create: `e2e/phase1-canonical-record.spec.ts`

**Interfaces:**
- Consumes: T-96 action identity and T-70 mutation results.
- Produces: `PlaywrightCanonicalRecorder`, complete merged `raw.eventTypes`, before/after state, request/navigation effects, and selectable `recorderPath`.

- [ ] Add failing unit/E2E tests for full raw event sequences, unknown retention, edit merging, affected values, requestId linkage, navigation, sanitization, and one-path capture.
- [ ] Run focused tests and confirm canonical artifacts are absent.
- [ ] Implement the browser probe and recorder coordinator without target filtering or a second MutationObserver.
- [ ] Integrate canonical as default, derive `actions` only through the downgrade bridge, and retain explicit legacy selection.
- [ ] Rerun focused recorder and causality suites green.

### Task 4: Generic locator runtime and strict replay

**Files:**
- Replace: `packages/locator/src/el-locator.ts` with generic DOM/ARIA modules under `packages/locator/src/`
- Modify: `packages/locator/src/snapshot.ts`
- Modify: `packages/locator/src/ancestor-scope.ts`
- Modify: `packages/locator/src/mutation-tracker.ts`
- Modify: `packages/locator/src/recorder-probe.ts`
- Modify: `packages/replayer/src/channel-ui.ts`
- Modify: `packages/replayer/src/channel-ui.test.ts`
- Create: `e2e/phase1-strict-actionability.spec.ts`
- Create: `adapters/.gitkeep`

**Interfaces:**
- Produces: standard label/role/portal/dialog/listbox/table/date helpers and Playwright strict locator execution.

- [ ] Add failing native HTML and custom DOM tests for label resolution, portaled listboxes, dialog transition readiness, date IDL writes, and strict multi-match rejection.
- [ ] Run focused tests and confirm framework selectors/count prechecks or `.first()` cause expected failures.
- [ ] Rewrite helpers and observation rules to DOM/ARIA semantics, remove immediate count checks and implicit first-item selection.
- [ ] Rerun focused tests and verify strict multi-match throws before any click.

### Task 5: Framework-specific purge and dependency gates

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/schema.ts`
- Modify: `packages/analyzer/src/draft.ts`
- Modify: `packages/llm/src/heal.ts`
- Modify: `packages/cli/src/doctor.ts`
- Create: `scripts/check-no-framework-specifics.mjs`
- Create: `scripts/check-package-boundaries.mjs`
- Modify: `scripts/check-constraints.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: executable CI scanners for framework tokens, package import direction, and browser bundle imports.

- [ ] Add failing analyzer test rejecting newly generated deprecated strategies.
- [ ] Add scanner fixture mode and run deliberate violating inputs to confirm nonzero exit codes.
- [ ] Mark only frozen legacy strategy variants `@deprecated` with Phase 3 removal notes; remove all other production framework tokens from packages.
- [ ] Implement scanner exemptions only for the annotated frozen type/schema definitions and adapters.
- [ ] Implement package-boundary checks and rerun all constraint scripts green.

### Task 6: Shadow acceptance, report, and commit

**Files:**
- Create: `docs/DSH-Phase1-Foundation-验收报告.md`
- Modify: `docs/DSH-Phase1-Foundation.md` only if recording execution notes is required by its template.

**Interfaces:**
- Produces: auditable 1-0 evidence, framework inventory, method decisions, adapter status, shadow metrics, skip list, and commit evidence.

- [ ] Record equivalent legacy and canonical sessions and compare action coverage, semantic targets, replay outcome, and downgrade loss notes.
- [ ] Run unit, full E2E, build, lint, Phase 0 gates, T68-T74+T84, and existing T91-T110 acceptance.
- [ ] Run the framework scanner against an intentionally violating temporary input and record its nonzero result without leaving the violation in the tree.
- [ ] Write the full inventory and 7-4 method-by-method rationale; state that `compat.ts` did not exist and whether adapters stayed empty.
- [ ] Review `git diff` and `git status`, stage only Phase 1 files plus the user-provided Phase 1 document, commit, and report the resulting hash.
