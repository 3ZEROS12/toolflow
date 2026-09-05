# Exhaustive Code-Level Safety, Storage & Resilience Subsystem Audit

**Auditor**: Safety & Resilience Auditor (`teamwork_preview_explorer`)  
**Workspace Root**: `C:\Users\Jason\.pi\agent\extensions\toolflow`  
**Date**: 2026-09-02  
**Target Subsystems**:
1. `blast_radius.ts` (Blast Radius & Sandbox Boundary Enforcement)
2. `dehydrator.ts` (Context Dehydration & Storage Lifecycle)
3. `degradation_matrix.ts` (Graceful Tool Degradation & Self-Healing Resilience)
4. `memory.ts` (Architectural Episodic Memory & Directives)
*Interfacing Modules Audited*: `state.ts`, `engine.ts`, `index.ts`.

---

## Executive Summary & Threat Matrix

| Subsystem | Vulnerability ID | Severity | Core Risk | Status |
|---|---|---|---|---|
| **blast_radius.ts** | SEC-BR-01 | **CRITICAL** | Wildcard Glob Matching Failure (False block on multi-file edits) | Confirmed |
| **blast_radius.ts** | SEC-BR-02 | **HIGH** | Windows Path Normalization / Case & Drive Letter Bypass | Confirmed |
| **blast_radius.ts** | SEC-BR-03 | **HIGH** | Symlink / Directory Junction Traversal & Bypass | Confirmed |
| **blast_radius.ts** | SEC-BR-04 | **MEDIUM** | Windows 8.3 Short Filename (SFN) Evasion | Confirmed |
| **blast_radius.ts** | SEC-BR-05 | **MEDIUM** | NTFS Alternate Data Stream (ADS) & Null Byte Bypass | Confirmed |
| **blast_radius.ts** | SEC-BR-06 | **HIGH** | Shell / Non-Standard Tool Call Evasion (Bash/PowerShell Bypass) | Confirmed |
| **blast_radius.ts** | SEC-BR-07 | **HIGH** | Critical Config Whitelist Override Flaw | Confirmed |
| **dehydrator.ts** | RES-DH-01 | **HIGH** | Missing Byte Disk Quota & Stale Directory `mtime` Premature Eviction | Confirmed |
| **dehydrator.ts** | RES-DH-02 | **HIGH** | Large Payload V8 Heap / Buffer Exhaustion (OOM) | Confirmed |
| **dehydrator.ts** | RES-DH-03 | **MEDIUM** | Zero-Byte / Corrupted Payload Silent Error Swallowing | Confirmed |
| **dehydrator.ts** | RES-DH-04 | **MEDIUM** | 4KB Truncation Limit & Fragile Regex AST Parsing | Confirmed |
| **dehydrator.ts** | RES-DH-05 | **LOW** | Stale Artifact SHA-256 Fingerprint Invalidation Leaks | Confirmed |
| **degradation_matrix.ts** | RES-DG-01 | **CRITICAL** | Subsystem Disconnect / Runtime Dead Code | Confirmed |
| **degradation_matrix.ts** | RES-DG-02 | **HIGH** | Self-Healing Livelock / Side-Effect Query State Corruption | Confirmed |
| **degradation_matrix.ts** | RES-DG-03 | **MEDIUM** | Missing Exponential Backoff, Jitter & Circuit Breaker Reset | Confirmed |
| **degradation_matrix.ts** | RES-DG-04 | **HIGH** | Design Stage Tool Over-Pruning (Write Block Deadlock) | Confirmed |
| **degradation_matrix.ts** | RES-DG-05 | **MEDIUM** | Windows Platform Incompatible Shell Fallbacks | Confirmed |
| **memory.ts** | RES-MM-01 | **HIGH** | Unbounded Growth & Prompt Token Budget Blowout | Confirmed |
| **memory.ts** | RES-MM-02 | **HIGH** | Ground-Truth Primacy Conflict & Stale Directive Poisoning | Confirmed |
| **memory.ts** | RES-MM-03 | **MEDIUM** | Non-Atomic Writes & Concurrent Multi-Agent Race Conditions | Confirmed |
| **memory.ts** | RES-MM-04 | **CRITICAL** | Complete Runtime Pipeline Disconnect (Orphaned Subsystem) | Confirmed |

