# Code Review & Adversarial Audit Handoff Report

## 1. Observation

### 1.1 Physical Verification Results
All four required physical test commands were executed directly on the Windows environment from `C:\Users\Jason\.pi\agent\extensions\toolflow`:
1. `npx tsc --noEmit` -> **Exit Code 0** (0 compilation errors or type warnings).
2. `npm test` -> **Exit Code 0** (15 test modules, 120+ assertions passing).
3. `npx tsx sandbox_e2e.ts` -> **Exit Code 0** (All 5 isolation sandbox phases completed cleanly).
4. `npx tsx monorepo_multilang_stress.ts` -> **Exit Code 0** (All 4 multi-language scenarios passed).

### 1.2 Module-by-Module Code Observations

#### A. `blast_radius.ts` (VERIFIED CORRECT)
- **DOS Reserved Device Names**: Line 26-27 regex `/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CONIN\$|CONOUT\$)(\..*)?$/i` is checked on `cleanBaseName`, `rawSegments`, and `pathSegments` (lines 173-185). Probed in Node: `aux.json` and `src/nul.ts` are blocked; legitimate files like `auxiliary.ts` and `null.ts` are allowed.
- **Win32 Trailing Dots/Spaces**: Normalized in `normalizePath` (line 51: `seg.replace(/[.\s]+$/, "")`), `cleanBaseName` (line 171), and `rawSegments` (line 174). Blocks bypass attempts such as `package-lock.json.`, `.git.`, `.env. `.
- **Cross-Drive Traversal**: Lines 127-132 (`isPathWithinWorkspace`) and 188-194 (`normResolved === normCwd || normResolved.startsWith(normCwd + "/")`) reject paths with differing drive letters (e.g., `D:\malicious\payload.ts` from `C:\workspace`).
- **DOS 8.3 Short Aliases**: Lines 41-43 and 197 check `GIT~1`, `ENV~1`, `CARGO~1.LOC`, `TURBO~1.JSO`, `PNPM-W~1.YAM`.
- **Recursive Glob Converter**: Line 71 compiles `**/` into `(?:.+/)?`, allowing `**/*.ts` to match both root files (`index.ts`) and nested paths (`src/foo/bar.ts`).

#### B. `dehydrator.ts` (VERIFIED CORRECT)
- **Inverted LRU Eviction**: Line 73 sorts historical runs ascending by `mtimeMs` (`a.mtimeMs - b.mtimeMs`), evicting oldest runs first when total size > 200MB or count > maxRuns. Line 72 explicitly excludes `this.runsDir` (the active run).
- **UTF-8 Byte Measurement**: Line 113 enforces the 10MB log cap using `Buffer.byteLength(rawStr, "utf-8")` rather than string character length.
- **Binary File AST Protection**: Lines 126-130 define `BINARY_EXTS` (`.png`, `.jpg`, `.exe`, `.dll`, `.wasm`, `.zip`, etc.) and line 136 skips reading and regex parsing on binary files.

#### C. `memory.ts` (VERIFIED CORRECT)
- **Workspace Root Alignment**: Saved in constructor (line 28 `this.workspaceRoot = workspaceRoot`) and used for `codebaseId` (line 48 `path.basename(this.workspaceRoot)`).
- **Safe Atomic Write**: `safeWriteStore` (lines 55-93) uses a 5-retry loop on `fs.renameSync`, falls back to `fs.copyFileSync`, and cleans up `.tmp` in `finally`.
- **Token Budget Ceiling**: Lines 141-148 truncate individual rationales to 100 characters and enforce a hard limit of 1500 characters (< 500 tokens).

#### D. `state.ts` (VERIFIED CORRECT)
- **State Machine Retry Persistence**: Lines 500, 516, 543, 563, 594, 633, 652 call `saveSessionStateToFile(cwd)` upon all verification failure paths and circuit break transitions (`retryCount >= 3` -> `healing_failed_circuit_break`).
- **Undefined expectedArtifact Null Safety**: Line 470 falls back to `stage.expectedArtifacts[0]` or empty string without throwing on undefined.
- **Atomic Persistence & Backup Fallback**: `atomicWriteFileSync` (lines 35-80) features 5 retries on rename, `.bak` backup copy creation, and `loadPersistedSessionState` (lines 99-139) automatically recovers from `.bak` if primary JSON is corrupted.
- **Tool Scoping Preservation**: `computeStageTools` (lines 669-674) preserves pruned tools without forcing `BASELINE_TOOLS`.

#### E. `engine.ts` & `worker_orchestrator.ts` (VERIFIED CORRECT)
- **Kahn DAG Deduplication**: `planDAGWaves` (lines 144-151) deduplicates by `stageId` and returns structured `hasCycles` / `cycleNodes` diagnostics (lines 209-220).
- **Plan Selection**: `synthesizeBlueprint` (lines 945-947) respects explicit `selectedPlan === "B"` without override by delivery strategy.
- **Python Preview Command**: Line 59 normalizes `path.join(srcDir, "main.py")`, avoiding `/main.py` when `srcDir` is empty.
- **Artifact List Normalization**: `worker_orchestrator.ts` line 34 correctly handles empty arrays (`s.expectedArtifacts && s.expectedArtifacts.length > 0 ? s.expectedArtifacts : (s.expectedArtifact ? [s.expectedArtifact] : [])`).
- **Wave Batching**: `MultiAgentWorkerOrchestrator.compileWaveBundles` (lines 23-29) chunks parallel stages by `maxConcurrency`.

