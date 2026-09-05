# Handoff Report - explorer_engine_1

**Task**: Line-by-Line Inspection & Audit of `engine.ts`, `state.ts`, `taxonomy.ts`, `worker_orchestrator.ts`, and `degradation_matrix.ts`  
**Agent**: `explorer_engine_1` (Explorer / Investigator)  
**Recipient**: `orchestrator_2` / `worker_synthesis_1`  
**Date**: 2026-09-02  
**Artifact Path**: `C:\Users\Jason\.pi\agent\extensions\toolflow\.agents\explorer_engine_1\analysis.md`  

---

## 1. Observation

During our prosecutorial-grade line-by-line inspection of the 5 target files, we observed the following specific code patterns, line numbers, and tool behaviors:

1. **`state.ts:436-441, 462, 481, 511, 567`**:
   - On verification failure, `state.retryCount = (state.retryCount || 0) + 1` is executed, and if `>= 3`, `state.status = "healing_failed_circuit_break"`.
   - `saveSessionStateToFile(cwd)` is NOT called in any of these failure paths (only on line 553 on success).
   - In `index.ts:340`, every turn starts with `loadPersistedSessionState()`, which reads `.pi/blueprint_state.json` from disk (where `retryCount: 0`).

2. **`state.ts:396-402`**:
   - `const artifactPath = stage.expectedArtifact;`
   - `let fullPath = path.isAbsolute(artifactPath) ? artifactPath : path.resolve(cwd, artifactPath);`
   - `const baseName = path.basename(artifactPath);`
   - When `stage.expectedArtifact` is undefined (e.g. multi-artifact schema), `path.isAbsolute(undefined)` throws `TypeError: The "path" argument must be of type string. Received undefined`.

3. **`worker_orchestrator.ts:27`**:
   - `const artifacts = s.expectedArtifacts || (s.expectedArtifact ? [s.expectedArtifact] : []);`
   - When `s.expectedArtifacts` is `[]`, `Boolean([]) === true` in JS, so `artifacts` evaluates to `[]`, discarding `s.expectedArtifact`.