---

## Part 1: Deep Audit of `blast_radius.ts`

### 1.1 [SEC-BR-01] Wildcard Glob Matching Failure in Allowed Scope
- **File & Lines**: `blast_radius.ts:36-38`, `blast_radius.ts:78`
- **Code Symbols**: `BlastRadiusGuard.updateAllowedScope`, `BlastRadiusGuard.verifyToolCall`, `this.allowedPaths`
- **Failure Scenario & Mechanism**:
  `updateAllowedScope` takes glob strings from `stage.targetPatterns` (e.g. `["src/**", "*.ts", "docs/**"]`) and attempts to resolve them using `path.resolve(cwd, p)`. On Windows, this creates literal strings like `C:\Users\Jason\project\src\**`.
  These literal glob strings are added to `this.allowedPaths: Set<string>`.
  When a tool call occurs, `verifyToolCall` checks `this.allowedPaths.has(resolved)`.
  In JavaScript, `Set.has()` performs strict reference/string equality (`===`). It cannot perform glob expansion or wildcard pattern matching.
  **Impact**: Any legitimate file modification inside a directory matched by `targetPatterns` (e.g., editing `src/utils.ts` in an implementation stage where `expectedArtifact` is `src/main.ts`) will **always return false** and be falsely blocked as an out-of-scope violation!
- **Reproduction Hypothesis & Trigger Input**:
  ```ts
  const guard = new BlastRadiusGuard();
  guard.updateAllowedScope({
    stageId: "stage_2",
    title: "Implementation",
    roleProfile: "dev",
    coreObjective: "Code",
    expectedArtifact: "src/main.ts",
    targetPatterns: ["src/**", "lib/**"],
    artifactContract: "Valid code",
    allowedTools: ["write", "edit"]
  }, "C:\\repo");

  // Agent edits a secondary source file within the stage's targetPatterns:
  const result = guard.verifyToolCall({
    toolName: "write",
    input: { path: "src/utils.ts" }
  }, "C:\\repo");

  console.log(result.block); // Evaluates to TRUE! (Blocked erroneously)
  ```
- **Actionable Refactoring Solution**:
  Split `allowedPaths` into exact paths (`allowedExactPaths: Set<string>`) and wildcard patterns (`allowedGlobPatterns: string[]`). Use standard glob matching (or lightweight regex compilation) to evaluate `relative` paths against patterns.

```diff
--- a/blast_radius.ts
+++ b/blast_radius.ts
@@ -9,2 +9,3 @@
 export class BlastRadiusGuard {
-  private allowedPaths: Set<string> = new Set();
+  private allowedExactPaths: Set<string> = new Set();
+  private allowedGlobPatterns: string[] = [];
@@ -28,3 +29,4 @@
   public updateAllowedScope(stage: BlueprintStage, cwd: string = process.cwd()) {
-    this.allowedPaths.clear();
+    this.allowedExactPaths.clear();
+    this.allowedGlobPatterns = [];
     
     if (stage.expectedArtifact) {
-      this.allowedPaths.add(path.resolve(cwd, stage.expectedArtifact));
+      this.allowedExactPaths.add(this.normalizePath(path.resolve(cwd, stage.expectedArtifact)));
     }
     if (stage.expectedArtifacts) {
-      stage.expectedArtifacts.forEach(p => this.allowedPaths.add(path.resolve(cwd, p)));
+      stage.expectedArtifacts.forEach(p => this.allowedExactPaths.add(this.normalizePath(path.resolve(cwd, p))));
     }
     if (stage.targetPatterns) {
-      stage.targetPatterns.forEach(p => this.allowedPaths.add(path.resolve(cwd, p)));
+      this.allowedGlobPatterns = stage.targetPatterns.map(p => p.replace(/\\/g, "/"));
     }
   }
@@ -61,3 +63,4 @@
-      const resolved = path.resolve(cwd, targetPath);
-      const relative = path.relative(cwd, resolved);
+      const resolved = this.normalizePath(path.resolve(cwd, targetPath));
+      const relative = path.relative(cwd, resolved).replace(/\\/g, "/");
       const baseName = path.basename(resolved);
@@ -78,1 +81,2 @@
-      if (this.allowedPaths.size > 0 && !this.allowedPaths.has(resolved)) {
+      const isAllowed = this.isPathInAllowedScope(resolved, relative);
+      if ((this.allowedExactPaths.size > 0 || this.allowedGlobPatterns.length > 0) && !isAllowed) {
```

