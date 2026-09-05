# Deep Code-Level Audit & Static/Runtime Risk Report
**Target Modules**: `engine.ts`, `state.ts`, `worker_orchestrator.ts`, `index.ts`, `types.ts`  
**Auditor**: DAG & Engine Auditor (`teamwork_preview_explorer`)  
**Workspace**: `C:\Users\Jason\.pi\agent\extensions\toolflow`  
**Timestamp**: 2026-09-01T21:28:00Z  

---

## Executive Summary

An exhaustive static code audit, type-safety verification, and runtime risk analysis was conducted across ToolFlow's core orchestration and state management modules (`engine.ts`, `state.ts`, `worker_orchestrator.ts`, `index.ts`, `types.ts`). 

While ToolFlow establishes a robust foundational architecture featuring Kahn DAG scheduling, 3-attempt self-healing physical gates, and stage snapshot rollbacks, the audit identified **14 distinct architectural, runtime, and type-safety vulnerabilities** categorized across 5 core risk pillars:
1. **Pillar 1: Kahn DAG Cycle Detection & Graph Topology Flaws** (4 findings)
2. **Pillar 2: Concurrency, Worker Pool & Parallel Execution Risks** (3 findings)
3. **Pillar 3: State Machine Consistency, Transaction Rollback & Persistence Races** (4 findings)
4. **Pillar 4: Async Error Propagation, Promise Lifecycle & Event Leaks** (2 findings)
5. **Pillar 5: Strict TypeScript Typing Soundness & Schema Ambiguities** (3 findings)

---

## Radar Risk Breakdown

| Risk Area | Severity | Exploitability / Trigger Probability | Impact |
|---|---|---|---|
| **Worker Orchestrator Runtime Typo (`s.id` & `s.description`)** | **Critical** | 100% on wave compilation | Subagents receive `"undefined"` prompts and broken stage maps |
| **Non-Atomic State Persistence (`saveSessionStateToFile`)** | **High** | High on process kill/concurrency | Corrupts or zeroes `blueprint_state.json`, total state loss |
| **Kahn DAG Phantom Dependency Swallowing** | **High** | High on dynamic stage renaming | Stages run out of order or parallelize incorrectly |
| **Incomplete Rollback (Orphan New Files)** | **High** | High on broken code generation | Newly created broken files remain on disk after rollback |
| **Snapshot In-Memory Bloat & JSON Stringify Limit** | **Medium** | High on large multi-stage projects | Memory bloat & disk I/O stutter on every turn |
| **Circuit Breaker State Machine Desynchronization** | **Medium** | High on 3-attempt failure | Session enters stuck zombie state without explicit transition |
| **Synchronous `execSync` Blocking Event Loop** | **Medium** | High during long-running tests | Freezes interactive CLI/TUI for up to 15 seconds |
| **TypeScript Compilation Errors (`tsc --noEmit` failure)** | **Medium** | 100% during strict build | Missing imports & implicit any in `engine.ts` / `index.ts` |

---

## Detailed Findings by Pillar

---

### Pillar 1: Kahn DAG Cycle Detection & Graph Topology Flaws

#### Finding 1.1: Phantom / Orphan Dependency Swallowing
- **File & Line**: `engine.ts:153-156`
- **Code Symbol**: `planDAGWaves`
- **Mechanism**:
  ```typescript
  for (const s of stages) {
    const deps = s.dependsOn || [];
    for (const dep of deps) {
      if (!stageMap.has(dep)) {
        continue; // 🚨 SILENTLY DROPPED: No warning, no degree increment, no error
      }
      adjList.get(dep)!.push(s.stageId);
      inDegree.set(s.stageId, (inDegree.get(s.stageId) || 0) + 1);
    }
  }
  ```
  When a stage defines a dependency on a non-existent or renamed stage ID (`dependsOn: ["stage_missing"]`), `planDAGWaves` simply skips the dependency. The dependent stage's `inDegree` remains `0`.
- **Failure Scenario**:
  If an AI architect or dynamic prompt renames a stage ID but leaves a downstream stage's `dependsOn` referencing the old ID, the downstream stage is treated as having **zero dependencies**. It is immediately scheduled into **Wave 0**, executing before prerequisites exist and failing immediately.
- **Trigger Input**:
  ```typescript
  const stages: BlueprintStage[] = [
    { stageId: "stage_2", dependsOn: ["stage_1_renamed"], expectedArtifact: "src/main.ts", ... }
  ];
  const plan = planDAGWaves(stages);
  // Result: plan.waves[0].stages[0].stageId === "stage_2", hasCycles === false
  ```