4. **`index.ts:369` / `degradation_matrix.ts:133-168` / `state.ts:593`**:
   - `index.ts:369` calls `degradationMatrix.resolvePrunedToolsForStage(nextStage.stageId, nextStage.allowedTools)` passing `"stage_1_design"`, but `resolvePrunedToolsForStage` expects strict `"design"` / `"architecture"`, falling through to `default:` (\"code\").
   - `applyToolScoping(pruned.allowedTools, pi)` calls `computeStageTools()` in `state.ts:593`, which unconditionally re-adds `BASELINE_TOOLS = ["read", "grep", "find", "bash", "powershell"]`, nullifying blocked tools.

5. **`engine.ts:147-151, 199-210`**:
   - `planDAGWaves(stages)` loops over `stages` and sets `inDegree.set(s.stageId, 0)`. Duplicate stage IDs cause `inDegree.size < stages.length`, making `processedCount < stages.length` evaluate to `true` falsely.
   - On real cycles, `planDAGWaves` collapses all stages into a single sequential wave `[{ waveIndex: 0, stages, isParallel: false }]` without error signaling.

6. **`engine.ts:889, 935`**:
   - `synthesizeBlueprint` takes `selectedPlan: "A" | "B" = "A"`, but line 935 ignores `selectedPlan` and checks `userDecisions.delivery_strategy?.includes("agile")`, overriding Plan B with Plan A.

7. **`engine.ts:67`**:
   - `previewCommands: [pkgMgr === "uv" ? `uv run python ${srcDir}/main.py` : `python ${srcDir}/main.py`]` evaluates to `python /main.py` (root filesystem) when `srcDir` is `""`.

8. **`worker_orchestrator.ts:19-22`**:
   - `maxConcurrency: number = 4` is accepted in `compileWaveBundles` but never used.
   - `const stageMap = new Map<string, BlueprintStage>()` is populated and never read.

9. **`taxonomy.ts:337`**:
   - `path.join(NPM_MODULES_PATH, raw, "package.json")` fails on Windows when `raw` is `"npm:pi-rewind"` due to invalid colon character.

10. **`taxonomy.ts:424-492, 148, 171`**:
   - `deepAnalyzeTaxonomyWithLLM` has 0 callers in repository.
   - `activeModifiedPaths` is initialized to empty array and never populated.

---

## 2. Logic Chain

1. **From Observation 1 to Livelock Conclusion**:
   - In multi-turn chat sessions, the extension hook `turn_end` calls `loadPersistedSessionState()` at the start of every turn.
   - Because failure branches in `verifyStageArtifacts` omit `saveSessionStateToFile()`, the disk JSON never records `retryCount: 1` or `retryCount: 2`.
   - Therefore, `loadPersistedSessionState()` continuously wipes the in-memory `retryCount` back to `0` on every subsequent turn.
   - Deduction: The circuit breaker can never trip under real multi-turn usage; it enters an infinite livelock retry loop.

2. **From Observation 2 to Crash Conclusion**:
   - `BlueprintStage` schema allows `expectedArtifacts?: string[]`. When only `expectedArtifacts` is set, `stage.expectedArtifact` is `undefined`.
   - `path.isAbsolute(undefined)` throws an uncaught `TypeError` in Node.js, crashing the verification lifecycle.

3. **From Observation 3 to Deliverable Loss Conclusion**:
   - In JS, `[]` is truthy. In `s.expectedArtifacts || [s.expectedArtifact]`, if `expectedArtifacts` is an initialized empty array, the expression evaluates to `[]`.
   - Deduction: Multi-agent tasks receive empty artifact target prompts and fail downstream delivery contracts.

4. **From Observation 4 to Tool Pruning Bypass Conclusion**:
   - Strict switch-case on `stageKind` in `resolvePrunedToolsForStage` fails when given stage IDs like `"stage_1_design"`.
   - Unconditional union with `BASELINE_TOOLS` in `applyToolScoping` re-introduces `bash` and `powershell` even when blocked.
   - Deduction: Tool privilege restriction is non-functional.

5. **From Observation 5 & 6 to Blueprint Synthesis Flaws Conclusion**:
   - Duplicated stage IDs corrupt in-degree count vs stage count, falsely flagging cycles.
   - Disregarding `selectedPlan` prevents users from choosing Plan B when default agile options are selected.

---

## 3. Caveats

- **UI & TUI Modules**: `ui.ts` was not in the direct primary scope of this explorer, though its interactions with `selectedPlan` and `renderValueReceipt` were traced.
- **Dehydrator & Blast Radius**: `dehydrator.ts` and `blast_radius.ts` are inspected by dedicated explorers; their integrations with `engine.ts` were checked for interface compatibility.
- **Test Coverage Blindspots**: Current unit tests in `test_suite.ts` test single-pass in-memory verification without simulating `loadPersistedSessionState()` across turns, which is why the livelock bug escaped automated test detection.

---

## 4. Conclusion

The core architecture is conceptually robust, but suffers from **critical state desynchronization** (unpersisted retryCount in `state.ts`), **type safety boundary oversights** (undefined artifact path crash), **JS truthiness bugs** in worker dispatch, and **subsystem linkage gaps** between tool pruning and tool scoping.

We recommend executing the prioritized remediation plan detailed in `analysis.md` across `state.ts`, `worker_orchestrator.ts`, `engine.ts`, `taxonomy.ts`, and `degradation_matrix.ts`.

---

## 5. Verification Method

The Worker can independently verify all claims and fixes using the following commands and assertions:

1. **Type Soundness Check**:
   ```powershell
   npx tsc --noEmit
   ```
   Must exit with code 0.

2. **Full Regression Test Matrix**:
   ```powershell
   npm test
   ```
   Must pass all 14 modules (80+ test cases).

3. **E2E Sandbox Test**:
   ```powershell
   npx tsx sandbox_e2e.ts
   ```
   Must complete cleanly with 0 leaked artifacts.

4. **Multilang Monorepo Stress Test**:
   ```powershell
   npx tsx monorepo_multilang_stress.ts
   ```
   Must pass all 4 complex monorepo scenarios.

5. **Specific Reproduction Assertions to Add to Test Suite**:
   - Multi-turn state reload asserting `retryCount` increments across turns after failed verification.
   - Verification with `expectedArtifact: undefined` and `expectedArtifacts: ["a.txt"]` asserting no `TypeError`.
   - `worker_orchestrator.compileWaveBundles` with `expectedArtifacts: []` and `expectedArtifact: "main.ts"` asserting `targetArtifacts` contains `"main.ts"`.
   - `synthesizeBlueprint` with `selectedPlan: "B"` asserting 5 stages generated.