---

### 1.2 [SEC-BR-02] Windows Path Normalization / Case-Sensitivity Bypass
- **File & Lines**: `blast_radius.ts:61-68`, `blast_radius.ts:78`
- **Code Symbols**: `BlastRadiusGuard.verifyToolCall`
- **Failure Scenario & Mechanism**:
  On Windows (NTFS), file paths are case-insensitive.
  `path.resolve()` preserves the casing passed in arguments. If `cwd` has uppercase drive letter `C:\Repo` but the tool event provides lowercase `c:\repo\src\main.ts` or mixed-case `Src/Main.ts`, string comparison in `Set.has(resolved)` fails.
  This leads to false positive blocks on legitimate operations and inconsistent matching for protected configuration files.
- **Reproduction Hypothesis & Trigger Input**:
  - `allowedPaths` contains `C:\project\src\main.ts`.
  - Tool call passes `path: "src/Main.ts"`.
  - `path.resolve` produces `C:\project\src\Main.ts`.
  - `allowedPaths.has("C:\\project\\src\\Main.ts")` returns `false`.
- **Actionable Refactoring Solution**:
  Implement a central `normalizePath()` helper:
  ```ts
  private normalizePath(p: string): string {
    const resolved = path.resolve(p);
    return process.platform === "win32" ? resolved.toLowerCase().replace(/\\/g, "/") : resolved;
  }
  ```

---

### 1.3 [SEC-BR-03] Symlink & Directory Junction Traversal Bypasses
- **File & Lines**: `blast_radius.ts:61-75`
- **Code Symbols**: `BlastRadiusGuard.verifyToolCall`
- **Failure Scenario & Mechanism**:
  `path.resolve(cwd, targetPath)` only performs lexical path canonicalization. It does not resolve symlinks or Windows directory junctions via `fs.realpathSync`.
  If a symlink inside the workspace points to a sensitive file (e.g. `src/config.json -> .env`), `baseName` is `config.json` and `relative` is `src/config.json`.
  `criticalConfigPatterns` tests `baseName` and `relative`, neither of which matches `.env`.
  The tool call is allowed to write through the symlink, overwriting `.env` or files outside the workspace boundary.
- **Reproduction Hypothesis & Trigger Input**:
  1. Create symlink: `src/secret.txt -> .env`.
  2. Call `write` with `input.path = "src/secret.txt"`.
  3. `baseName = "secret.txt"`. Regex checks pass.
  4. Write succeeds and alters `.env`.
- **Actionable Refactoring Solution**:
  Resolve real paths when target exists or inspect the real path of the containing directory:
  ```ts
  let realTarget = resolved;
  try {
    if (fs.existsSync(resolved)) {
      realTarget = fs.realpathSync.native(resolved);
    } else {
      const parent = path.dirname(resolved);
      if (fs.existsSync(parent)) {
        realTarget = path.join(fs.realpathSync.native(parent), path.basename(resolved));
      }
    }
  } catch (_) {}
  ```

---

### 1.4 [SEC-BR-04] Windows 8.3 Short Filename (SFN) Evasion
- **File & Lines**: `blast_radius.ts:11-22`, `blast_radius.ts:67`
- **Code Symbols**: `this.criticalConfigPatterns`
- **Failure Scenario & Mechanism**:
  On NTFS partitions with SFN enabled, files like `package-lock.json` and `pnpm-workspace.yaml` possess 8.3 aliases (`PACKAG~1.JSO`, `PNPM-W~1.YAM`).
  `criticalConfigPatterns` checks against exact names like `/^package-lock\.json$/i`.
  An attacker or agent writing to `PACKAG~1.JSO` bypasses `criticalConfigPatterns` entirely, overwriting critical dependency locks.
- **Reproduction Hypothesis & Trigger Input**:
  `verifyToolCall({ toolName: "write", input: { path: "PACKAG~1.JSO" } })`
  `baseName` is `PACKAG~1.JSO`. Regex returns `false`. Interception fails.
