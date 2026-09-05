# ToolFlow Codebase Robustness & Completeness Analysis Report

**Investigator**: `explorer_robustness_1`  
**Target Workspace**: `C:\Users\Jason\.pi\agent\extensions\toolflow`  
**Timestamp**: 2026-09-02T05:10:00Z  
**Scope**: `dehydrator.ts`, `memory.ts`, `ui.ts`, `index.ts`, `types.ts`, `test_suite.ts`, `sandbox_e2e.ts`, `monorepo_multilang_stress.ts`

---

## Executive Summary

A comprehensive, line-by-line inspection of the ToolFlow codebase was conducted to identify runtime hazards, edge-case boundary loopholes, uninvoked logic, formatting distortions, and test coverage gaps.

| Focus Area | Primary File | Severity | Key Finding |
|---|---|---|---|
| **1. Dehydrator** | `dehydrator.ts` | **P1 (High)** | **Inverted LRU Quota Eviction**: Disk quota loop evicts newest folders (MRU) first when `totalDiskBytes` exceeds 200MB instead of oldest folders (LRU). String length vs byte length unit mismatch on 10MB cap. Binary artifact AST parsing hazard. |
| **2. Memory Manager** | `memory.ts` | **P2 (Medium)** | `fs.renameSync` failure on Windows drops memory silently and leaks orphaned `.tmp` files. `codebaseId` ignores `workspaceRoot`. Lack of explicit <500 Token ceiling enforcement on context injection. |
| **3. UI & TUI Formatting** | `ui.ts` | **P1 (High)** | **Overview 2-Column Table Jitter**: `padCol` uses `truncateToWidth` without space padding, causing column separator `│` to jump erratically across lines. Top box border is 1 character narrower than body. ANSI sequences leak into Markdown code blocks. Surrogate pair slicing on backspace. |
| **4. Subsystem Lifecycle** | `index.ts`, `types.ts` | **P2 (Medium)** | `ContextDehydrator` is imported in `index.ts` but never instantiated or connected to stage handoff lifecycle. Stage 0 launch bypasses `GracefulDegradationMatrix` tool pruning. |
| **5. Test Suite & Assertions** | `test_suite.ts` | **P2 (Medium)** | Missing byte-quota eviction test, missing surrogate backspace test, missing 2-column TUI width test, missing Stage 0 tool pruning integration test. |

---

## Focus Area 1: Context Dehydrator (`dehydrator.ts`)

### Issue 1.1: Inverted LRU Quota Eviction under Total Disk Byte Pressure
- **Location**: `dehydrator.ts:72-85`
- **Code Observation**:
  ```ts
  const runFolders = entries
    .filter(e => e.isDirectory())
    .map(e => { ... })
    .sort((a, b) => b.mtimeMs - a.mtimeMs); // 降序，最新在前面 (Index 0 is Newest)

  let totalSize = runFolders.reduce((acc, f) => acc + f.sizeBytes, 0);

  for (let i = 0; i < runFolders.length; i++) {
    const folder = runFolders[i];
    if (folder.fullPath === this.runsDir) continue;

    const isTooOld = now - folder.mtimeMs > maxAgeMs;
    const isExceedingCount = i >= maxRuns;
    const isExceedingQuota = totalSize > maxDiskBytes;

    if (isTooOld || isExceedingCount || isExceedingQuota) {
      fs.rmSync(folder.fullPath, { recursive: true, force: true });
      totalSize -= folder.sizeBytes;
      deletedDirs.push(folder.name);
    }
  }
  ```
- **Failure Scenario**:
  When `totalSize > maxDiskBytes` (e.g. historical runs total 220MB > 200MB), the loop starts at `i = 0`. Because `isExceedingQuota` is `true`, `runFolders[0]` (the **newest** historical run folder) is deleted first! The loop continues deleting the newest runs until `totalSize <= maxDiskBytes`. The oldest stale runs at the end of the array are preserved while recent run snapshots are destroyed.
- **Remediation**:
  Separate count/age filtering from disk quota eviction, or sort oldest-first for quota pruning so that oldest folders are evicted first until `totalSize <= maxDiskBytes`.

