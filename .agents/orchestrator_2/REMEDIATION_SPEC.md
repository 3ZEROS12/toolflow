# ToolFlow Comprehensive Remediation Specification

## 1. Executive Summary
This document synthesizes findings from three parallel prosecutorial inspections across all 11 core modules of ToolFlow (`C:\Users\Jason\.pi\agent\extensions\toolflow`). All identified defects must be resolved directly in-place with zero regressions and validated against full type checking and the complete test matrix.

---

## 2. Module-by-Module Remediation Directives

### M1. `blast_radius.ts` (Security, Path Traversal & Wildcards)
1. **Windows DOS Reserved Device Names**:
   - Check segments for Windows reserved device names: `CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, `CONIN$`, `CONOUT$`.
   - Reject paths attempting to write to these device names (e.g. `src/nul.ts`, `aux.json`).
2. **Win32 Trailing Dots and Spaces**:
   - Normalize path segments by stripping trailing dots and spaces before checking against protected patterns (`.git.`, `package-lock.json.`, etc.).
3. **Cross-Drive Traversal Defense**:
   - On Windows, if `path.resolve(target)` is on a different drive letter from `cwd` / `workspaceRoot`, reject the access immediately.
4. **DOS 8.3 Short Filename Aliases**:
   - Add alias patterns for protected files (`GIT~1`, `ENV~1`, `CARGO~1.LOC`, `TURBO~1.JSO`, etc.).
5. **Glob Star Root Matching**:
   - Fix `matchGlob` regex compilation so that `**/*.ts` matches both root-level files (`index.ts`) and nested files (`src/foo/bar.ts`).
6. **Method Lifecycle**:
   - Ensure `BlastRadiusGuard` methods (`allowPath`, `validateFileAccess`, `isPathWithinWorkspace`) have clear lifecycles and clean exports.

### M2. `state.ts` (State Machine, Persistence & Resilience)
1. **[P0] RetryCount & Circuit Breaker Disk Persistence**:
   - In `verifyStageArtifacts`, call `saveSessionStateToFile(cwd)` in all verification failure branches when `retryCount` is incremented and when `status = "healing_failed_circuit_break"`.
   - Ensure `loadPersistedSessionState()` reads the updated `retryCount` across multi-turn sessions.
2. **[P0] Undefined `expectedArtifact` Null Safety**:
   - In `verifyStageArtifacts`, safely check `stage.expectedArtifact` (do not pass undefined to `path.isAbsolute`). Support both `expectedArtifact` and `expectedArtifacts`.
3. **[P1] Resilient Atomic File Persistence**:
   - Add retry loop (up to 3-5 retries with backoff) for `fs.renameSync` on Windows `EPERM` / `EBUSY`.
   - Always unlink `.tmp` file in a `finally` block if rename fails.
   - In `loadPersistedSessionState()`, add fallback to `.bak` file if the primary JSON file is corrupted or unreadable.
4. **[P1] Tool Scoping & Pruning Integration**:
   - In `computeStageTools` / `applyToolScoping`, ensure tools explicitly pruned/blocked by `GracefulDegradationMatrix` are NOT re-added by baseline defaults.

### M3. `engine.ts` (Kahn DAG, Blueprint Synthesis & Execution)
1. **[P1] Kahn DAG In-Degree & Cycle Detection**:
   - Deduplicate stages or validate stage ID uniqueness before building inDegree map.
   - When a cycle is detected, emit a clean, structured diagnostic error rather than silently collapsing stages into an unverified sequential wave.
2. **[P1] Blueprint Plan Selection**:
   - In `synthesizeBlueprint(req, userDecisions, cwd, selectedPlan)`, ensure `selectedPlan === "B"` generates the 5-stage Plan B blueprint without being silently overridden by `userDecisions.delivery_strategy`.
3. **[P2] Python Preview Command**:
   - When `srcDir` is empty (`""`), generate `python main.py` or `python ./main.py` instead of root `/main.py`.
4. **Clean Code & Variable Sweep**:
   - Remove unused variable allocations (e.g. unreferenced `stageMap`).

### M4. `worker_orchestrator.ts` (Worker Dispatch & Artifact Normalization)
1. **[P1] Artifact List Normalization Bug**:
   - Fix: `const artifacts = (s.expectedArtifacts && s.expectedArtifacts.length > 0) ? s.expectedArtifacts : (s.expectedArtifact ? [s.expectedArtifact] : []);`
2. **Concurrency & Execution Mode**:
   - Respect `maxConcurrency` parameter when grouping parallel stages in wave bundles.

### M5. `taxonomy.ts` (Module Resolution & Discovery)
1. **Windows Colon Path Handling**:
   - Strip/normalize `npm:` prefix before resolving `package.json` paths on Windows.
2. **Dead Code Cleanup / Connection**:
   - Ensure all taxonomy scanner helpers and discovery routines have valid callers and clear lifecycles.

### M6. `degradation_matrix.ts` (Degradation & Tool Pruning)
1. **Stage Identifier Normalization**:
   - In `resolvePrunedToolsForStage`, normalize input identifiers (accept both `stageId` like `"stage_1_design"` and `stageKind` like `"design"`).

### M7. `dehydrator.ts` (Context Dehydration & Quota Management)
1. **[P1] Inverted LRU Disk Quota Eviction**:
   - Sort run folders oldest-first (`a.mtimeMs - b.mtimeMs`) so oldest runs are evicted first when total disk space exceeds 200MB.
2. **[P1] UTF-8 Byte Size Cap**:
   - Use `Buffer.byteLength(rawLogs, "utf-8")` instead of `rawLogs.length` for the 10MB log cap.
3. **[P2] Binary File AST Protection**:
   - Skip regex AST parsing for binary file extensions (`.png`, `.jpg`, `.exe`, `.dll`, `.wasm`, `.zip`, etc.).

### M8. `memory.ts` (Memory Manager & Token Compaction)
1. **Windows Atomic Persistence**:
   - Implement retry and `.tmp` cleanup in `finally` for memory state file writing.
2. **Workspace Root Alignment**:
   - Use `this.workspaceRoot` rather than `process.cwd()` for `codebaseId`.
3. **Token Budget Enforcement**:
   - Enforce a strict token/character budget (<1,500 chars / ~500 tokens) in `getPromptContextInjection()`.

### M9. `ui.ts` (TUI & Formatting)
1. **2-Column Overview Column Alignment**:
   - In `padCol`, use `padToVisibleWidth(s, halfW)` so the separator `│` remains strictly aligned.
2. **Top Border Symmetry**:
   - Fix `topInnerFill` visible width calculation (`Math.max(0, innerWidth + 1 - titleVisW)`) so top border width matches body and bottom borders (`innerWidth + 4`).
3. **Markdown ANSI Stripping**:
   - Strip ANSI escape sequences when rendering DAG inside markdown code blocks.
4. **Unicode Surrogate Pair Safe Backspace**:
   - Use `Array.from(text).slice(0, -1).join("")` for backspace handlers in interactive prompts.

### M10. `index.ts` & `types.ts` (Subsystem Wiring & Soundness)
1. **Lifecycle Integration**:
   - Instantiate `ContextDehydrator` and connect it into the `turn_end` / stage handoff workflow.
   - Route Stage 0 through `degradationMatrix.resolvePrunedToolsForStage`.
2. **Type Cleanliness**:
   - Verify all exported types in `types.ts` are utilized and sound.

### M11. Test Suite Expansion (`test_suite.ts`)
- Add regression test module assertions covering all 14+ remediated defect cases.

---

## 3. Verification Commands
- `npx tsc --noEmit` -> 0 errors / 0 warnings.
- `npm test` -> 100% pass (all 14 modules, 120+ assertions).
- `npx tsx sandbox_e2e.ts` -> 100% pass.
- `npx tsx monorepo_multilang_stress.ts` -> 100% pass.