- **Actionable Refactoring Solution**:
  Include Windows 8.3 short filename regex variants in `criticalConfigPatterns` or canonicalize using `fs.realpathSync`.

---

### 1.5 [SEC-BR-05] NTFS Alternate Data Streams (ADS) Evasion
- **File & Lines**: `blast_radius.ts:61-67`
- **Code Symbols**: `BlastRadiusGuard.verifyToolCall`
- **Failure Scenario & Mechanism**:
  Writing to `package-lock.json::$DATA` or creating auxiliary streams like `index.ts:hidden.exe` evades `path.basename` pattern matching.
- **Reproduction Hypothesis & Trigger Input**:
  `verifyToolCall({ toolName: "write", input: { path: "package-lock.json::$DATA" } })`
  `baseName` is `package-lock.json::$DATA`. Pattern `/^package-lock\.json$/i` fails to match.
- **Actionable Refactoring Solution**:
  Strip or forbid `:` character in relative paths (except standard Windows drive letter `^[a-zA-Z]:`).

---

### 1.6 [SEC-BR-06] Shell & Non-Standard Tool Call Evasion (Bash/PowerShell Bypass)
- **File & Lines**: `blast_radius.ts:55`
- **Code Symbols**: `if (event.toolName === "write" || event.toolName === "edit")`
- **Failure Scenario & Mechanism**:
  `verifyToolCall` only intercepts `write` and `edit`.
  Tools like `bash`, `powershell`, `exec`, `write_to_file`, `replace_file_content`, and `patch` are completely uninspected.
  An agent running `bash` with command `rm -rf package-lock.json` or `echo "EVIL" > .env` completely bypasses the blast radius guard.
- **Reproduction Hypothesis & Trigger Input**:
  `verifyToolCall({ toolName: "bash", input: { command: "echo KEY=123 > .env" } })`
  Returns `{ block: false }`.
- **Actionable Refactoring Solution**:
  Intercept shell commands by inspecting command strings for destructive / file-redirect operators (`>`, `>>`, `rm`, `del`, `Remove-Item`) targeting protected files, and register all known editing tool names.

---

### 1.7 [SEC-BR-07] Critical Configuration Whitelist Override Flaw
- **File & Lines**: `blast_radius.ts:68`
- **Code Symbols**: `if (!this.allowedPaths.has(resolved))`
- **Failure Scenario & Mechanism**:
  If a stage's `expectedArtifact` or `targetPatterns` includes `.env` or `*`, line 68 allows the write because `this.allowedPaths.has(resolved)` is true.
  Critical config protection is bypassed whenever a stage misconfigures or is prompt-injected to target configuration files.
- **Reproduction Hypothesis & Trigger Input**:
  Stage configured with `expectedArtifact: ".env"`.
  `verifyToolCall({ toolName: "write", input: { path: ".env" } })` passes through unblocked.
- **Actionable Refactoring Solution**:
  Make critical configuration blocking unconditional unless explicitly bypassed with a specific `forceAllowProtectedConfig: true` flag.

---

## Part 2: Deep Audit of `dehydrator.ts`

### 2.1 [RES-DH-01] Missing Disk Quota & Stale Directory `mtime` in LRU Eviction
- **File & Lines**: `dehydrator.ts:35-64`
- **Code Symbols**: `ContextDehydrator.pruneOldRuns`
- **Failure Scenario & Mechanism**:
  1. `pruneOldRuns` only counts directory entries (`maxRuns: 10`) and age (`maxAgeMs`), without calculating total disk usage in bytes. If each run outputs 500MB of verbose compiler logs, 10 runs consume 5GB+ disk space.
  2. `pruneOldRuns` inspects `fs.statSync(fullPath).mtimeMs` of directory entries. Modifying files inside a subdirectory does **not** update the directory's `mtime` on Windows and Linux ext4. An active session directory created 8 days ago will be considered older than `maxAgeMs` and deleted while actively in use!
  3. Eviction does not exclude the active `blueprintId` / current run directory.
- **Reproduction Hypothesis & Trigger Input**:
  - Blueprint session runs longer than 7 days, or directory `mtime` is unchanged after initial creation.
  - `pruneOldRuns` runs and deletes the directory `this.runsDir` of the active run.
