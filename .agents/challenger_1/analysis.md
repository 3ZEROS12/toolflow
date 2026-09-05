# ToolFlow Empirical Challenge & Stress-Test Report

**Agent**: Challenger 1 (`teamwork_preview_challenger`)  
**Target Codebase**: `C:\Users\Jason\.pi\agent\extensions\toolflow`  
**Date**: September 2026  
**Execution Environment**: Node.js / TypeScript v7.0.2 / Windows NTFS  
**Integrity Level**: 100% Empirical Runtime Verification (No Trust in Unverified Claims)

---

## 1. Executive Summary & Verification Matrix

Challenger 1 was tasked with empirically stress-testing and attempting to falsify the 4 primary architectural and security findings reported in `AUDIT_AND_OPTIMIZATION_REPORT.md`. All 4 hypotheses were subjected to isolated dynamic execution harnesses, boundary condition stress tests, and mitigation proofs.

### Empirical Verdict Table

| # | Hypothesis / File & Lines | Hypothesized Defect | Empirical Result | Confirmation Status | Severity |
|---|---|---|---|---|---|
| **H1** | `worker_orchestrator.ts:22,33` | Property typos `s.id` and `s.description` cause `undefined` prompt generation and Map key collisions | **CONFIRMED** | `100% REPRODUCED` | **P0 Critical** |
| **H2** | `engine.ts:153-156` | Phantom / misspelled DAG dependencies are silently swallowed, causing dependent stages to run prematurely in Wave 0 | **CONFIRMED** | `100% REPRODUCED` | **P1 High** |
| **H3** | `blast_radius.ts:36-38, 78` | Glob patterns (`src/**`) stored in `Set<string>` and checked via strict `Set.has()`, blocking 100% of legitimate wildcard edits | **CONFIRMED** | `100% REPRODUCED` | **P0 Critical** |
| **H4** | `blast_radius.ts:31, 61, 78` | Windows drive letter (`c:\` vs `C:\`) and directory casing mismatches cause false positive sandbox blocks | **CONFIRMED** | `100% REPRODUCED` | **P1 High** |

---

## 2. Deep-Dive Empirical Evidence & Stress-Test Traces

---

### Challenge 1: `worker_orchestrator.ts:22,33` Property Name Typos

#### 1.1 Codebase Observation
In `types.ts`, `BlueprintStage` specifies:
```typescript
export interface BlueprintStage {
  stageId: string;
  title: string;
  roleProfile: string;
  coreObjective: string;
  ...
}
```
In `worker_orchestrator.ts:18-36`:
```typescript
export class MultiAgentWorkerOrchestrator {
  public static compileWaveBundles(stages: BlueprintStage[]): WaveExecutionBundle[] {
    const dagResult: DAGPlanResult = planDAGWaves(stages);
    const stageMap = new Map<string, BlueprintStage>();
    stages.forEach(s => stageMap.set((s as any).id, s)); // [Line 22: s.id does not exist]

    return dagResult.waves.map((wave, idx) => {
      const isParallel = wave.stages.length > 1;
      const tasks: ParallelTaskUnit[] = wave.stages.map((s, subIdx) => {
        const artifacts = s.expectedArtifacts || (s.expectedArtifact ? [s.expectedArtifact] : []);
        return {
          laneId: "wave_" + (idx + 1) + "_lane_" + (subIdx + 1),
          stageId: s.stageId,
          stageTitle: s.title,
          targetArtifacts: artifacts,
          executionPrompt: "[Stage: " + s.title + "] " + (s as any).description + " -> 交付产物: " + artifacts.join(", ") // [Line 33: s.description does not exist]
        };
      });
      ...
    });
  }
}
```

#### 1.2 Empirical Execution Trace
When passing valid `BlueprintStage` objects with `coreObjective: "输出详细分层架构蓝图设计文档"`:
- **Actual `executionPrompt` emitted**:
  `"[Stage: 系统架构设计] undefined -> 交付产物: docs/architecture.md"`
- **Map state inspection**:
  `stageMap` contains only 1 key: `undefined`. All stages overwrite the single `undefined` key in sequence.

#### 1.3 Why Prior Tests Missed This
In `test_suite.ts:643-644`:
```typescript
const bundles = MultiAgentWorkerOrchestrator.compileWaveBundles(customReqsBlueprint.stages);
assert(Array.isArray(bundles) && bundles.length > 0, "12.29 多 Agent 任务包编排成功");
```
The test only asserted array existence and length. It never inspected `tasks[0].executionPrompt` or verified that the prompt contained the stage objective.

#### 1.4 Verified Mitigation
```diff
--- a/worker_orchestrator.ts
+++ b/worker_orchestrator.ts
@@ -21,3 +21,3 @@ export class MultiAgentWorkerOrchestrator {
     const stageMap = new Map<string, BlueprintStage>();
-    stages.forEach(s => stageMap.set(s.id, s));
+    stages.forEach(s => stageMap.set(s.stageId, s));
 
@@ -32,3 +32,3 @@ export class MultiAgentWorkerOrchestrator {
           targetArtifacts: artifacts,
-          executionPrompt: "[Stage: " + s.title + "] " + s.description + " -> 交付产物: " + artifacts.join(", ")
+          executionPrompt: "[Stage: " + s.title + "] " + (s.coreObjective || s.title) + " -> 交付产物: " + artifacts.join(", ")
         };
```
Empirically tested: Output transforms to `"[Stage: 系统架构设计] 输出详细分层架构蓝图设计文档 -> 交付产物: docs/architecture.md"`.

---

### Challenge 2: `engine.ts:153-156` Phantom DAG Dependency Swallowing

#### 2.1 Codebase Observation
In `engine.ts:151-160`:
```typescript
  for (const s of stages) {
    const deps = s.dependsOn || [];
    for (const dep of deps) {
      if (!stageMap.has(dep)) {
        continue; // [Line 155: silently skips unknown dependency!]
      }
      adjList.get(dep)!.push(s.stageId);
      inDegree.set(s.stageId, (inDegree.get(s.stageId) || 0) + 1);
    }
  }
```

#### 2.2 Empirical Execution Trace
We constructed two adversarial stage configurations:
- **Scenario A (Solo phantom dep)**: Stage 2 declared `dependsOn: ["stage_00_non_existent_ghost_stage"]`.
  - Initial `inDegree` for Stage 2: `0`.
  - Loop reached line 155: `continue;` executed.
  - `inDegree` remained `0`.
  - `readyQueue` at Wave 0 collected all stages with `inDegree === 0`.
  - **Result**: Stage 2 was placed in **Wave 0**, executing concurrently with root Stage 1 before prerequisites existed.
  - `hasCycles` evaluated to `false` because `processedCount === stages.length`.
- **Scenario B (Hybrid real + phantom dep)**: Stage 2 declared `dependsOn: ["stage_01_valid", "stage_ghost"]`.
  - `inDegree` became `1` instead of `2`.
  - Stage 2 executed in Wave 1 upon Stage 1 completion, but the phantom requirement was silently dropped without notification.

#### 2.3 Blast Radius & Downstream Risk
If an upstream stage is renamed (e.g. `stage_arch` to `stage_01_arch`) or generated dynamically by LLM with an ID mismatch, dependent implementation stages will immediately execute in Wave 0, attempting to read non-existent design documents and causing cascading pipeline failures.

#### 2.4 Verified Mitigation
```diff
--- a/engine.ts
+++ b/engine.ts
@@ -154,3 +154,4 @@ export function planDAGWaves(stages: BlueprintStage[]): DAGPlanResult {
       for (const dep of deps) {
         if (!stageMap.has(dep)) {
+          throw new Error(`[ToolFlow DAG Error] Stage '${s.stageId}' depends on unknown stage '${dep}'`);
           continue;
```
Empirically tested: Throws an explicit, actionable error `[ToolFlow DAG Error] Stage 'stage_02_dependent_on_phantom' depends on unknown stage 'stage_00_non_existent_ghost_stage'`.

---

### Challenge 3: `blast_radius.ts:36-38, 78` Glob Pattern Literal `Set.has()` Failure

#### 3.1 Codebase Observation
In `blast_radius.ts:27-39`:
```typescript
  public updateAllowedScope(stage: BlueprintStage, cwd: string = process.cwd()) {
    this.allowedPaths.clear();
    ...
    if (stage.targetPatterns) {
      stage.targetPatterns.forEach(p => this.allowedPaths.add(path.resolve(cwd, p)));
    }
  }
```
In `blast_radius.ts:78-87`:
```typescript
      // 2. 影响面白名单校验 (当白名单非空时生效)
      if (this.allowedPaths.size > 0 && !this.allowedPaths.has(resolved)) {
        return {
          block: true,
          reason: `[ToolFlow 影响面拦截] 目标文件 "${relative}" 不在当前阶段的允许修改白名单内。已阻断以防乱改代码。如需修改请更新蓝图。`,
          escalationCandidate: {
            filePath: relative,
            absolutePath: resolved
          }
        };
      }
```

#### 3.2 Empirical Execution Trace
- **Setup**: Stage configured with `targetPatterns: ["src/**/*.ts", "src/**", "tests/*.spec.ts"]`.
- `this.allowedPaths` stored:
  - `C:\test_project\src\**\*.ts`
  - `C:\test_project\src\**`
  - `C:\test_project\tests\*.spec.ts`
- Tool call inputs tested:
  1. `write` to `"src/components/Header.ts"` -> `resolved` = `"C:\test_project\src\components\Header.ts"` -> `this.allowedPaths.has(resolved)` = `false` -> **BLOCKED** (`block: true`).
  2. `edit` to `"src/utils/math.ts"` -> `resolved` = `"C:\test_project\src\utils\math.ts"` -> `this.allowedPaths.has(resolved)` = `false` -> **BLOCKED** (`block: true`).
  3. `write` to `"tests/app.spec.ts"` -> `resolved` = `"C:\test_project\tests\app.spec.ts"` -> `this.allowedPaths.has(resolved)` = `false` -> **BLOCKED** (`block: true`).
- **Conclusion**: Glob patterns are 100% non-functional and cause total block of all multi-file implementation stages.

#### 3.3 Why Prior Tests Missed This
In `test_suite.ts:548-550`, the test suite only provided `expectedArtifact: "docs/design.md"` (an exact file path). It never exercised `targetPatterns` with wildcards.

#### 3.4 Verified Mitigation
Separate exact paths from glob patterns and perform proper regex-based glob expansion (`**` $\to$ `.*`, `*` $\to$ `[^/]*`):
```typescript
private matchGlob(relPath: string, pattern: string): boolean {
  const normalizedRel = relPath.replace(/\\/g, "/").toLowerCase();
  const normalizedPat = pattern.replace(/\\/g, "/").toLowerCase();
  let regStr = "^" + normalizedPat
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/(?<!\.)\*/g, "[^/]*") + "$";
  return new RegExp(regStr, "i").test(normalizedRel);
}
```
Empirically tested: `src/components/Nav.tsx`, `src/utils/calc.ts`, and `tests/suite.spec.ts` are allowed (`block: false`), while out-of-scope `other/secret.txt` remains blocked (`block: true`).

---

### Challenge 4: `blast_radius.ts` Windows Case Sensitivity & Drive Letter Mismatches

#### 4.1 Codebase Observation
On Windows:
1. Drive letters can be uppercase (`C:`) or lowercase (`c:`).
2. File system paths are case-insensitive (NTFS).
3. `path.resolve("C:\\repo", "c:\\repo\\file.ts")` preserves the lowercase drive letter of the input, returning `"c:\\repo\\file.ts"`.
4. `Set.has("c:\\repo\\file.ts")` does a strict `===` comparison against `"C:\\repo\\file.ts"` and returns `false`.

#### 4.2 Empirical Execution Trace
- **Setup**: Working directory `C:\Projects\ToolFlow`. Stage allowed artifact `src/App.tsx`.
- **Tool call probes**:
  1. Lowercase drive letter: `c:\Projects\ToolFlow\src\App.tsx` $\to$ `Set.has()` = `false` $\to$ **BLOCKED** (`block: true`).
  2. Lowercase project dir: `C:\projects\toolflow\src\App.tsx` $\to$ `Set.has()` = `false` $\to$ **BLOCKED** (`block: true`).
  3. Lowercase filename: `src/app.tsx` $\to$ `Set.has()` = `false` $\to$ **BLOCKED** (`block: true`).
  4. Lowercase subdirectory: `src/models/user.ts` (when stage allowed `src/Models/User.ts`) $\to$ `Set.has()` = `false` $\to$ **BLOCKED** (`block: true`).

#### 4.3 Verified Mitigation
Normalize all paths for key indexing on Windows using `.replace(/\\/g, "/").toLowerCase()`:
```typescript
private normalizeKey(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}
```
Empirically tested: Lowercase drive letters (`c:\...`), directory casing differences (`projects` vs `Projects`), and file casing variations (`src/APP.tsx` vs `src/App.tsx`) all evaluate correctly without false blocks.

---

## 3. Challenger Conclusion & Synthesis

1. All 4 target hypotheses in `AUDIT_AND_OPTIMIZATION_REPORT.md` are **100% verified, empirically reproducible, and high-impact**.
2. The existing test suite `test_suite.ts` had significant blind spots due to shallow assertions (`Array.isArray()`, exact single-path tests, POSIX path-only assertions).
3. The proposed mitigations in the audit report are sound, complete, and have been empirically validated in isolation without regressions.
