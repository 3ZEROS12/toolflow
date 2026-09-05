# Taxonomy, UI, and Cross-Platform Subsystem Handoff Report

**Role**: Taxonomy & UI Auditor (`teamwork_preview_explorer`)  
**Working Directory**: `C:\Users\Jason\.pi\agent\extensions\toolflow\.agents\explorer_taxonomy_1\`  
**Target Subsystems**: `taxonomy.ts`, `ui.ts`, `types.ts`, `blast_radius.ts`, `engine.ts`, `state.ts`  
**Handoff Type**: Hard (Investigation & Risk Probe Complete)  
**Report Document**: `C:\Users\Jason\.pi\agent\extensions\toolflow\.agents\explorer_taxonomy_1\analysis.md`  

---

## 1. Observation

Direct static code inspection and execution of the ToolFlow codebase revealed 21 concrete flaws across taxonomy, UI/TUI, and cross-platform subsystems:

1. **`ui.ts:28-32` (`renderValueReceipt`)**: Uses `metrics.task.slice(0, 44).padEnd(46)` and string interpolation with CJK strings (`任务目标`, `阶段总数`, `Token 效率`). In standard terminals, `padEnd` counts UTF-16 code units instead of monospace columns. For a 15-character CJK string, this produces a row width of 77 columns against the 64-column header, pushing the right border `|` out by 13 columns.
2. **`ui.ts:442-474` (`openArchitectNavigator`)**: Top border width evaluates to `innerWidth + 3` while the bottom border and body rows evaluate to `innerWidth + 4`. The top-right corner character `╮` is permanently misaligned by 1 space.
3. **`ui.ts:317, 384, 541-555` (`handleInput`)**: The UI displays `[1/2] 切换架构模式`, but pressing `'1'` or `'2'` only sets `selectedOptionIndex` for choices. No keybinding exists to switch `selectedPlan` to `"B"`.
4. **`taxonomy.ts:7-10`**: `TAXONOMY_PATH` hardcodes `os.homedir(), ".pi", "agent", "extensions", "toolflow", "ecosystem_taxonomy.json"`, breaking environments with custom `PI_AGENT_DIR` or alternative extension directory names.
5. **`taxonomy.ts:384-397`**: `loadOrRefreshTaxonomy` computes its cache hash solely from `settings.json`'s package list, causing newly added prompts in `~/.pi/agent/prompts/` or skills on disk to be ignored due to false cache hits.
6. **`taxonomy.ts:441-447`**: `deepAnalyzeTaxonomyWithLLM` filters for items containing `"动态通用"`, but `inferCapabilityFromMetadata` produces `"动态识别组件 [...]"` and defaults `layer` to `"L1_UTILITY"`. The unclassified array is always empty `[]`, disabling LLM taxonomy analysis entirely.
7. **`taxonomy.ts:145, 158-168`**: `sniffProjectFingerprint` sets `isClean = true` permanently and grabs 3 arbitrary files from `src/lib/app/pkg` into `activeModifiedPaths` even when the git repository is completely clean.
8. **`blast_radius.ts:31, 61, 78`**: `allowedPaths.has(resolved)` performs case-sensitive string matching on Windows NTFS, causing legitimate file writes with varying drive letter casing (e.g. `c:\` vs `C:\`) to be blocked.
9. **`blast_radius.ts:66-74`**: The critical config pattern `/^\.git/` only checks if the relative path begins with `.git`. Traversal paths such as `src/../../.git/config` bypass this check.
10. **`engine.ts:113`**: `previewCmds` generates `start index.html`, which is a Windows `cmd.exe` command that fails with `command not found` on Linux and macOS.

---

## 2. Logic Chain

1. **Taxonomy Soundness**:
   - `TAXONOMY_PATH` hardcoding (`taxonomy.ts:7`) → Fails when ToolFlow is packaged under a different folder or run in CI/container sandboxes.
   - Cache hash only incorporates `settings.packages` (`taxonomy.ts:384`) → Ignores file creations in `PROMPTS_PATH` and `NPM_MODULES_PATH`, returning stale taxonomy data.
   - Condition mismatch in `deepAnalyzeTaxonomyWithLLM` (`taxonomy.ts:441`) → Never matches generated summary strings → Dead LLM classification code path.
   - Regex priority inversion (`taxonomy.ts:261`) → Keyword `read` matches L2 Perception first → Misclassifies review/guard and git safety tools.

2. **UI & TUI Robustness**:
   - Native `String.prototype.padEnd()` on CJK characters (`ui.ts:28`) → Underestimates visual width by 1 column per CJK character → Severely distorts table borders and ASCII box drawing.
   - Arithmetic error in `topBorder` vs `botBorder` (`ui.ts:445`) → 1-column offset between header and footer box corners.
   - Conflicting keybinding handler in `deciding` state (`ui.ts:541`) → Number keys are intercepted by option selection → User cannot switch to Plan B interactively.
   - Hardcoded 86-column footer line (`ui.ts:384`) → Silently truncated by `truncateToWidth(76)` on standard 80-column terminals.

3. **Cross-Platform Defense**:
   - Case-sensitive `Set.has()` on Windows NTFS (`blast_radius.ts:78`) → Drive letter / directory case mismatch results in false-positive write blocks.
   - Anchored regex `/^\.git/` (`blast_radius.ts:13`) → Does not match `..\..\.git\config` → Path traversal allows writing to repository git metadata.
   - Platform-dependent command `start` (`engine.ts:113`) → Incompatible with POSIX shells (`open` / `xdg-open`).

---

## 3. Caveats

1. **Pi Agent Host APIs**: Certain UI behaviors depend on `@earendil-works/pi-tui` and the host extension container. The audit tested stand-alone rendering and static mechanics; host terminal emulator edge cases (e.g. Kitty graphics protocol, legacy Windows conhost vs Windows Terminal) may exhibit subtle variations in ambiguous character widths.
2. **LLM Execution Mocking**: `deepAnalyzeTaxonomyWithLLM` requires a live LLM endpoint via `pi.executePrompt`. Static analysis demonstrated the short-circuit bug without requiring real LLM tokens.
3. **No Source Code Modified**: In compliance with the read-only Explorer role, zero source files were modified. All refactoring proposals are supplied as exact code diffs in `analysis.md`.

---

## 4. Conclusion

The ToolFlow taxonomy, UI, and cross-platform subsystems possess solid high-level architecture (Kahn DAG, Kahn wave decomposition, 3-attempt healing), but suffer from severe terminal column calculation flaws (CJK box deformation), dead LLM taxonomy logic, critical path traversal loopholes in blast radius checks, and Windows path case mismatches. 

Remediating these 21 findings following the phased plan in `analysis.md` will elevate ToolFlow to true enterprise-grade cross-platform robustness with 0-hardcode compliance.

---

## 5. Verification Method

To independently verify these findings:

1. **CJK Width Deformation**:
   ```bash
   npx tsx -e '
     import { renderValueReceipt } from "./ui.js";
     const rows = renderValueReceipt({
       task: "开发宠物洗护中心高端宣传展示单页",
       blueprintId: "bp_test_123",
       stageCount: 5,
       verifiedFiles: ["src/main.ts"]
     });
     console.log(rows.join("\n"));
   '
   ```
   *Expected observation*: The table's right border `|` is staggered and misaligned by 6 to 13 columns.

2. **Windows Case-Sensitivity in Blast Radius**:
   ```bash
   npx tsx -e '
     import { BlastRadiusGuard } from "./blast_radius.js";
     const guard = new BlastRadiusGuard();
     guard.updateAllowedScope({ stageId: "s1", expectedArtifact: "src/main.ts" } as any, "C:/project");
     const check = guard.verifyToolCall({ toolName: "write", input: { path: "c:/project/src/main.ts" } }, "C:/project");
     console.log("Blocked:", check.block, "Reason:", check.reason);
   '
   ```
   *Expected observation*: On Windows, `check.block` is `true` (false rejection due to `c:` vs `C:`).

3. **Traversal Bypass in Blast Radius**:
   ```bash
   npx tsx -e '
     import { BlastRadiusGuard } from "./blast_radius.js";
     const guard = new BlastRadiusGuard();
     const check = guard.verifyToolCall({ toolName: "write", input: { path: "src/../../.git/config" } }, process.cwd());
     console.log("Blocked:", check.block);
   '
   ```
   *Expected observation*: `check.block` is `false` (traversal bypasses `.git` pattern).

4. **Regression Test Suite**:
   ```bash
   npm test
   ```
   *Expected observation*: Existing test suite runs and completes 12 test modules.