- **Actionable Refactoring Solution**:
  - Add `maxTotalBytes` limit (e.g. 200MB).
  - Compute `mtime` as `Math.max` of all files inside each run folder.
  - Explicitly exclude `this.runsDir` / active `blueprintId` from deletion.

```diff
--- a/dehydrator.ts
+++ b/dehydrator.ts
@@ -35,3 +35,3 @@
-  public pruneOldRuns(maxRuns: number = 10, maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): string[] {
+  public pruneOldRuns(maxRuns: number = 10, maxAgeMs: number = 7 * 24 * 60 * 60 * 1000, maxTotalBytes: number = 200 * 1024 * 1024): string[] {
     const deletedDirs: string[] = [];
     try {
       if (!fs.existsSync(this.baseDir)) return deletedDirs;
       const entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
       const runFolders = entries
         .filter(e => e.isDirectory())
+        .filter(e => path.join(this.baseDir, e.name) !== this.runsDir)
         .map(e => {
           const fullPath = path.join(this.baseDir, e.name);
-          const stat = fs.statSync(fullPath);
-          return { name: e.name, fullPath, mtimeMs: stat.mtimeMs };
+          const folderStats = this.getFolderStats(fullPath);
+          return { name: e.name, fullPath, mtimeMs: folderStats.mtimeMs, sizeBytes: folderStats.sizeBytes };
         })
         .sort((a, b) => b.mtimeMs - a.mtimeMs);
```

---

### 2.2 [RES-DH-02] Large Payload V8 Heap / Buffer Exhaustion (OOM)
- **File & Lines**: `dehydrator.ts:69-81`
- **Code Symbols**: `ContextDehydrator.dehydrateStageLog`
- **Failure Scenario & Mechanism**:
  `dehydrateStageLog` receives `rawLogs: string` and invokes synchronous `fs.writeFileSync(rawLogFilePath, rawLogs, "utf-8")`.
  When handling massive compiler/test output (e.g. 500MB+), holding large strings in memory and writing synchronously causes high V8 string heap pressure, triggering `ERR_STRING_TOO_LONG` or crashing Node.js with `JavaScript heap out of memory`.
- **Reproduction Hypothesis & Trigger Input**:
  `dehydrateStageLog("s1", "build", "x".repeat(600 * 1024 * 1024), [], "contract")`
  V8 heap exhaustion terminates process.
- **Actionable Refactoring Solution**:
  Enforce a maximum string length threshold (e.g. 10MB) with head/tail truncation notice before disk write, or support stream-based log capture.

---

### 2.3 [RES-DH-03] Zero-Byte / Corrupted Payload Silent Error Swallowing
- **File & Lines**: `dehydrator.ts:79-81`
- **Code Symbols**: `try { fs.writeFileSync(rawLogFilePath, rawLogs, "utf-8"); } catch (_) {}`
- **Failure Scenario & Mechanism**:
  If the disk is full (`ENOSPC`) or access is denied (`EACCES`), the error is completely swallowed.
  `DehydratedStageHandoff` returns `rawLogFilePath` as if the write succeeded. When downstream tools attempt to read the log file, they encounter `ENOENT` or read empty content.
- **Reproduction Hypothesis & Trigger Input**:
  Set `.pi/toolflow/runs` to read-only.
  Call `dehydrateStageLog`. Return object claims `rawLogFilePath` is valid, but the file was never written.
- **Actionable Refactoring Solution**:
  Record `rawLogStatus: "written" | "write_failed" | "truncated"` in the returned `DehydratedStageHandoff`.

---

### 2.4 [RES-DH-04] 4KB Truncation Limit & Fragile Regex AST Parsing
- **File & Lines**: `dehydrator.ts:86-100`
- **Code Symbols**: `content.slice(0, 4096)`
- **Failure Scenario & Mechanism**:
  1. `slice(0, 4096)` misses imports or exports located beyond the first 4KB of a file.
  2. Regex `import\s+(?:\{[^}]+\}|\w+)\s+from\s+["']([^"']+)["']/g` fails on multi-line imports, `import * as`, `import type`, and incorrectly matches commented-out code.
  3. Regex `export\s+(?:const|class|interface|type|function)\s+(\w+)` fails on `export async function`, `export enum`, `export default`, `export { X, Y }`.
