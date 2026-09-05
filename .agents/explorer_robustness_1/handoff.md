# Handoff Report: ToolFlow Robustness & Completeness Inspection

**From**: `explorer_robustness_1`  
**To**: Worker / Orchestrator  
**Handoff Type**: Hard (Investigation Complete)  
**Date**: 2026-09-02T05:15:00Z  

---

## 1. Observation

Direct line-level observations from the codebase inspection:

1. **`dehydrator.ts:72-85`**:
   - `runFolders` is sorted in descending order: `.sort((a, b) => b.mtimeMs - a.mtimeMs)`.
   - The loop checks `isExceedingQuota = totalSize > maxDiskBytes` starting at index `i = 0`.
   - Result: Index 0 (the freshest run) is deleted first when the disk byte quota is exceeded.

2. **`dehydrator.ts:112-116`**:
   - `rawLogs.length > MAX_LOG_SIZE_BYTES` checks JavaScript character length (UTF-16 code units), not UTF-8 byte size.

3. **`dehydrator.ts:125-154`**:
   - `fs.readFileSync(art.path, "utf-8").slice(0, 32768)` followed by regex execution is run unconditionally on all artifacts including potential binary files.

4. **`memory.ts:46`**:
   - `codebaseId: path.basename(process.cwd())` ignores `this.workspaceRoot`.

5. **`memory.ts:79-82, 94-97`**:
   - `fs.renameSync(tempPath, this.memoryFilePath)` inside a silent `try...catch` leaves orphaned `.tmp` files and fails silently if `renameSync` encounters a Windows file lock (`EPERM`/`EBUSY`).

6. **`memory.ts:101-110`**:
   - `getPromptContextInjection()` concatenates up to 10 conventions and 15 lessons without a total token / character limit, potentially producing >3,500 chars (>900 tokens).

7. **`ui.ts:278-285`**:
   - `padCol = (s: string, w: number) => truncateToWidth(s, w, "", true)` does not pad shorter strings with trailing spaces.
   - Result: In `overview` 2-column mode, the column separator ` │ ` jumps erratically across lines.

8. **`ui.ts:452`**:
   - `topInnerFill = Math.max(0, innerWidth + 2 - 2 - titleVisW)` causes `topBorder` visible width to be `innerWidth + 3`, while `botBorder` and `wrapAndBg` lines are `innerWidth + 4`.