```ts
// Proposed Fix in dehydrator.ts:
public pruneOldRuns(
  maxRuns: number = 10,
  maxAgeMs: number = 7 * 24 * 60 * 60 * 1000,
  maxDiskBytes: number = MAX_TOTAL_DISK_BYTES
): string[] {
  const deletedDirs: string[] = [];
  try {
    if (!fs.existsSync(this.baseDir)) return deletedDirs;
    const entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
    const runFolders = entries
      .filter(e => e.isDirectory())
      .map(e => {
        const fullPath = path.join(this.baseDir, e.name);
        const stat = fs.statSync(fullPath);
        const sizeBytes = this.getDirectorySizeBytes(fullPath);
        return { name: e.name, fullPath, mtimeMs: stat.mtimeMs, sizeBytes };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs); // 升序，最旧在前面 (Index 0 is Oldest)

    const now = Date.now();
    let totalSize = runFolders.reduce((acc, f) => acc + f.sizeBytes, 0);
    const retained = [...runFolders];

    for (const folder of runFolders) {
      if (folder.fullPath === this.runsDir) continue;

      const isTooOld = now - folder.mtimeMs > maxAgeMs;
      const isExceedingCount = retained.length > maxRuns;
      const isExceedingQuota = totalSize > maxDiskBytes;

      if (isTooOld || isExceedingCount || isExceedingQuota) {
        try {
          fs.rmSync(folder.fullPath, { recursive: true, force: true });
          totalSize -= folder.sizeBytes;
          const idx = retained.findIndex(r => r.name === folder.name);
          if (idx >= 0) retained.splice(idx, 1);
          deletedDirs.push(folder.name);
        } catch (_) {}
      }
    }
  } catch (_) {}
  return deletedDirs;
}
```

---

### Issue 1.2: Character Length vs Byte Length Mismatch on 10MB Log Truncation
- **Location**: `dehydrator.ts:20, 112-116`
- **Code Observation**:
  ```ts
  const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024;
  ...
  if (typeof rawLogs === "string" && rawLogs.length > MAX_LOG_SIZE_BYTES) {
    const head = rawLogs.slice(0, 2 * 1024 * 1024);
    const tail = rawLogs.slice(-2 * 1024 * 1024);
    sanitizedLogs = `${head}\n\n... [TOOLFLOW LOG TRUNCATED...] ...\n\n${tail}`;
  }
  ```
- **Failure Scenario**:
  `rawLogs.length` measures UTF-16 code units. For multibyte logs (e.g. CJK terminal logs, binary diffs, non-ASCII stack traces), a log with 6,000,000 characters could consume 18MB on disk, bypassing the 10MB ceiling check. Furthermore, if `rawLogs` is null/undefined or a non-string object, `rawLogs.length` could fail.
- **Remediation**:
  ```ts
  const rawStr = typeof rawLogs === "string" ? rawLogs : String(rawLogs ?? "");
  const byteLen = Buffer.byteLength(rawStr, "utf-8");
  if (byteLen > MAX_LOG_SIZE_BYTES) {
    const head = rawStr.slice(0, 1024 * 1024);
    const tail = rawStr.slice(-1024 * 1024);
    sanitizedLogs = `${head}\n\n... [TOOLFLOW LOG TRUNCATED: Exceeded 10MB safety cap, original size: ${byteLen} bytes] ...\n\n${tail}`;
  }
  ```

---

### Issue 1.3: Binary Artifact AST Regex Extraction Hazard
- **Location**: `dehydrator.ts:125-154`
- **Code Observation**:
  `dehydrateStageLog` iterates through all verified `artifacts: ArtifactRecord[]` and executes `fs.readFileSync(art.path, "utf-8").slice(0, 32768)` followed by ECMAScript import/export regular expressions.
- **Failure Scenario**:
  If a stage outputs a binary artifact (e.g., `favicon.ico`, `logo.png`, `sqlite.db`, `bundle.wasm`), reading as UTF-8 and matching regex patterns is CPU-inefficient and may extract nonsensical export tokens or trigger decoding errors.
- **Remediation**:
  Filter `art.path` by file extension (e.g., `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.py`, `.rs`, `.go`, `.java`, `.cpp`, `.c`, `.h`, `.cs`, `.rb`, `.php`) before reading and running AST regexes.

---