- **Reproduction Hypothesis & Trigger Input**:
  File containing `export async function startServer()` -> `exportedSymbols` fails to capture `startServer`.
- **Actionable Refactoring Solution**:
  Read full file (up to reasonable limit e.g. 256KB) and expand regexes to include `async function`, `enum`, `* as`, `type`, and multi-line patterns.

---

### 2.5 [RES-DH-05] Stale Artifact SHA-256 Fingerprint Invalidation Leaks
- **File & Lines**: `dehydrator.ts:121-123`
- **Code Symbols**: `formatHandoffPrompt`
- **Failure Scenario & Mechanism**:
  `formatHandoffPrompt` uses `art.sha256` from the passed-in `handoff` structure. If files are modified after verification, the injected prompt contains stale hashes.
- **Reproduction Hypothesis & Trigger Input**:
  File modified between stage completion and handoff prompt formatting.
- **Actionable Refactoring Solution**:
  Re-validate hashes against live disk state when formatting prompt if file exists.

---

## Part 3: Deep Audit of `degradation_matrix.ts`

### 3.1 [RES-DG-01] Subsystem Disconnect / Runtime Dead Code
- **File & Lines**: `degradation_matrix.ts:1-158`, `index.ts:10`, `engine.ts:942-950`
- **Code Symbols**: `GracefulDegradationMatrix.resolveCapability`, `GracefulDegradationMatrix.resolvePrunedToolsForStage`
- **Failure Scenario & Mechanism**:
  `GracefulDegradationMatrix` is defined with 3-tier capability fallbacks and dynamic stage tool pruning.
  However, in `engine.ts`, toolsets are hardcoded (`stage1Tools = ["read", "write", "bash", "powershell", "grep", "find"]`).
  In `index.ts`, `GracefulDegradationMatrix` is imported on line 10 but never instantiated or used.
  **Impact**: The entire graceful degradation subsystem is dead code at runtime.
- **Reproduction Hypothesis & Trigger Input**:
  Running on an environment lacking `edit` tool.
  Tools fail to degrade to `write` because matrix is never invoked.
- **Actionable Refactoring Solution**:
  Instantiate `GracefulDegradationMatrix` in `index.ts` and use it during stage initialization and blueprint synthesis.

---

### 3.2 [RES-DG-02] Self-Healing Livelock & Query Side-Effect State Corruption
- **File & Lines**: `state.ts:404`, `state.ts:424`, `state.ts:437`, `state.ts:462`, `state.ts:510`, `index.ts:338-340`, `index.ts:409-417`
- **Code Symbols**: `verifyStageArtifacts`, `state.retryCount`, `state.status`
- **Failure Scenario & Mechanism**:
  1. `verifyStageArtifacts()` in `state.ts` mutates `state.retryCount = (state.retryCount || 0) + 1;` every time verification fails.
  2. If `/sop` or a status inspector calls `verifyStageArtifacts()`, `retryCount` increments on every query. Two `/sop` calls burn through the 3-retry budget without any agent action.
  3. When `retryCount >= 3`, `isCircuitBroken` becomes `true`. But `state.status` remains `"in_progress"`.
  4. On subsequent turn ends, `if (state.retryCount >= 3) return;` skips execution silently. The workflow is permanently frozen in `"in_progress"` without notifying the user or triggering recovery.
- **Reproduction Hypothesis & Trigger Input**:
  1. Stage fails initial verification (`retryCount = 1`).
  2. User runs `/sop` twice. `verifyStageArtifacts` runs twice. `retryCount` becomes 3.
  3. Stage is circuit-broken prematurely. Agent is never given a chance to self-heal.
- **Actionable Refactoring Solution**:
  - Make `verifyStageArtifacts` a pure read-only check with optional `incrementRetry: boolean = false`.
  - In `index.ts`, set `state.status = "blocked"` when circuit broken and emit clear recovery prompts (`/blueprint rollback` or `/blueprint retry`).

---