9. **`ui.ts:158-161`**:
   - `renderBlueprintSummary` calls `renderUnicodeDAG(bp.stages)` without a plain-text theme, emitting raw ANSI codes (`\x1b[1m`) inside the markdown ` ```text ` block.

10. **`ui.ts:632, 663`**:
    - `customRequirementsText.slice(0, -1)` and `newOptionTitle.slice(0, -1)` strip half of 4-byte Unicode surrogate pairs (emojis/CJK) on backspace.

11. **`index.ts:8, 114-120, 363-393`**:
    - `ContextDehydrator` is imported on line 8 but never instantiated or used in `index.ts`.
    - Stage 0 execution in `runTaskDecisionPipeline` bypasses `degradationMatrix.resolvePrunedToolsForStage`.

---

## 2. Logic Chain

1. **Dehydrator Inverted Eviction**:
   - *Premise*: LRU disk eviction must discard the oldest untouched artifacts to keep recent runs available.
   - *Chain*: Line 72 sorts newest-first (`b.mtimeMs - a.mtimeMs`). The quota loop at line 77 starts at `i = 0` (the newest item). If `totalSize > maxDiskBytes`, it immediately unlinks `runFolders[0]`. Thus, the newest run is deleted first.
   - *Conclusion*: Sorting must be oldest-first (`a.mtimeMs - b.mtimeMs`) for disk quota eviction.

2. **UI Monospace Column Jitter**:
   - *Premise*: Fixed-width two-column TUI tables require left column text to be padded to `halfW` visible columns so that ` │ ` aligns vertically.
   - *Chain*: `truncateToWidth` does not pad strings shorter than `w`. `" 通用基础工具"` has width 13; if `halfW` is 45, it remains width 13. The separator is printed at column 14 instead of column 46.
   - *Conclusion*: `padCol` must call `padToVisibleWidth(s, halfW)`.

3. **Box Border Asymmetry**:
   - *Premise*: Top border, body lines, and bottom border must share identical visible width.
   - *Chain*: Top border visible width is `2 ("╭─") + 10 (" ToolFlow ") + (innerWidth - 10) + 1 ("╮") = innerWidth + 3`. Body and bottom borders are `innerWidth + 4`.
   - *Conclusion*: `topInnerFill` must be `Math.max(0, innerWidth + 1 - titleVisW)`.

4. **Windows Atomic Persistence Resilience**:
   - *Premise*: Atomic write-rename on Windows can throw `EPERM` due to antivirus or open file handles.
   - *Chain*: In `memory.ts`, if `renameSync` throws, the exception is caught and discarded, leaving the `.tmp` file dangling and memory unsaved.
   - *Conclusion*: Clean up `.tmp` in catch and fallback to direct write.

5. **Subsystem Lifecycle Completeness**:
   - *Premise*: All imported architectural components (`ContextDehydrator`, `GracefulDegradationMatrix`) must have active runtime execution paths.
   - *Chain*: `ContextDehydrator` is never called in `index.ts`, and Stage 0 bypasses `degradationMatrix`.
   - *Conclusion*: Connect `ContextDehydrator` in `turn_end` and route Stage 0 through `degradationMatrix.resolvePrunedToolsForStage`.

---

## 3. Caveats

- **Network Mode**: Investigation operated strictly in local read-only mode without executing external network commands.
- **Node.js Version**: Tested on Node.js / TypeScript environment with `@earendil-works/pi-tui` and `@earendil-works/pi-coding-agent` installed in local `node_modules`.
- **Backward Compatibility**: All proposed remediations preserve existing JSON schemas, CLI arguments, and exported function signatures.

---

## 4. Conclusion

The ToolFlow codebase is functionally sophisticated and architecturally rich, but contains 5 specific categories of robustness defects:
1. Dehydrator quota eviction inversion and character/byte length mismatch.
2. Memory manager Windows atomic write failure mode and lack of token budgeting.
3. TUI overview column alignment collapse, 1-column top border notch, and Unicode surrogate slicing.
4. Lifecycle disconnection of `ContextDehydrator` in `index.ts` and Stage 0 tool pruning bypass.
5. Missing physical assertions in `test_suite.ts` to lock in these edge-case fixes.

All defect locations, root causes, and ready-to-apply remediation code snippets have been compiled in `analysis.md`.

---

## 5. Verification Method

To independently verify all findings and validate fixes:

1. **TypeScript Typecheck**:
   ```bash
   npx tsc --noEmit
   ```
   *Expected Output*: Exit code 0 with 0 errors.

2. **Full Regression Test Suite**:
   ```bash
   npm test
   # or npx tsx test_suite.ts
   ```
   *Expected Output*: All 14+ test modules pass 100% green.

3. **Isolated E2E Sandbox Run**:
   ```bash
   npx tsx sandbox_e2e.ts
   ```
   *Expected Output*: 5 stages complete cleanly with 0 leaked temp directories.

4. **Multi-language Monorepo Stress Test**:
   ```bash
   npx tsx monorepo_multilang_stress.ts
   ```
   *Expected Output*: 4 scenarios (TS, Python, Rust, Mixed) pass 100% green.

5. **Physical Inspection Points**:
   - Inspect `dehydrator.ts:72-85` for LRU sorting order.
   - Inspect `ui.ts:278-285` for `padToVisibleWidth` in `padCol`.
   - Inspect `ui.ts:452` for `topInnerFill` border symmetry.
   - Inspect `index.ts:363-393` for `ContextDehydrator` invocation.