### Issue 1.4: Artifact Hash Staleness & Safe String Slicing
- **Location**: `dehydrator.ts:175-177`
- **Code Observation**:
  ```ts
  .map(a => `  - 产物: \`${a.path}\` (${a.sizeBytes} bytes, SHA: \`${a.sha256.slice(0, 12)}\`)`)
  ```
- **Failure Scenario**:
  If `a.sha256` is empty or shorter than 12 chars, `a.sha256.slice(0, 12)` handles safely in JS, but if `a.sha256` is undefined/null, it throws a `TypeError: Cannot read properties of undefined (reading 'slice')`.
- **Remediation**:
  Use `(a.sha256 || "unknown").slice(0, 12)`.

---

## Focus Area 2: Memory Manager (`memory.ts`)

### Issue 2.1: `codebaseId` Workspace Path Discrepancy
- **Location**: `memory.ts:26, 46`
- **Code Observation**:
  ```ts
  constructor(workspaceRoot: string = process.cwd()) {
    const memoryDir = path.join(workspaceRoot, ".pi", "toolflow", "memory");
    ...
  }
  public loadMemory(): CodebaseMemoryStore {
    ...
    return {
      version: "1.0.0",
      codebaseId: path.basename(process.cwd()), // Always uses process.cwd() instead of workspaceRoot!
      ...
    };
  }
  ```
- **Failure Scenario**:
  When `CodebaseMemoryManager` is instantiated with a custom `workspaceRoot` (e.g. in multi-crate monorepos or test workspaces), `loadMemory()` still reads `process.cwd()` as `codebaseId`, causing metadata confusion across workspaces.
- **Remediation**:
  Store `private workspaceRoot: string;` in the class and use `path.basename(this.workspaceRoot)`.

---

### Issue 2.2: Windows `fs.renameSync` Lock & Dangling `.tmp` File Leaks
- **Location**: `memory.ts:78-83, 93-98`
- **Code Observation**:
  ```ts
  try {
    const tempPath = `${this.memoryFilePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(store, null, 2), "utf-8");
    fs.renameSync(tempPath, this.memoryFilePath);
  } catch (_) {}
  ```
- **Failure Scenario**:
  On Windows, `fs.renameSync` fails with `EPERM` or `EBUSY` if the destination file is open or locked by a file watcher, antivirus scanner, or parallel process. When this occurs, the catch block silently ignores the error, leaving the newly written `.tmp.${process.pid}.${Date.now()}` file abandoned on disk, and failing to save the memory store.
- **Remediation**:
  In the `catch` block, safely remove `tempPath` and fallback to direct write `fs.writeFileSync(this.memoryFilePath, ...)`:

```ts
private safeWriteStore(store: CodebaseMemoryStore): void {
  const tempPath = `${this.memoryFilePath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(store, null, 2), "utf-8");
    fs.renameSync(tempPath, this.memoryFilePath);
  } catch (_) {
    try {
      fs.writeFileSync(this.memoryFilePath, JSON.stringify(store, null, 2), "utf-8");
    } catch (_) {}
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (_) {}
  }
}
```

---

### Issue 2.3: Unbounded Token Growth in `getPromptContextInjection` (<500 Token Ceiling)
- **Location**: `memory.ts:101-110`
- **Code Observation**:
  ```ts
  public getPromptContextInjection(): string {
    const store = this.loadMemory();
    if (store.lessons.length === 0 && store.conventions.length === 0) {
      return "";
    }
    const lines = ["\n[Codebase 历史架构与避坑记忆 (Memory Directives)]:"];
    store.conventions.forEach(c => lines.push("- 仓库规范: " + c));
    store.lessons.slice(-MAX_LESSONS).forEach(l => lines.push("- " + l.topic + ": " + l.rule + " (" + l.rationale + ")"));
    return lines.join("\n");
  }
  ```
- **Failure Scenario**:
  If 10 conventions and 15 lessons with long rationales are stored, the generated prompt snippet can exceed 3,500 characters (~900 tokens), violating the strict <500 Token (<1,500 character) budget for context injection.
- **Remediation**:
  Truncate individual lesson strings (e.g. max 80 chars per rationale) and enforce a total character cap of 1,500 characters on the returned string.

---

### Issue 2.4: Sync with Workspace `MEMORY.md` Directives
- **Location**: `memory.ts:34-51`
- **Observation**:
  `CodebaseMemoryManager` only reads `.pi/toolflow/memory/architecture_memory.json`. If a project already has a root `MEMORY.md` containing `## 🛡️ Hard-Learned Lessons & Guardrails` or conventions, `CodebaseMemoryManager` does not parse or absorb those rules.
- **Remediation**:
  Add optional helper `syncWithRootMemoryMd(workspaceRoot)` to parse lines matching `- 【... -> ...】` or `- 仓库规范: ...` from `MEMORY.md` into the memory store.

---