- **Refactoring Solution**:
  ```diff
  --- a/engine.ts
  +++ b/engine.ts
  @@ -144,6 +144,7 @@ export function planDAGWaves(stages: BlueprintStage[]): DAGPlanResult {
     const adjList = new Map<string, string[]>();
  +  const missingDependencies: Array<{ stageId: string; missingDep: string }> = [];
  
     for (const s of stages) {
       stageMap.set(s.stageId, s);
  @@ -154,6 +155,7 @@ export function planDAGWaves(stages: BlueprintStage[]): DAGPlanResult {
       for (const dep of deps) {
         if (!stageMap.has(dep)) {
  +        missingDependencies.push({ stageId: s.stageId, missingDep: dep });
           continue;
         }
  ```

---

#### Finding 1.2: Duplicate Dependency Edge Inflation
- **File & Line**: `engine.ts:151-160`
- **Code Symbol**: `planDAGWaves`
- **Mechanism**:
  If `s.dependsOn` contains duplicate entries (e.g. `["stage_1", "stage_1"]`), `adjList.get("stage_1")` gets `s.stageId` pushed twice, and `inDegree` is incremented to `2`.
- **Failure Scenario**:
  When `stage_1` finishes, its neighbors array `["stage_2", "stage_2"]` decrements `stage_2`'s in-degree twice in the same loop iteration. If there are complex DAG diamond structures or partial DAGs, duplicate elements cause race conditions and corrupted queue pushes.
- **Trigger Input**:
  `{ stageId: "s2", dependsOn: ["s1", "s1"] }`
- **Refactoring Solution**:
  ```diff
  --- a/engine.ts
  +++ b/engine.ts
  @@ -151,3 +151,3 @@ export function planDAGWaves(stages: BlueprintStage[]): DAGPlanResult {
     for (const s of stages) {
  -    const deps = s.dependsOn || [];
  +    const deps = Array.from(new Set(s.dependsOn || []));
       for (const dep of deps) {
  ```

---

#### Finding 1.3: Total Pipeline Degradation on Disconnected Cycles
- **File & Line**: `engine.ts:195-207`
- **Code Symbol**: `planDAGWaves`
- **Mechanism**:
  ```typescript
  const hasCycles = processedCount < stages.length;
  // 如果检测到环路，按原始顺序兜底返回并标记环路节点
  return {
    sortedStages: hasCycles ? stages : sortedStages,
    waves: hasCycles ? [{ waveIndex: 0, stages, isParallel: false }] : waves,
    hasCycles,
    cycleNodes
  };
  ```
  When a cycle exists anywhere in the graph (even in disconnected sub-graphs), `planDAGWaves` discards the entire topological sort. It packs **all** stages into a single fallback wave `[stages]` and returns `hasCycles: true`.
- **Failure Scenario**:
  Neither `synthesizeBlueprint` nor `index.ts` checks `hasCycles`. The pipeline proceeds to execute the broken cyclic stages sequentially in raw array order. The user is never alerted that a cycle exists.
- **Refactoring Solution**:
  Explicitly return validation status, emit warning/error logs, and allow `synthesizeBlueprint` to halt or reject corrupted DAGs before execution begins.

---

#### Finding 1.4: Duplicate `stageId` Shadowing Leading to False Positive Cycles
- **File & Line**: `engine.ts:145-149, 195`
- **Code Symbol**: `planDAGWaves`
- **Mechanism**:
  If input stages contain two objects with the same `stageId` (e.g. dynamically generated stages), `stageMap.set(s.stageId, s)` overwrites the first entry. `stageMap.size` becomes less than `stages.length`.
  `processedCount` can never equal `stages.length`, causing `hasCycles` to evaluate to `true` on an acyclic graph with no error indicating duplicate IDs.
- **Refactoring Solution**:
  Add uniqueness assertion when initializing `stageMap`.

---

### Pillar 2: Concurrency, Worker Pool & Parallel Execution Risks

#### Finding 2.1: Runtime Property Name Inconsistencies (`s.id` & `s.description`)
- **File & Line**: `worker_orchestrator.ts:21-35`
- **Code Symbol**: `MultiAgentWorkerOrchestrator.compileWaveBundles`
- **Mechanism**:
  ```typescript
  public static compileWaveBundles(stages: BlueprintStage[]): WaveExecutionBundle[] {
    const dagResult: DAGPlanResult = planDAGWaves(stages);
    const stageMap = new Map<string, BlueprintStage>();
    stages.forEach(s => stageMap.set(s.id, s)); // 🚨 BUG 1: s.id is undefined (BlueprintStage has stageId)

    return dagResult.waves.map((wave, idx) => {
      const isParallel = wave.stages.length > 1;
      const tasks: ParallelTaskUnit[] = wave.stages.map((s, subIdx) => {
        const artifacts = s.expectedArtifacts || (s.expectedArtifact ? [s.expectedArtifact] : []);
        return {
          laneId: "wave_" + (idx + 1) + "_lane_" + (subIdx + 1),
          stageId: s.stageId,
          stageTitle: s.title,
          targetArtifacts: artifacts,
          executionPrompt: "[Stage: " + s.title + "] " + s.description + " -> 交付产物: " + artifacts.join(", ") // 🚨 BUG 2: s.description is undefined (has coreObjective)
        };
      });
  ```