#### F. `taxonomy.ts` & `degradation_matrix.ts` (VERIFIED CORRECT)
- **`npm:` Prefix Stripping**: `taxonomy.ts` lines 19 & 337 strip `npm:` prefix before resolving paths on Windows.
- **Parent Dir Creation**: `taxonomy.ts` line 421 ensures parent directory exists before writing JSON.
- **Stage ID Fuzzy Normalization**: `degradation_matrix.ts` lines 139-147 map stage IDs like `stage_1_design` to `design`, `preview`, `test`, `code`.

#### G. `index.ts` & `types.ts` (VERIFIED CORRECT)
- **Lifecycle Integration**: `ContextDehydrator` instantiated (line 29) and called in `turn_end` (lines 365-373) for `dehydrateStageLog` and `pruneOldRuns`.
- **Stage 0 Tool Pruning**: Line 118 routes initial stage through `degradationMatrix.resolvePrunedToolsForStage`.
- **Types Soundness**: Zero type errors under `npx tsc --noEmit`.

#### H. `ui.ts` (DEFECTS FOUND)
- **Defect 1 (Major)**: In `openArchitectNavigator` (line 286):
  ```ts
  const padCol = (s: string, w: number) => truncateToWidth(s, w, "", true);
  ```
  `padCol` calls `truncateToWidth` rather than `padToVisibleWidth`. `truncateToWidth` does NOT pad strings shorter than `w` with spaces. When rendered in wide terminal mode (lines 288-293), short strings in the left column cause the column separator `│` to misalign across rows.
- **Defect 2 (Minor)**: In `openArchitectNavigator`:
  - Line 636: `customRequirementsText = customRequirementsText.slice(0, -1);`
  - Line 667: `newOptionTitle = newOptionTitle.slice(0, -1);`
  Unlike line 508 (`Array.from(inputTask).slice(0, -1).join("")`), lines 636 and 667 use plain `.slice(0, -1)`, which splits surrogate pairs (emojis / CJK supplementary characters) on backspace.

---

## 2. Logic Chain

1. **Integrity & Authenticity Check**:
   - Inspected source code for hardcoded test results, facade implementations, or bypasses. All algorithms (Kahn DAG, Blast Radius regexes, UTF-8 byte calculations, AST extractors, atomic persistence loops) execute genuine logic.
   - All 4 verification commands were run independently and yielded 100% pass rates on real files.

2. **Remediation Directives Verification**:
   - Compared implementation against all 14+ directives in `REMEDIATION_SPEC.md`. Modules M1 through M8, M10, and M11 strictly satisfy all specification criteria.
   - For Module M9 (`ui.ts`), Directive 1 required:
     `In padCol, use padToVisibleWidth(s, halfW) so the separator │ remains strictly aligned.`
   - Line 286 of `ui.ts` was left using `truncateToWidth(s, w, "", true)` instead of `padToVisibleWidth(s, w)`. While `padToVisibleWidth` was implemented at line 9 and used in `renderValueReceipt`, it was not invoked in `padCol`.
   - Directive 4 of M9 required surrogate-pair safe backspace: line 508 was updated, but lines 636 and 667 were missed.

3. **Risk & Impact Assessment**:
   - The defect in `ui.ts:286` causes visual table column misalignment in the interactive TUI when running in terminals >= 90 columns.
   - The defect in `ui.ts:636,667` can cause lone high surrogates if a user deletes an emoji in the custom requirements or custom option prompt.
   - Core backend execution, security, AST dehydration, memory compaction, and state recovery are unaffected and 100% robust.

---

## 3. Caveats
- No other defects or regression risks were found in any of the 11 core modules.
- Verification tests in `test_suite.ts` (specifically 15.16) asserted `padToVisibleWidth(sampleCol1, 45)`, which passed, but did not directly test the unexported local `padCol` lambda inside `openArchitectNavigator`.

---

## 4. Conclusion

**Verdict: REQUEST_CHANGES**

### Required Remediations

#### Finding 1 [Major] — `ui.ts:286` Column Padding in 2-Column TUI Overview
- **Location**: `ui.ts`, Line 286
- **Issue**: `padCol` is defined as `(s: string, w: number) => truncateToWidth(s, w, "", true);`. Shorter strings are not space-padded to `w`, breaking vertical separator `│` alignment.
- **Fix**: Change Line 286 to:
  ```ts
  const padCol = (s: string, w: number) => padToVisibleWidth(s, w);
  ```

#### Finding 2 [Minor] — `ui.ts:636, 667` Surrogate-Pair Safe Backspaces
- **Location**: `ui.ts`, Lines 636 & 667
- **Issue**: Plain `.slice(0, -1)` splits surrogate pairs for multi-byte Unicode/emojis.
- **Fix**: Replace Line 636 with:
  ```ts
  customRequirementsText = Array.from(customRequirementsText).slice(0, -1).join("");
  ```
  Replace Line 667 with:
  ```ts
  newOptionTitle = Array.from(newOptionTitle).slice(0, -1).join("");
  ```

---

## 5. Verification Method

To verify these fixes after remediation:
1. Run `npx tsc --noEmit` -> Expect Exit Code 0.
2. Run `npm test` -> Expect 15 test modules passing.
3. Run `npx tsx sandbox_e2e.ts` -> Expect Exit Code 0.
4. Run `npx tsx monorepo_multilang_stress.ts` -> Expect Exit Code 0.
5. In Node / test script, verify `padCol(" 通用基础工具", 45)` produces exactly visibleWidth 45 with trailing spaces.