## Focus Area 3: UI & TUI Monospace Formatting (`ui.ts`)

### Issue 3.1: Overview 2-Column Table Column Jitter / Severe Monospace Misalignment
- **Location**: `ui.ts:277-285`
- **Code Observation**:
  ```ts
  const halfW = Math.floor((innerWidth - 3) / 2);
  const padCol = (s: string, w: number) => truncateToWidth(s, w, "", true);

  lines.push(`${theme.bold(theme.fg("accent", padCol(" 通用基础工具", halfW)))} │ ${theme.bold(theme.fg("accent", padCol(" 专业与业务扩展", halfW)))}`);
  lines.push(`${padCol(`  • 基础工具: ${theme.fg("dim", l1Exts.join(", ") || "none")}`, halfW)} │ ${padCol(`  • 在线查阅: ${theme.fg("dim", l2Exts.join(", ") || "none")}`, halfW)}`);
  ```
- **Failure Scenario**:
  `truncateToWidth(s, w, "", true)` only truncates if `visibleWidth(s) > w`. If `visibleWidth(s) < w`, it leaves `s` untouched without padding trailing spaces!
  For example, `" 通用基础工具"` has visible width 13. If `halfW` is 45, it is NOT padded to 45 columns. Consequently, the separator ` │ ` is placed at column 14 instead of column 46!
  Each row places the ` │ ` divider at a different column, causing the two-column layout to completely collapse into jagged lines.
- **Remediation**:
  Use `padToVisibleWidth` so that every column is padded with spaces up to exactly `halfW` visible columns:
  ```ts
  const padCol = (s: string, w: number) => padToVisibleWidth(s, w);
  ```

---

### Issue 3.2: Box Border Asymmetric Width Calculation (1-char Notch)
- **Location**: `ui.ts:452-464`
- **Code Observation**:
  ```ts
  const titleVisW = visibleWidth(" ToolFlow "); // 10
  const topInnerFill = Math.max(0, innerWidth + 2 - 2 - titleVisW); // = innerWidth - titleVisW
  const topBorder = truncateToWidth(
    borderColor("╭─") + title + borderColor("─".repeat(topInnerFill)) + borderColor("╮"),
    width, "", true
  );
  const botBorder = truncateToWidth(
    borderColor(`╰${"─".repeat(Math.max(0, innerWidth + 2))}╯`),
    width, "", true
  );
  ```
- **Visible Width Arithmetic**:
  - `topBorder`: `"╭─"` (2) + `" ToolFlow "` (10) + `"─" * (innerWidth - 10)` + `"╮"` (1) = `2 + 10 + (innerWidth - 10) + 1 = innerWidth + 3`.
  - `botBorder`: `"╰"` (1) + `"─" * (innerWidth + 2)` + `"╯"` (1) = `1 + (innerWidth + 2) + 1 = innerWidth + 4`.
  - Content lines (`wrapAndBg`): `"│ "` (2) + `content` (`innerWidth`) + `" │"` (2) = `innerWidth + 4`.
- **Failure Scenario**:
  `topBorder` is exactly 1 character narrower than `botBorder` and all body lines (`innerWidth + 3` vs `innerWidth + 4`). This creates an asymmetric 1-column notch on the top-right corner of the TUI box.
- **Remediation**:
  Set `topInnerFill = Math.max(0, innerWidth + 1 - titleVisW)`.
  Then `topBorder` width = `2 + titleVisW + (innerWidth + 1 - titleVisW) + 1 = innerWidth + 4`, perfectly matching the rest of the box.

---

