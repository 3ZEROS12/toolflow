import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import {
  saveSessionStateToFile,
  loadPersistedSessionState,
  clearMemoryState,
  verifyStageArtifacts,
  startBlueprintExecution,
  advanceStage,
  atomicWriteFileSync
} from "./state.js";
import { ContextDehydrator } from "./dehydrator.js";
import { padToVisibleWidth, renderValueReceipt, renderUnicodeDAG } from "./ui.js";
import type { Blueprint, BlueprintStage } from "./types.js";

let passedAsserts = 0;
let failedAsserts = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passedAsserts++;
    console.log(`  [PASS] ${msg}`);
  } else {
    failedAsserts++;
    console.error(`  [FAIL] ${msg}`);
  }
}

async function runAdversarialChallenges() {
  console.log("================================================================================");
  console.log("TOOLFLOW ADVERSARIAL CHALLENGE HARNESS (Empirical Verification & Stress Suite)");
  console.log("================================================================================\n");
  const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "toolflow_challenger_test_"));
  try {
    console.log(">>> [CHALLENGE 1] State Persistence across turns & Verification Failures...");
    const ch1Dir = path.join(tempBase, "ch1_state");
    fs.mkdirSync(ch1Dir, { recursive: true });
    const dummyBlueprint: Blueprint = {
      blueprintId: "bp_test_persist_01",
      task: "Test State Persistence Across Turns",
      projectFingerprint: {
        projectType: "node",
        packageManager: "npm",
        hasGit: false,
        isClean: true,
        topLevelDirs: [],
        coreDependencies: []
      },
      stages: [
        {
          stageId: "stage_1",
          title: "Stage 1 Missing File",
          roleProfile: "Developer",
          coreObjective: "Implement missing component",
          expectedArtifact: "src/missing_component.ts",
          artifactContract: "Export missing component",
          allowedTools: ["write_to_file"],
          tokenCostNotice: "$0",
          boundCapabilities: { extensions: [], skills: [], prompts: [] },
          verificationCommands: []
        },
        {
          stageId: "stage_2",
          title: "Stage 2 Second Step",
          roleProfile: "QA",
          coreObjective: "Verify output JSON",
          expectedArtifact: "tests/output.json",
          artifactContract: "Valid test output",
          allowedTools: ["run_command"],
          tokenCostNotice: "$0",
          boundCapabilities: { extensions: [], skills: [], prompts: [] },
          verificationCommands: []
        }
      ],
      createdAt: Date.now(),
      userChoices: {},
      activatedCapabilities: { extensions: [], skills: [], prompts: [] },
      tokenEfficiencySummary: "Test efficiency summary"
    };
    startBlueprintExecution(dummyBlueprint, ch1Dir);
    assert(fs.existsSync(path.join(ch1Dir, ".pi", "blueprint_state.json")), "1.1 Initial blueprint_state.json persisted to disk");
    const vResult1 = verifyStageArtifacts(dummyBlueprint.stages[0], ch1Dir, false);
    assert(vResult1.valid === false, "1.2 vResult1.valid === false");
    assert(vResult1.retryCount === 1, "1.3 vResult1.retryCount === 1");
    const diskContent1 = JSON.parse(fs.readFileSync(path.join(ch1Dir, ".pi", "blueprint_state.json"), "utf-8"));
    assert(diskContent1.retryCount === 1, "1.4 Disk state immediately persisted retryCount: 1");
    assert(diskContent1.status === "in_progress", "1.5 Disk status is in_progress");
    clearMemoryState();
    const restored1 = loadPersistedSessionState(ch1Dir);
    assert(restored1 !== null, "1.6 Persisted state successfully loaded from disk");
    assert(restored1?.retryCount === 1, "1.7 Restored session state retains retryCount === 1 (NOT reset to 0)");
    assert(restored1?.currentStageIndex === 0, "1.8 Restored session state retains currentStageIndex === 0");
    const vResult2 = verifyStageArtifacts(dummyBlueprint.stages[0], ch1Dir, false);
    assert(vResult2.valid === false, "1.9 vResult2.valid === false");
    assert(vResult2.retryCount === 2, "1.10 vResult2.retryCount === 2");
    const diskContent2 = JSON.parse(fs.readFileSync(path.join(ch1Dir, ".pi", "blueprint_state.json"), "utf-8"));
    assert(diskContent2.retryCount === 2, "1.11 Disk state immediately persisted retryCount: 2");
    clearMemoryState();
    const restored2 = loadPersistedSessionState(ch1Dir);
    assert(restored2?.retryCount === 2, "1.12 Restored session retains retryCount === 2");
    const vResult3 = verifyStageArtifacts(dummyBlueprint.stages[0], ch1Dir, false);
    assert(vResult3.valid === false, "1.13 vResult3.valid === false on 3rd failure");
    assert(vResult3.retryCount === 3, "1.14 vResult3.retryCount === 3");
    assert(vResult3.isCircuitBroken === true, "1.15 vResult3.isCircuitBroken === true");
    const diskContent3 = JSON.parse(fs.readFileSync(path.join(ch1Dir, ".pi", "blueprint_state.json"), "utf-8"));
    assert(diskContent3.retryCount === 3, "1.16 Disk state persisted retryCount: 3");
    assert(diskContent3.status === "healing_failed_circuit_break", "1.17 Disk state persisted status: healing_failed_circuit_break");
    clearMemoryState();
    const restored3 = loadPersistedSessionState(ch1Dir);
    assert(restored3?.retryCount === 3, "1.18 Restored session retains retryCount === 3 across turn boundary");
    assert(restored3?.status === "healing_failed_circuit_break", "1.19 Restored session retains status === healing_failed_circuit_break");
    const roResult = verifyStageArtifacts(dummyBlueprint.stages[0], ch1Dir, true);
    assert(roResult.retryCount === 3, "1.20 Read-only query returns current retryCount 3");
    const diskContentRO = JSON.parse(fs.readFileSync(path.join(ch1Dir, ".pi", "blueprint_state.json"), "utf-8"));
    assert(diskContentRO.retryCount === 3, "1.21 Read-only query did NOT increment retryCount on disk");
    const jsonPath = path.join(ch1Dir, ".pi", "blueprint_state.json");
    const bakPath = path.join(ch1Dir, ".pi", "blueprint_state.json.bak");
    assert(fs.existsSync(bakPath), "1.22 .bak file was created by atomicWriteFileSync");
    fs.writeFileSync(jsonPath, "{ corrupted invalid json ...", "utf-8");
    clearMemoryState();
    const restoredBak = loadPersistedSessionState(ch1Dir);
    assert(restoredBak !== null && restoredBak.retryCount === 3, "1.23 Fallback to .bak file successfully recovered corrupted primary state");
    console.log("[OK] Challenge 1: State Persistence & Resilience Verified 100%\n");
    console.log(">>> [CHALLENGE 2] Dehydrator LRU Quota Eviction & Byte Limits...");
    const ch2Dir = path.join(tempBase, "ch2_dehydrator");
    const runsBase = path.join(ch2Dir, ".pi", "toolflow", "runs");
    fs.mkdirSync(runsBase, { recursive: true });
    function createMockRun(runName: string, ageMs: number, sizeMB: number) {
      const runDir = path.join(runsBase, runName);
      fs.mkdirSync(runDir, { recursive: true });
      const dummyFile = path.join(runDir, "data.log");
      const buf = Buffer.alloc(sizeMB * 1024 * 1024, 0x41);
      fs.writeFileSync(dummyFile, buf);
      const targetTime = new Date(Date.now() - ageMs);
      fs.utimesSync(runDir, targetTime, targetTime);
      fs.utimesSync(dummyFile, targetTime, targetTime);
      return runDir;
    }
    createMockRun("run_1_oldest", 500000, 60);
    createMockRun("run_2_older", 400000, 60);
    createMockRun("run_3_medium", 300000, 60);
    createMockRun("run_4_newer", 200000, 60);
    const activeRunDir = createMockRun("run_active_current", 1000, 50);
    const dehydrator = new ContextDehydrator(ch2Dir, "run_active_current");
    const evicted = dehydrator.pruneOldRuns(10, 7 * 24 * 3600 * 1000, 200 * 1024 * 1024);
    assert(evicted.length === 1, `2.1 Evicted exactly 1 run (got ${evicted.length}: ${evicted.join(", ")})`);
    assert(evicted[0] === "run_1_oldest", `2.2 Oldest run run_1_oldest was evicted first (got ${evicted[0]})`);
    assert(!fs.existsSync(path.join(runsBase, "run_1_oldest")), "2.3 run_1_oldest folder was deleted from disk");
    assert(fs.existsSync(path.join(runsBase, "run_2_older")), "2.4 run_2_older is preserved");
    assert(fs.existsSync(path.join(runsBase, "run_3_medium")), "2.5 run_3_medium is preserved");
    assert(fs.existsSync(path.join(runsBase, "run_4_newer")), "2.6 run_4_newer is preserved");
    assert(fs.existsSync(activeRunDir), "2.7 Active run directory is NEVER evicted");
    const evictedCount = dehydrator.pruneOldRuns(2, 7 * 24 * 3600 * 1000, 500 * 1024 * 1024);
    assert(evictedCount.includes("run_2_older"), "2.8 MaxRuns limit evicted oldest remaining run run_2_older");
    assert(fs.existsSync(path.join(runsBase, "run_3_medium")), "2.9 run_3_medium preserved");
    assert(fs.existsSync(path.join(runsBase, "run_4_newer")), "2.10 run_4_newer preserved");
    const hugeLog = "ToolFlow Log " + "x".repeat(11 * 1024 * 1024);
    const handoff = dehydrator.dehydrateStageLog("stage_huge", "Huge Log Stage", hugeLog, [], "Summary of huge log");
    assert(fs.existsSync(handoff.rawLogFilePath), "2.11 Huge log written to disk");
    const writtenLog = fs.readFileSync(handoff.rawLogFilePath, "utf-8");
    assert(writtenLog.includes("TOOLFLOW LOG TRUNCATED"), "2.12 Exceeded 10MB log was safely truncated with notice");
    assert(Buffer.byteLength(writtenLog, "utf-8") < 3 * 1024 * 1024, "2.13 Truncated log file size is well under 3MB");
    const binFile = path.join(ch2Dir, "image.png");
    fs.writeFileSync(binFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const binHandoff = dehydrator.dehydrateStageLog(
      "stage_bin",
      "Binary Asset Stage",
      "Short log",
      [{ path: binFile, sizeBytes: 8, sha256: "test", verifiedAt: Date.now() }],
      "Image summary"
    );
    assert(binHandoff.topologyHints === undefined, "2.14 Binary files (.png) skipped for AST regex parsing without error");
    console.log("[OK] Challenge 2: Dehydrator LRU Quota & Byte Limits Verified 100%\n");
    console.log(">>> [CHALLENGE 3] TUI Monospace Alignment & 4-Corner Box Border Symmetry...");
    const testCases = [
      { str: "Hello World", targetW: 20, desc: "Pure ASCII padding" },
      { str: "方案设计与意图契约", targetW: 24, desc: "Pure CJK (9 chars = 18 width -> pad to 24)" },
      { str: "[OK] 架构设计 (Design)", targetW: 35, desc: "Mixed CJK + ASCII + Symbols" },
      { str: "\x1b[32m[OK]\x1b[39m \x1b[1mStage 1\x1b[22m", targetW: 25, desc: "ANSI color codes embedded" },
      { str: "极长文本需要截断处理：这是一个非常非常长的中文字符串测试", targetW: 20, desc: "CJK truncation (longer than targetWidth)" }
    ];
    testCases.forEach((tc, idx) => {
      const padded = padToVisibleWidth(tc.str, tc.targetW);
      const visW = visibleWidth(padded);
      assert(visW === tc.targetW, `3.1.${idx + 1} padToVisibleWidth (${tc.desc}) visW === ${tc.targetW} (got ${visW})`);
    });
    const halfW = 40;
    const tableRows = [
      { left: " 通用基础工具: fs, path", right: " 在线查阅: web_search, doc" },
      { left: " 技能库: 智能诊断与方案推导", right: " 扩展插件: @pi-btw, @pi-guard" },
      { left: " 流程编排 (Kahn DAG Waves)", right: " 质量门禁 (3次就地自愈)" },
      { left: " Fast Agile Mode (Plan A)", right: " Enterprise 5-Stage (Plan B)" }
    ];
    const rendered2ColLines = tableRows.map(r => {
      const col1 = padToVisibleWidth(r.left, halfW);
      const col2 = padToVisibleWidth(r.right, halfW);
      return `${col1} │ ${col2}`;
    });
    rendered2ColLines.forEach((line, idx) => {
      const sepIndex = line.indexOf("│");
      const leftPart = line.slice(0, sepIndex - 1);
      const leftVisW = visibleWidth(leftPart);
      const rightPart = line.slice(sepIndex + 2);
      const rightVisW = visibleWidth(rightPart);
      const totalVisW = visibleWidth(line);
      assert(leftVisW === halfW, `3.2.${idx + 1}a Row ${idx + 1} Left column visW === ${halfW} (got ${leftVisW})`);
      assert(rightVisW === halfW, `3.2.${idx + 1}b Row ${idx + 1} Right column visW === ${halfW} (got ${rightVisW})`);
      assert(totalVisW === halfW + 3 + halfW, `3.2.${idx + 1}c Row ${idx + 1} Total line visW === ${halfW + 3 + halfW} (got ${totalVisW})`);
    });
    const testBoxWidths = [60, 80, 100, 120];
    testBoxWidths.forEach((termWidth, wIdx) => {
      const BOX_BORDER_LEFT = "│ ";
      const BOX_BORDER_RIGHT = " │";
      const BOX_BORDER_OVERHEAD = 4;
      const innerWidth = Math.max(10, termWidth - BOX_BORDER_OVERHEAD);
      const title = " ToolFlow ";
      const titleVisW = visibleWidth(title);
      const topInnerFill = Math.max(0, innerWidth + 1 - titleVisW);
      const topBorder = truncateToWidth("╭─" + title + "─".repeat(topInnerFill) + "╮", termWidth, "", true);
      const botBorder = truncateToWidth(`╰${"─".repeat(Math.max(0, innerWidth + 2))}╯`, termWidth, "", true);
      const sampleBodyContent = "  • 技能库: 智能诊断与方案推导与物理自愈机制 (CJK Test)";
      const padded = truncateToWidth(sampleBodyContent, innerWidth, "", true);
      const remaining = Math.max(0, innerWidth - visibleWidth(padded));
      const content = padded + " ".repeat(remaining);
      const bodyLine = truncateToWidth(BOX_BORDER_LEFT + content + BOX_BORDER_RIGHT, termWidth, "", true);
      const topVisW = visibleWidth(topBorder);
      const botVisW = visibleWidth(botBorder);
      const bodyVisW = visibleWidth(bodyLine);
      assert(topVisW === botVisW, `3.3.${wIdx + 1}a [Width ${termWidth}] Top border visW (${topVisW}) === Bot border visW (${botVisW})`);
      assert(topVisW === bodyVisW, `3.3.${wIdx + 1}b [Width ${termWidth}] Top border visW (${topVisW}) === Body line visW (${bodyVisW})`);
      assert(topVisW === termWidth || topVisW === innerWidth + 4, `3.3.${wIdx + 1}c [Width ${termWidth}] Border width matches box width (${topVisW})`);
    });
    const receipt = renderValueReceipt({
      task: "开发微信客服服务 (Mixed English / CJK 测试用例)",
      blueprintId: "bp_receipt_test_01",
      stageCount: 5,
      verifiedFiles: ["src/wechat.ts", "docs/design.md", "tests/wechat.test.ts"],
      totalDurationSec: 42,
      tokenSavingsRatio: ">96.5%"
    });
    const receiptWidths = receipt.map(r => visibleWidth(r));
    const firstReceiptW = receiptWidths[0];
    const allSameW = receiptWidths.every(w => w === firstReceiptW);
    assert(allSameW, `3.4.1 Value Delivery Receipt all rows have identical visible width (${firstReceiptW})`);
    assert(receipt[0].startsWith("+") && receipt[0].endsWith("+"), "3.4.2 Receipt top row starts and ends with +");
    assert(receipt[receipt.length - 1].startsWith("+") && receipt[receipt.length - 1].endsWith("+"), "3.4.3 Receipt bottom row starts and ends with +");
    console.log("[OK] Challenge 3: TUI Monospace & Box Symmetry Verified 100%\n");
  } finally {
    try {
      fs.rmSync(tempBase, { recursive: true, force: true });
    } catch (_) {}
  }
  console.log("================================================================================");
  console.log(`CHALLENGE RESULTS: ${passedAsserts} PASSED, ${failedAsserts} FAILED`);
  console.log("================================================================================");
  if (failedAsserts > 0) {
    process.exit(1);
  }
}
runAdversarialChallenges().catch(err => {
  console.error("Unhandled error in adversarial challenge:", err);
  process.exit(1);
});
