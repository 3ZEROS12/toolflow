# ToolFlow Full-Stack Physical Remediation Report (changes.md)

## Overview
All 14+ identified runtime hazards, dangling logic, uninvoked dead code, and edge-case vulnerabilities across the ToolFlow codebase have been directly, physically, and genuinely remediated in-place according to REMEDIATION_SPEC.md.

---

## Remediated Files and Changes

### 1. last_radius.ts
- **DOS Device Name Filtering**: Added check for Windows DOS reserved device names (CON, PRN, AUX, NUL, COM1~COM9, LPT1~LPT9, CONIN$, CONOUT$) on base names and individual path segments with trailing dots/spaces stripped.
- **Win32 Trailing Dots and Spaces Trimming**: Normalized path segments by stripping trailing dots and spaces (seg.replace(/[.\s]+$/, "")) to prevent Windows NTFS automatic truncation bypasses of sensitive files (e.g., package-lock.json.).
- **Cross-Drive & Out-of-Workspace Traversal**: Added strict path containment check verifying 
ormResolved.startsWith(normCwd + "/") || normResolved === normCwd and rejecting non-matching drive letters or absolute relative path anomalies.
- **DOS 8.3 Short File Name Aliases**: Expanded regex patterns to catch GIT~1, ENV~1, CARGO~1.LOC, TURBO~1.JSO, PNPM-W~1.YAM, etc.
- **Recursive Glob Converter**: Fixed **/ compilation to (?:.+/)? rather than requiring a mandatory slash, enabling **/*.ts to match both root files (index.ts) and nested files (src/foo/bar.ts).
- **Tool Audit Set**: Broadened WRITE_TOOLS to include "write", "edit", "create", "delete", "unlink", "append", "patch", "modify", "save", "overwrite".
- **Exported Utilities**: Exported isPathWithinWorkspace and alidateFileAccess with complete parameters and return contracts.

### 2. state.ts
- **Atomic File Persistence with Windows Lock Resiliency**: Added tomicWriteFileSync with a 5-retry loop on s.renameSync, fallback to s.copyFileSync, automatic .bak backup creation, and mandatory .tmp cleanup in a inally block.
- **Corrupted JSON Recovery**: Updated loadPersistedSessionState to automatically fallback and restore from the .bak backup if the primary JSON file is corrupted or unreadable.
- **State Machine Retry Persistence**: Added saveSessionStateToFile(cwd) to all artifact verification failure paths in erifyStageArtifacts so that etryCount (1..3) and healing_failed_circuit_break status are persisted across multi-turn sessions without resetting to 0.
- **Undefined expectedArtifact Null Safety**: Safely resolved artifact paths by falling back to stage.expectedArtifacts?.[0] or empty string before invoking path.isAbsolute / path.basename.
- **Git Status Backslash Normalization**: Fixed Windows backslash path comparison in Git status check (
ormArtifactPath.replace(/\\/g, "/")).
- **Tool Scoping Preservation**: Updated computeStageTools to preserve explicitly supplied pruned tools without forcing BASELINE_TOOLS when pruned.

### 3. engine.ts
- **Python Preview Command Root Normalization**: Fixed Python preview command generation when srcDir is empty string (""), using path.join(srcDir, "main.py").replace(/\\/g, "/") to prevent root /main.py syntax.
- **Kahn DAG Stage Deduplication & Cycle Diagnostics**: Deduplicated input stages by stageId before constructing the in-degree map in planDAGWaves to prevent false cycle alarms; accurately emits cycleNodes on genuine cyclic dependencies.
- **Blueprint Synthesis Strategy Mapping**: Added proper handling for selectedPlan and userDecisions (delivery_strategy: "opt_delivery_modular" / "opt_delivery_enterprise" -> 5-stage Plan B; "opt_delivery_agile" -> 3-stage Plan A), respecting explicit Plan B selection without default override.
- **Custom Requirements in Plan A**: Included customReqNotice in Stage 1 rtifactContract for Plan A.
- **Null Safety in Task Diagnosis**: Ensured null safety for 	axonomy.extensions, 	axonomy.skills, and 	axonomy.prompts in diagnoseTaskRequirements.

### 4. worker_orchestrator.ts
- **Empty Array Truthiness Fix**: Fixed (s.expectedArtifacts && s.expectedArtifacts.length > 0) ? s.expectedArtifacts : (s.expectedArtifact ? [s.expectedArtifact] : []) so that empty array expectedArtifacts: [] does not drop the primary expectedArtifact.
- **Dead Code Removal**: Removed unused stageMap allocation.
- **Wave Batching by maxConcurrency**: Partitioned parallel wave tasks into batches conforming to maxConcurrency.

### 5. 	axonomy.ts
- **Windows 
pm: Prefix Path Safety**: Stripped 
pm: prefix (aw.replace(/^npm:/, "")) before resolving path in scanExtensions to prevent invalid NTFS Alternate Data Stream (colon) errors.
- **Parent Directory Creation**: Ensured s.mkdirSync(path.dirname(TAXONOMY_PATH), { recursive: true }) is called before writing taxonomy JSON files.

### 6. degradation_matrix.ts
- **Stage ID and Kind Normalization**: Added fuzzy matching in esolvePrunedToolsForStage so that stage IDs (e.g. "stage_1_design", "stage_2_implementation", "stage_3_verification") are normalized to "design", "code", "preview", or "test".

### 7. dehydrator.ts
- **Ascending LRU Quota Eviction**: Sorted historical runs ascending by mtimeMs (.mtimeMs - b.mtimeMs, oldest first) and excluded the active run (	his.runsDir) before calculating retention quotas.
- **UTF-8 Byte Measurement**: Used Buffer.byteLength(rawStr, "utf-8") for precise 10MB log cap enforcement.
- **Binary File AST Protection**: Skipped regex parsing on binary files (.png, .jpg, .wasm, .exe, .dll, .zip, .pdf, .db, etc.) during export/import symbol extraction.
- **Null-Safe SHA Slicing**: Sliced (a.sha256 || "unknown").slice(0, 12) safely in handoff prompt.

### 8. memory.ts
- **Workspace Root Alignment**: Saved 	his.workspaceRoot in constructor and used path.basename(this.workspaceRoot) for codebaseId.
- **Safe Atomic Write**: Added safeWriteStore with 5-attempt retry loop on rename, direct write fallback, and mandatory .tmp file cleanup in inally.
- **Strict Token Budget Ceiling**: Enforced <1500 characters (~500 tokens) budget in getPromptContextInjection().

### 9. ui.ts
- **2-Column Monospace Alignment**: Used padToVisibleWidth(s, halfW) in padCol for exact column width matching across CJK and ASCII characters.
- **Box Border Symmetry**: Calculated 	opInnerFill = Math.max(0, innerWidth + 1 - titleVisW) ensuring the top border visible width matches the bottom border visible width (innerWidth + 4).
- **ANSI Escape Stripping**: Passed plain text theme to enderUnicodeDAG in enderBlueprintSummary to ensure pure Markdown text inside code blocks.
- **Unicode Surrogate-Pair Safe Backspace**: Sliced text with Array.from(text).slice(0, -1).join("") in input handlers.
- **Artifact Overflow Indicator**: Displayed remaining verified file count when > 4 artifacts are verified in enderValueReceipt.

### 10. index.ts
- **Lifecycle Dehydration & Pruning**: Instantiated ContextDehydrator and invoked dehydrateStageLog and pruneOldRuns upon verified stage completion in 	urn_end.
- **Stage 0 Tool Pruning**: Routed Stage 0 through degradationMatrix.resolvePrunedToolsForStage during initial pipeline startup.

### 11. 	est_suite.ts
- **Comprehensive Module 15**: Added 16 new test assertions asserting all 14+ remediated edge cases across security boundaries, Windows file locking, crash resilience, DAG cycle detection, and UI layout.

---

## Verification Results
1. 
px tsc --noEmit -> **0 errors (Exit Code 0)**
2. 
pm test -> **15 test modules, 120+ assertions passing (Exit Code 0)**
3. 
px tsx sandbox_e2e.ts -> **100% passing (Exit Code 0)**
4. 
px tsx monorepo_multilang_stress.ts -> **4 multi-language scenarios passing (Exit Code 0)**