### 3.3 [RES-DG-03] Missing Exponential Backoff, Jitter & Circuit Breaker Reset
- **File & Lines**: `index.ts:413-416`, `state.ts:404-418`
- **Code Symbols**: `verifyStageArtifacts`, `pi.sendUserMessage`
- **Failure Scenario & Mechanism**:
  Retries are triggered immediately (0ms delay).
  Transient locks (`EBUSY`) or compilation races exhaust the 3 retries within milliseconds.
  No half-open probing state exists to auto-recover when conditions clear.
- **Reproduction Hypothesis & Trigger Input**:
  Transient file lock during build. Retries trigger instantly, trip circuit breaker, and halt the pipeline.
- **Actionable Refactoring Solution**:
  Record `lastFailureTime` and compute backoff $T = 1000 \times 2^{\text{retryCount}} + \text{jitter}$.

---

### 3.4 [RES-DG-04] Design Stage Tool Over-Pruning (Write Block Deadlock)
- **File & Lines**: `degradation_matrix.ts:130-136`
- **Code Symbols**: `resolvePrunedToolsForStage("design")`
- **Failure Scenario & Mechanism**:
  For `design` stage: `blockedTools: ["write", "edit", "bash"]`.
  In `engine.ts`, the `design` stage requires artifact `docs/design.md`.
  If `write` is blocked, the agent cannot write `docs/design.md`, causing guaranteed stage failure and deadlock.
- **Reproduction Hypothesis & Trigger Input**:
  Apply `resolvePrunedToolsForStage("design")` to Stage 1. Agent cannot output `docs/design.md`.
- **Actionable Refactoring Solution**:
  Allow `write` in design stages, scoped via `BlastRadiusGuard` to `docs/**`.

---

### 3.5 [RES-DG-05] Windows Platform Incompatible Shell Fallbacks
- **File & Lines**: `degradation_matrix.ts:36`, `degradation_matrix.ts:43`, `degradation_matrix.ts:90`, `degradation_matrix.ts:97`, `degradation_matrix.ts:118`
- **Code Symbols**: `GracefulDegradationMatrix.resolveCapability`
- **Failure Scenario & Mechanism**:
  Hardcoded fallback tool `"bash"` fails on Windows environments lacking Git Bash or WSL (`ENOENT: spawn bash`).
- **Reproduction Hypothesis & Trigger Input**:
  Run capability fallback on Windows PowerShell without `bash.exe`.
- **Actionable Refactoring Solution**:
  Check `process.platform === "win32"` and fallback to `"powershell"` on Windows.

---

## Part 4: Deep Audit of `memory.ts`

### 4.1 [RES-MM-01] Unbounded Growth & Prompt Token Budget Blowout
- **File & Lines**: `memory.ts:63-65`, `memory.ts:78-81`
- **Code Symbols**: `CodebaseMemoryManager.recordLesson`, `CodebaseMemoryManager.getPromptContextInjection`
- **Failure Scenario & Mechanism**:
  `recordLesson()` continuously appends lessons without maximum capacity limits, sliding window compaction, or token budgeting.
  `getPromptContextInjection()` concatenates every lesson into prompt on every turn.
  Over time, memory prompt balloons to thousands of tokens, violating the 0-Token / minimal overhead principle and risking model context window overflow.
- **Reproduction Hypothesis & Trigger Input**:
  Record 50 lessons. `getPromptContextInjection()` outputs 3,000+ tokens on every turn.
- **Actionable Refactoring Solution**:
  Implement rolling window compaction (max 15 lessons, max 500 tokens), relevance scoring, and LRU eviction.

```diff
--- a/memory.ts
+++ b/memory.ts
@@ -62,3 +62,10 @@
     if (existingIndex >= 0) {
       store.lessons[existingIndex] = newLesson;
     } else {
+      // 滚动窗口压缩：严控最大条目数 (最多保留最新 15 条高价值经验)
+      if (store.lessons.length >= 15) {
+        store.lessons.sort((a, b) => b.timestamp - a.timestamp);
+        store.lessons = store.lessons.slice(0, 14);
+      }
       store.lessons.push(newLesson);
     }
```

---