- **Failure Scenario**:
  1. `stageMap` is populated with a single key `undefined`.
  2. The prompt dispatched to all worker subagents contains `"[Stage: ...] undefined -> 交付产物: ..."`, omitting the core objective of the stage.
- **Refactoring Solution**:
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

---

#### Finding 2.2: Unbounded Worker Concurrency & Missing Starvation Defense
- **File & Line**: `worker_orchestrator.ts:18-44`
- **Code Symbol**: `MultiAgentWorkerOrchestrator`
- **Mechanism**:
  `compileWaveBundles` creates a task for every stage in a wave without limiting the maximum number of concurrent workers.
- **Failure Scenario**:
  If a wave contains 10+ independent stages, launching 10 concurrent subagents triggers API rate limits (HTTP 429), memory exhaustion, and git index lock contention (`.git/index.lock`).
- **Refactoring Solution**:
  Introduce `maxConcurrency` parameter (default: 4) to chunk parallel waves into controlled worker batches.

---

### Pillar 3: State Machine Consistency, Transaction Rollback & Persistence Races

#### Finding 3.1: Non-Atomic File Persistence & State Corruption Risk
- **File & Line**: `state.ts:35-43`
- **Code Symbol**: `saveSessionStateToFile`
- **Mechanism**:
  ```typescript
  export function saveSessionStateToFile(cwd: string = process.cwd()): boolean {
    try {
      const filePath = getPersistFilePath(cwd);
      fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
      return true;
    } catch (_) {
      return false;
    }
  }
  ```
  `fs.writeFileSync` directly writes to `blueprint_state.json`. If process termination occurs mid-write, the file is corrupted or truncated to 0 bytes. Subsequent reads fail permanently.
- **Refactoring Solution**:
  ```diff
  --- a/state.ts
  +++ b/state.ts
  @@ -36,4 +36,7 @@ export function saveSessionStateToFile(cwd: string = process.cwd()): boolean {
     try {
       const filePath = getPersistFilePath(cwd);
  -    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
  +    const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  +    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), "utf-8");
  +    fs.renameSync(tempPath, filePath);
       return true;
     } catch (_) {
  ```

---

#### Finding 3.2: Snapshot State Bloat & OOM via Massive `fileContents` Serialization
- **File & Line**: `state.ts:183-196, 218-222`
- **Code Symbol**: `createStageSnapshot`
- **Mechanism**:
  Every stage snapshot reads up to 50 files (<2MB each) and stores full file strings in `state.snapshots[stageIndex].fileContents`. Over multiple stages, `state.snapshots` accumulates all file contents across all stages, and `saveSessionStateToFile` serializes all of them into a single `blueprint_state.json` file.
- **Failure Scenario**:
  On a project with 30 files, `blueprint_state.json` can grow to 30-50MB. String serialization and disk I/O stutter the Node process on every turn end and tool call.
- **Refactoring Solution**:
  Store only `fileHashes` in the main session state, and persist full stage file contents into isolated disk snapshot folders (`.pi/snapshots/<stageIndex>/`).

---

#### Finding 3.3: Incomplete Rollback: Orphan New Files Remain on Disk
- **File & Line**: `state.ts:249-273`
- **Code Symbol**: `rollbackStage`
- **Mechanism**:
  `rollbackStage` restores files recorded in `snapshot.fileContents`. However, if the rolled-back stage created **new** files (e.g. `src/faulty_code.ts`), `rollbackStage` does NOT delete them.
- **Failure Scenario**:
  The new broken files remain in the project directory, causing compiler errors or test failures during subsequent retry attempts.
- **Refactoring Solution**:
  Compare currently existing files against `snapshot.changedFiles` and unlink newly created untracked files on rollback.

---

#### Finding 3.4: Circuit Breaker State Machine Desynchronization
- **File & Line**: `state.ts:404-418`, `types.ts:225`
- **Code Symbol**: `verifyStageArtifacts`
- **Mechanism**:
  `SessionPlanState.status` supports `"healing_failed_circuit_break"`. However, when `state.retryCount >= 3`, `verifyStageArtifacts` never sets `state.status = "healing_failed_circuit_break"`. `state.status` remains `"in_progress"`.
- **Failure Scenario**:
  In `index.ts:338`, `turn_end` silently skips because `retryCount >= 3`. The session is left in an unresolvable zombie `"in_progress"` state.
- **Refactoring Solution**:
  Transition `state.status` to `"healing_failed_circuit_break"` upon reaching 3 retries.

---