### Issue 3.3: Raw ANSI Escape Sequences in Markdown Code Blocks
- **Location**: `ui.ts:55-67, 158-161`
- **Code Observation**:
  ```ts
  export function renderUnicodeDAG(stages: BlueprintStage[], options?: { ... theme?: any; }): string[] {
    const theme = options?.theme || {
      bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
      fg: (_color: string, s: string) => s,
    };
    ...
  }
  ...
  export function renderBlueprintSummary(bp: Blueprint): string {
    ...
    const dagLines = renderUnicodeDAG(bp.stages);
    lines.push("```text");
    lines.push(...dagLines);
    lines.push("```");
  }
  ```
- **Failure Scenario**:
  `renderBlueprintSummary` calls `renderUnicodeDAG(bp.stages)` without passing a theme. `renderUnicodeDAG` defaults to ANSI codes (`\x1b[1m`), embedding raw ANSI sequences inside the markdown ` ```text ` block. When rendered in Markdown clients, users see raw escape characters like `\x1b[1m[阶段 1]...`.
- **Remediation**:
  In `renderUnicodeDAG`, default `bold: (s: string) => s` when no theme is provided, or pass `{ bold: s => s, fg: (_c, s) => s }` inside `renderBlueprintSummary`.

---

### Issue 3.4: Unicode Surrogate Pair Slicing on Backspace
- **Location**: `ui.ts:632, 663`
- **Code Observation**:
  ```ts
  // In refining state (line 632):
  customRequirementsText = customRequirementsText.slice(0, -1);
  // In custom_option_input state (line 663):
  newOptionTitle = newOptionTitle.slice(0, -1);
  ```
- **Failure Scenario**:
  In `state === "input"` (line 504), `Array.from(inputTask).slice(0, -1).join("")` is correctly used. But in `refining` and `custom_option_input`, `.slice(0, -1)` is used. If the user types an Emoji (e.g. 🚀) or 4-byte CJK character and presses backspace, `.slice(0, -1)` strips only the low surrogate, corrupting the string with an invalid dangling surrogate `\uD83D`.
- **Remediation**:
  Use `Array.from(customRequirementsText).slice(0, -1).join("")` and `Array.from(newOptionTitle).slice(0, -1).join("")`.

---

### Issue 3.5: Truncated Artifact Count Indicator in `renderValueReceipt`
- **Location**: `ui.ts:42-44`
- **Code Observation**:
  ```ts
  for (const f of metrics.verifiedFiles.slice(0, 4)) {
    rows.push(`| ${padToVisibleWidth(`  [x] ${f}`, w - 2)} |`);
  }
  ```
- **Failure Scenario**:
  If a project delivers 8 artifacts across 5 stages, only the first 4 files are shown and the remaining 4 are silently omitted without any indicator (such as `  [x] ... (还有 4 个物理产物已归档)`).
- **Remediation**:
  ```ts
  for (const f of metrics.verifiedFiles.slice(0, 4)) {
    rows.push(`| ${padToVisibleWidth(`  [x] ${f}`, w - 2)} |`);
  }
  if (metrics.verifiedFiles.length > 4) {
    const remaining = metrics.verifiedFiles.length - 4;
    rows.push(`| ${padToVisibleWidth(`  ... 另有 ${remaining} 个物理产物已通过 SHA 校验`, w - 2)} |`);
  }
  ```

---

## Focus Area 4: Subsystem Lifecycle Integration & Types (`index.ts`, `types.ts`)

### Issue 4.1: Unconnected Lifecycle Linkage for `ContextDehydrator` in `index.ts`
- **Location**: `index.ts:8, 363-393`
- **Code Observation**:
  Line 8 imports `ContextDehydrator`:
  ```ts
  import { ContextDehydrator } from "./dehydrator.js";
  ```
  However, `ContextDehydrator` is never instantiated or called anywhere in `index.ts`.
- **Failure Scenario**:
  When a stage completes and advances in `turn_end`, stage execution logs are not archived, AST topology hints are not extracted, and the next stage prompt is constructed manually with raw string interpolation rather than utilizing `dehydrator.dehydrateStageLog` and `dehydrator.formatHandoffPrompt`.
- **Remediation**:
  Instantiate `ContextDehydrator` in `index.ts` and integrate it into the `turn_end` stage advancement lifecycle:
  ```ts
  const dehydrator = new ContextDehydrator(process.cwd());
  ...
  // In turn_end when advancing stage:
  const handoff = dehydrator.dehydrateStageLog(
    currentStage.stageId,
    currentStage.title,
    `Stage ${state.currentStageIndex + 1} completed`,
    verificationResult.record ? [verificationResult.record] : [],
    currentStage.artifactContract
  );
  ```

---

### Issue 4.2: First Stage Bypasses `GracefulDegradationMatrix` Tool Scoping
- **Location**: `index.ts:114-120` vs `index.ts:369-370`
- **Code Observation**:
  - In `runTaskDecisionPipeline` (Stage 0 setup):
    ```ts
    const firstStage = blueprint.stages[0];
    if (firstStage) {
      blastGuard.updateAllowedScope(firstStage);
      if (firstStage.allowedTools) {
        applyToolScoping(firstStage.allowedTools, pi); // Direct scoping without degradationMatrix!
      }
    }
    ```
  - In `turn_end` (Subsequent stage advancement):
    ```ts
    const pruned = degradationMatrix.resolvePrunedToolsForStage(nextStage.stageId, nextStage.allowedTools);
    applyToolScoping(pruned.allowedTools, pi);
    ```
- **Failure Scenario**:
  If Stage 0 is a `design` stage, it bypasses `degradationMatrix.resolvePrunedToolsForStage("design", ...)` at startup, meaning tool pruning rules (e.g. blocking `edit` or `bash` in design phase) are not applied until Stage 1.
- **Remediation**:
  Route Stage 0 through `degradationMatrix.resolvePrunedToolsForStage(firstStage.stageId, firstStage.allowedTools)` in `runTaskDecisionPipeline`.

---

### Issue 4.3: Type Definitions Soundness in `types.ts`
- **Observation**:
  `types.ts` is well-structured with 279 lines covering all domain interfaces.
  A spot-check of all interfaces revealed:
  1. `SessionPlanState.status`: `"idle" | "awaiting_user_decisions" | "in_progress" | "stage_completed" | "completed" | "paused" | "healing_failed_circuit_break"` is sound and fully matches state machine transitions.
  2. `StageVerificationResult`: All properties (`valid`, `artifactPath`, `record`, `isCircuitBroken`, `remediationGuidance`, `retryCount`) are strongly typed.
  3. `ArchitectNavigatorResult`: Covers `task_input`, `resume_blueprint`, `decisions`, and `null`.

---

## Focus Area 5: Test Suite Coverage & Physical Assertions (`test_suite.ts`)

### Existing Test Suite Strengths
- 14 distinct test modules covering package name cleaning, multi-language fingerprint sniffing (Node, Rust, Python, Go, C++), Kahn DAG scheduling, 3-attempt self-healing circuit breakers, snapshot rollbacks, session persistence, blast radius glob matching, and multi-lang monorepo stress testing.

### Recommended Additional Assertions for 100% Verification
1. **Module 13 (or new Module 15) Extension**:
   - **Assertion 1**: Assert `ContextDehydrator.pruneOldRuns` evicts the **oldest** runs when total byte ceiling (200MB) is exceeded.
   - **Assertion 2**: Assert `padCol` in `ui.ts` produces equal visible width columns across diverse string lengths.
   - **Assertion 3**: Assert `ui.ts` top border visible width matches bottom border visible width (`innerWidth + 4`).
   - **Assertion 4**: Assert `renderUnicodeDAG` does not output ANSI escape sequences when rendered in plain-text / markdown mode.
   - **Assertion 5**: Assert backspace in `ui.ts` input fields correctly removes multi-byte Unicode surrogate pairs without dangling characters.
   - **Assertion 6**: Assert `CodebaseMemoryManager` enforces strict `<500 Token` limit on prompt injection.
   - **Assertion 7**: Assert Stage 0 tool scoping uses `GracefulDegradationMatrix.resolvePrunedToolsForStage`.

---

## Remediation Roadmap for Worker Agent

1. **Step 1 (`dehydrator.ts`)**:
   - Fix `pruneOldRuns` sort order and eviction logic for byte quota.
   - Update log truncation byte-length check and binary artifact filtering.
   - Safe slice `sha256`.

2. **Step 2 (`memory.ts`)**:
   - Fix `codebaseId` using `this.workspaceRoot`.
   - Implement `safeWriteStore` with `.tmp` unlink cleanup on failure and write fallback.
   - Add prompt injection character ceiling (<1500 chars / <500 tokens).

3. **Step 3 (`ui.ts`)**:
   - Fix `padCol` in overview mode with `padToVisibleWidth`.
   - Fix `topInnerFill = Math.max(0, innerWidth + 1 - titleVisW)` for exact border symmetry.
   - Fix ANSI escape sequences in `renderBlueprintSummary` DAG output.
   - Fix surrogate pair slicing in `refining` and `custom_option_input` backspace handlers.
   - Add "+ X more files" indicator in `renderValueReceipt`.

4. **Step 4 (`index.ts`)**:
   - Hook `ContextDehydrator` into the runtime lifecycle in `index.ts`.
   - Wrap Stage 0 tool scoping with `degradationMatrix.resolvePrunedToolsForStage`.

5. **Step 5 (`test_suite.ts`)**:
   - Add physical regression assertions for all 5 focus areas.
   - Run `npx tsc --noEmit`, `npm test`, `npx tsx sandbox_e2e.ts`, and `npx tsx monorepo_multilang_stress.ts`.