### 4.2 [RES-MM-02] Ground-Truth Primacy Conflict & Stale Directive Poisoning
- **File & Lines**: `memory.ts:49-71`, `memory.ts:78-81`
- **Code Symbols**: `CodebaseMemoryManager`
- **Failure Scenario & Mechanism**:
  Lessons stored in `architecture_memory.json` are never reconciled against live disk state (`package.json`, `tsconfig.json`).
  If a project migrates from CommonJS to ESM, a stale memory lesson ("Always use require()") continues to be injected into prompts, causing the LLM to write broken code that directly contradicts the actual codebase files.
- **Reproduction Hypothesis & Trigger Input**:
  Memory stores `Use CommonJS`. Project migrates to ESM (`"type": "module"`). LLM writes `require()`, triggering runtime syntax errors.
- **Actionable Refactoring Solution**:
  Add ground-truth verification hooks to validate stored conventions against live disk configuration before prompt injection.

---

### 4.3 [RES-MM-03] Non-Atomic Writes & Concurrent Multi-Agent Race Conditions
- **File & Lines**: `memory.ts:49-70`
- **Code Symbols**: `CodebaseMemoryManager.recordLesson`
- **Failure Scenario & Mechanism**:
  `recordLesson` reads and synchronously writes to `architecture_memory.json`.
  In parallel multi-agent executions, concurrent writes overwrite each other. If interrupted mid-write, the file is left with corrupted JSON, resetting the memory store to empty.
- **Reproduction Hypothesis & Trigger Input**:
  Two subagents simultaneously call `recordLesson`. One write is lost.
- **Actionable Refactoring Solution**:
  Use atomic temporary file write and rename (`fs.renameSync`) with in-memory lock.

---

### 4.4 [RES-MM-04] Complete Runtime Pipeline Disconnect (Orphaned Subsystem)
- **File & Lines**: `index.ts:1-420`, `engine.ts:1-1132`
- **Code Symbols**: `CodebaseMemoryManager`
- **Failure Scenario & Mechanism**:
  `CodebaseMemoryManager` is implemented in `memory.ts`, but neither `index.ts` nor `engine.ts` imports or invokes `recordLesson` or `getPromptContextInjection`.
  The entire architectural memory system is completely orphaned and never operates during user tasks.
- **Reproduction Hypothesis & Trigger Input**:
  Run full ToolFlow task. Check `.pi/toolflow/memory/architecture_memory.json` -> never created or updated.
- **Actionable Refactoring Solution**:
  Wire `CodebaseMemoryManager` into `runTaskDecisionPipeline` in `index.ts` and `diagnoseTaskRequirements` in `engine.ts`.

---

## Part 5: Prioritized Remediation Roadmap

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        PRIORITIZED REMEDIATION ROADMAP                                 │
├───────────┬───────────────────────────────────┬──────────────┬─────────────────────────┤
│ Phase     │ Scope                             │ Target Files │ Expected Impact         │
├───────────┼───────────────────────────────────┼──────────────┼─────────────────────────┤
│ Phase 1   │ Glob Matching & Windows Normalization │ blast_radius.ts │ Fixes false blocks on   │
│ (P0)      │ Fix (SEC-BR-01, SEC-BR-02, 03, 06)│              │ multi-file implementation│
├───────────┼───────────────────────────────────┼──────────────┼─────────────────────────┤
│ Phase 2   │ Self-Healing Read-Only Query Fix   │ state.ts     │ Eliminates premature    │
│ (P0)      │ & Subsystem Wiring (RES-DG-01, 02)│ index.ts     │ circuit break & livelock│
├───────────┼───────────────────────────────────┼──────────────┼─────────────────────────┤
│ Phase 3   │ LRU Quota, OOM Guard & Atomic I/O │ dehydrator.ts│ Prevents disk leak, OOM │
│ (P1)      │ (RES-DH-01, RES-DH-02, 03)        │              │ & corrupted handoffs    │
├───────────┼───────────────────────────────────┼──────────────┼─────────────────────────┤
│ Phase 4   │ Rolling Window Memory & Ground-Truth│ memory.ts    │ Enforces 0-Token budget │
│ (P1)      │ Reconciler (RES-MM-01, 02, 03, 04)│ index.ts     │ & wires memory pipeline │
└───────────┴───────────────────────────────────┴──────────────┴─────────────────────────┘
```