#### Finding 3.5: Synchronous `execSync` Blocking Event Loop
- **File & Line**: `state.ts:458, 201, 106`
- **Code Symbol**: `verifyStageArtifacts`
- **Mechanism**:
  `execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 15000 });`
  Synchronously executes verification commands, freezing the Node.js event loop and Pi TUI for up to 15 seconds.
- **Refactoring Solution**:
  Wrap command execution in an async promise with `child_process.exec` or `spawn` and `AbortController`.

---

### Pillar 4: Async Error Propagation, Promise Lifecycle & Event Leaks

#### Finding 4.1: Unhandled Rejection Risk in `turn_end` Hook
- **File & Line**: `index.ts:329-418`
- **Code Symbol**: `pi.on("turn_end", ...)`
- **Mechanism**:
  The async `turn_end` handler does not contain an outer `try...catch` block. If `verifyStageArtifacts`, `advanceStage`, or `pi.sendUserMessage` throws, an unhandled promise rejection occurs.
- **Refactoring Solution**:
  Wrap the entire handler in `try...catch` with UI error notification.

---

#### Finding 4.2: Tool Scoping Leak on Rollback / Reset
- **File & Line**: `index.ts:140-156, 260-271`
- **Code Symbol**: `handleBlueprintFlow`
- **Mechanism**:
  Tool scoping is escalated when advancing stages (`applyToolScoping(nextStage.allowedTools, pi)`). However, when `/blueprint rollback` or `/blueprint reset` is invoked, tools are not reset to `BASELINE_TOOLS`.
- **Refactoring Solution**:
  Call `applyToolScoping(BASELINE_TOOLS, pi)` on rollback and reset.

---

### Pillar 5: Strict TypeScript Typing Soundness & Schema Ambiguities

#### Finding 5.1: Missing Export/Import of `CapabilityItem` in `engine.ts`
- **File & Line**: `engine.ts:313`
- **Code Symbol**: `topEcosystemMatch: CapabilityItem | null`
- **Mechanism**: `CapabilityItem` is referenced as a type in `engine.ts:313` but is omitted from `import { ... } from "./types.js"`. Causes `TS2304: Cannot find name 'CapabilityItem'`.
- **Refactoring Solution**:
  Import `CapabilityItem` from `./types.js`.

---

#### Finding 5.2: Dual Schema Ambiguity (`expectedArtifact` vs `expectedArtifacts`)
- **File & Line**: `types.ts:142-143`, `state.ts:366`, `worker_orchestrator.ts:27`
- **Code Symbol**: `BlueprintStage.expectedArtifact` vs `BlueprintStage.expectedArtifacts`
- **Mechanism**:
  `expectedArtifact: string;` vs `expectedArtifacts?: string[];`.
  `verifyStageArtifacts` assumes `stage.expectedArtifact` is always non-empty string (`const artifactPath = stage.expectedArtifact;`). If a stage is defined with only `expectedArtifacts: ["main.ts"]` and `expectedArtifact: ""`, validation fails immediately on `fs.existsSync("")`.
- **Refactoring Solution**:
  Normalize at stage synthesis: `expectedArtifact = expectedArtifact || (expectedArtifacts && expectedArtifacts[0]) || "";`.

---

## Actionable Refactoring Summary Table

| Finding ID | Component | Affected File & Lines | Severity | Remediation Priority |
|---|---|---|---|---|
| **F-1.1** | DAG Graph | `engine.ts:153-156` | High | P1 |
| **F-1.2** | DAG Graph | `engine.ts:151-160` | Medium | P2 |
| **F-1.3** | DAG Graph | `engine.ts:195-207` | High | P1 |
| **F-1.4** | DAG Graph | `engine.ts:145-149` | Low | P3 |
| **F-2.1** | Worker Orchestrator | `worker_orchestrator.ts:22,33` | **Critical** | **P0** |
| **F-2.2** | Worker Orchestrator | `worker_orchestrator.ts:18-44` | High | P1 |
| **F-3.1** | State Persistence | `state.ts:35-43` | High | P1 |
| **F-3.2** | State Snapshot | `state.ts:183-196` | Medium | P2 |
| **F-3.3** | Transaction Rollback | `state.ts:249-273` | High | P1 |
| **F-3.4** | State Machine | `state.ts:404-418` | Medium | P2 |
| **F-3.5** | Concurrency I/O | `state.ts:458` | Medium | P2 |
| **F-4.1** | Event Loop / Promise | `index.ts:329-418` | Medium | P2 |
| **F-4.2** | Permission Security | `index.ts:140-156` | Medium | P2 |
| **F-5.1** | TypeScript Soundness | `engine.ts:313` | High | P1 |
| **F-5.2** | Type Definition | `types.ts:142-143` | Low | P3 |

---
*Report compiled and verified by DAG & Engine Auditor.*
