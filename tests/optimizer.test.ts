import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BlastRadiusGuard } from "../src/optimizer/blast-radius.js";
import { ReadCacheManager, clearAllReadCaches, getReadCache } from "../src/optimizer/read-cache.js";
import { ContextDehydrator } from "../src/optimizer/dehydrator.js";
import { clearAllStatsManagers, getStatsManager, StatsManager } from "../src/optimizer/stats.js";
import {
  isHeavyTool,
  pruneHeavyProviderTools,
  slimHistoricalContextMessages,
} from "../src/optimizer/context-slimmer.js";
import type { BlueprintStage } from "../src/core/types.js";
function makeWorkspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `toolflow-opt-${prefix}-`));
}

test("blast-radius: contains writes, protects .env, and blocks destructive shell", () => {
  const workspace = makeWorkspace("guard");
  const guard = new BlastRadiusGuard();

  assert.equal(guard.verifyToolCall({ toolName: "write", input: { path: "src/app.ts" } }, workspace).block, false);
  assert.equal(guard.verifyToolCall({ toolName: "write", input: { path: ".env" } }, workspace).block, true);
  assert.equal(guard.verifyToolCall({ toolName: "write", input: { path: "package-lock.json" } }, workspace).block, true);

  const outside = path.join(os.tmpdir(), "escape", "outside.ts");
  assert.equal(guard.verifyToolCall({ toolName: "write", input: { path: outside } }, workspace).block, true);

  assert.equal(guard.verifyToolCall({ toolName: "bash", input: { command: "rm -rf /" } }, workspace).block, true);
  assert.equal(
    guard.verifyToolCall({ toolName: "bash", input: { command: "rm -rf .git" } }, workspace).block,
    true
  );
  assert.equal(
    guard.verifyToolCall({ toolName: "bash", input: { command: "git reset --hard" } }, workspace).block,
    true
  );
  assert.equal(
    guard.verifyToolCall({ toolName: "bash", input: { command: "npm run build" } }, workspace).block,
    false
  );

  fs.rmSync(workspace, { recursive: true, force: true });
});

test("blast-radius: stage scope blocks outside targets until explicitly granted", () => {
  const workspace = makeWorkspace("scope");
  const guard = new BlastRadiusGuard();
  const stage: BlueprintStage = {
    stageId: "s1",
    title: "Scope Stage",
    coreObjective: "Only touch src/app.ts",
    boundCapabilities: {},
    expectedArtifact: "src/app.ts",
    artifactContract: "app exists",
    allowedTools: ["read", "write"],
  };
  guard.configureStageScope(stage);

  const blocked = guard.verifyToolCall({ toolName: "write", input: { path: "src/other.ts" } }, workspace);
  assert.equal(blocked.block, true);
  assert.equal(blocked.escalationCandidate?.filePath, path.join("src", "other.ts").replace(/\\/g, "/"));

  guard.grantDynamicScope("src/other.ts");
  assert.equal(guard.verifyToolCall({ toolName: "write", input: { path: "src/other.ts" } }, workspace).block, false);

  guard.clearScope();
  assert.equal(guard.verifyToolCall({ toolName: "write", input: { path: "src/anything.ts" } }, workspace).block, false);

  fs.rmSync(workspace, { recursive: true, force: true });
});

test("read-cache: full reads cache, targeted windows and dirty state bypass", () => {
  const workspace = makeWorkspace("read");
  const filePath = path.join(workspace, "big.ts");
  fs.writeFileSync(filePath, Array.from({ length: 80 }, (_, i) => `export const value${i} = ${i};`).join("\n"), "utf-8");

  const cache = new ReadCacheManager(workspace);
  const first = cache.checkRead({ path: "big.ts" });
  assert.equal(first.isDuplicate, false);

  const second = cache.checkRead({ path: "big.ts" });
  assert.equal(second.isDuplicate, true);
  assert.match(second.notice ?? "", /Read Cache Hit/);
  assert.match(second.notice ?? "", /Symbol outline/);
  assert.ok((second.savedTokens ?? 0) > 0);

  assert.equal(cache.checkRead({ path: "big.ts", offset: 10, limit: 5 }).bypassReason, "targeted_window");

  cache.markFileDirty("big.ts");
  assert.equal(cache.checkRead({ path: "big.ts" }).isDuplicate, false);

  cache.markWorkspaceDirtyByCommand();
  assert.equal(cache.checkRead({ path: "big.ts" }).isDuplicate, false);

  const smallPath = path.join(workspace, "small.ts");
  fs.writeFileSync(smallPath, "export const x = 1;\n", "utf-8");
  cache.recordRead({ path: "small.ts" });
  assert.equal(cache.checkRead({ path: "small.ts" }).bypassReason, "small_file");

  fs.rmSync(workspace, { recursive: true, force: true });
});

test("read-cache: pooled instances are workspace scoped", () => {
  clearAllReadCaches();
  const first = makeWorkspace("pool-a");
  const second = makeWorkspace("pool-b");
  assert.notEqual(getReadCache(first), getReadCache(second));
  assert.equal(getReadCache(first), getReadCache(first));
  clearAllReadCaches();
  fs.rmSync(first, { recursive: true, force: true });
  fs.rmSync(second, { recursive: true, force: true });
});

test("dehydrator: archives verbose output, extracts error peaks, and reports savings", () => {
  const workspace = makeWorkspace("hydra");
  const dehydrator = new ContextDehydrator(workspace);

  const noise = Array.from({ length: 200 }, (_, i) => `line ${i} of build output`);
  noise.splice(120, 0, "error TS2322: Type 'string' is not assignable to type 'number'.");
  const raw = noise.join("\n");

  const result = dehydrator.dehydrateToolOutput("bash", raw, true, "stage_1");
  assert.equal(result.dehydrated, true);
  assert.ok(result.tokensSaved > 0);
  assert.match(result.text, /Semantic Error Peak/);
  assert.match(result.text, /error TS2322/);
  assert.match(result.text, /Head \(\d+ lines\)/);

  const logPath = path.join(workspace, result.logFilePath ?? "");
  assert.equal(fs.existsSync(logPath), true);
  assert.equal(fs.readFileSync(logPath, "utf-8").length, raw.length);

  const small = dehydrator.dehydrateToolOutput("bash", "ok\n");
  assert.equal(small.dehydrated, false);

  fs.rmSync(workspace, { recursive: true, force: true });
});

test("dehydrator: loop buster flags identical repeated failures", () => {
  const workspace = makeWorkspace("loop");
  const dehydrator = new ContextDehydrator(workspace);
  const failing = "SyntaxError: Unexpected token '}'";

  assert.equal(dehydrator.dehydrateToolOutput("bash", failing, true).loopBusterTriggered, false);
  const second = dehydrator.dehydrateToolOutput("bash", failing, true);
  assert.equal(second.loopBusterTriggered, true);
  assert.match(second.text, /Loop Buster/);

  fs.rmSync(workspace, { recursive: true, force: true });
});

test("stats: ledger accumulates savings and persists as JSONL", () => {
  const workspace = makeWorkspace("stats");
  const stats = new StatsManager(workspace);

  assert.equal(stats.getStats().totalTokensSaved, 0);
  stats.recordSavings({ tokensSaved: 100, readCacheHits: 1 });
  stats.recordSavings({ tokensSaved: 50, dehydratedLogs: 1 });

  const summary = stats.getStats();
  assert.equal(summary.totalTokensSaved, 150);
  assert.equal(summary.readCacheHitsCount, 1);
  assert.equal(summary.dehydratedLogsCount, 1);
  assert.ok(summary.lastUpdated > 0);

  const ledger = path.join(workspace, ".pi", "toolflow", "stats.jsonl");
  assert.equal(fs.readFileSync(ledger, "utf-8").trim().split("\n").length, 2);
  assert.match(stats.getFormattedSavings(), /150/);
  assert.ok(stats.getSavingsSummary().estimatedRatioPercent >= 0);

  fs.rmSync(workspace, { recursive: true, force: true });
});

test("context-slimmer: prunes heavy tools and compresses stale verbose payloads", () => {
  assert.equal(isHeavyTool("browser_probe_interaction"), true);
  assert.equal(isHeavyTool("mcp_playwright_screenshot"), true);
  assert.equal(isHeavyTool("read"), false);

  const tools = [{ name: "read" }, { name: "web_search" }, { name: "subagent" }, { name: "grep" }];
  const toolEvent = { tools };
  pruneHeavyProviderTools(toolEvent, makeWorkspace("prune"));
  assert.deepEqual(
    toolEvent.tools.map((tool) => tool.name),
    ["read", "grep"]
  );

  const workspace = makeWorkspace("slim");
  const anchorDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolflow-anchor-"));
  fs.writeFileSync(
    path.join(anchorDir, "state.json"),
    JSON.stringify({
      anchors: [
        { id: 7, title: "Pinned contract", status: "active", cwd: workspace, files: ["src/pinned.ts"] },
        { id: 8, title: "Closed note", status: "settled", cwd: workspace, files: ["src/ignored.ts"] },
      ],
    }),
    "utf-8"
  );
  const previousAnchorDir = process.env.ANCHOR_DIR;
  process.env.ANCHOR_DIR = anchorDir;

  const longText = (label: string) => `${label}\n${"y".repeat(4000)}`;
  const messages = [
    { role: "toolResult", toolName: "read", content: [{ type: "text", text: longText("src/pinned.ts content") }] },
    { role: "toolResult", toolName: "bash", content: [{ type: "text", text: longText("build log") }] },
    { role: "user", content: "next" },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "user", content: "more" },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: "again" },
    { role: "assistant", content: [{ type: "text", text: "sure" }] },
    { role: "user", content: "latest" },
    { role: "toolResult", toolName: "bash", content: [{ type: "text", text: longText("fresh output") }] },
  ];

  slimHistoricalContextMessages({ messages }, workspace);

  const textAt = (index: number): string => {
    const block = messages[index].content[0];
    return typeof block === "object" && "text" in block ? block.text : "";
  };

  assert.match(textAt(0), /src\/pinned\.ts content/, "anchor-protected text must stay intact");
  assert.equal(textAt(0).length > 600, true);
  assert.match(textAt(1), /Slimmed History/);
  assert.equal(textAt(9).length > 600, true, "recent messages stay verbatim");

  if (previousAnchorDir === undefined) delete process.env.ANCHOR_DIR;
  else process.env.ANCHOR_DIR = previousAnchorDir;

  fs.rmSync(anchorDir, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("regression: Windows drive-case containment, pooled StatsManager, and collision-free dehydrator logs", () => {
  const workspace = makeWorkspace("reg");
  const guard = new BlastRadiusGuard();
  if (process.platform === "win32") {
    const lowerTarget = path.join(workspace, "src", "file.ts").replace(/^[A-Z]:/, (d) => d.toLowerCase());
    assert.equal(guard.verifyToolCall({ toolName: "write", input: { path: lowerTarget } }, workspace).block, false);
  }

  clearAllStatsManagers();
  const s1 = getStatsManager(workspace);
  const s2 = getStatsManager(process.platform === "win32" ? workspace.toLowerCase() : workspace);
  assert.equal(s1, s2);

  const dehydrator = new ContextDehydrator(workspace);
  const big = Array.from({ length: 50 }, (_, i) => `row ${i}`).join("\n");
  const r1 = dehydrator.dehydrateToolOutput("bash", big, false, "s1");
  const r2 = dehydrator.dehydrateToolOutput("bash", big, false, "s1");
  assert.equal(r1.dehydrated, true);
  assert.equal(r2.dehydrated, true);
  assert.notEqual(r1.logFilePath, r2.logFilePath);

  clearAllStatsManagers();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("stats: compact badge stays short, drops zero counters, and reports guard blocks", () => {
  const workspace = makeWorkspace("badge");
  const stats = new StatsManager(workspace);

  // A brand-new ledger still renders a badge instead of an empty string.
  assert.equal(stats.getCompactBadge(), "~0 saved");

  stats.recordSavings({ tokensSaved: 1400, dehydratedLogs: 2 });
  assert.equal(stats.getCompactBadge(), "~1.4k saved · 2 logs");

  stats.recordSavings({ readCacheHits: 3, blastRadiusBlocks: 2 });
  assert.equal(stats.getCompactBadge(), "~1.4k saved · 2 logs · 3 hits · 2 guarded");
  assert.ok(!stats.getCompactBadge().includes("toolflow"), "badge must not repeat the status key");
  assert.equal(stats.getLedgerPath(), path.join(workspace, ".pi", "toolflow", "stats.jsonl"));

  // The long human-facing form is unchanged for callers that want the full sentence.
  assert.match(stats.getFormattedSavings(), /ToolFlow Saved: ~1\.4k tokens/);

  fs.rmSync(workspace, { recursive: true, force: true });
});

test("context-slimmer: reports per-pass reclaim and stays idempotent", () => {
  const workspace = makeWorkspace("slim-count");
  const longText = (label: string): string => `${label}\n${"z".repeat(4000)}`;
  const buildMessages = (): Array<Record<string, unknown>> => [
    { role: "toolResult", toolName: "bash", content: [{ type: "text", text: longText("build log") }] },
    ...Array.from({ length: 8 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: "ok" })),
  ];

  const messages = buildMessages();
  const first = slimHistoricalContextMessages({ messages }, workspace);
  assert.equal(typeof first, "number");
  assert.ok(first > 0, "folding a 4000-char block must report reclaimed tokens");

  // Second pass over the already-folded transcript must not double-count.
  assert.equal(slimHistoricalContextMessages({ messages }, workspace), 0);
  assert.equal(getStatsManager(workspace).getStats().totalTokensSaved, first);

  // Too-short transcripts are left alone.
  assert.equal(slimHistoricalContextMessages({ messages: buildMessages().slice(0, 3) }, workspace), 0);

  clearAllStatsManagers();
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("blast-radius: fails closed on targets it cannot parse, and on space-less redirection", () => {
  const workspace = makeWorkspace("guard-hard");
  const guard = new BlastRadiusGuard();

  // A write tool whose arguments carry no path used to slip past containment entirely.
  const unparsed = guard.verifyToolCall({ toolName: "delete", input: { paths: ["src/a.ts"] } }, workspace);
  assert.equal(unparsed.block, true);
  assert.match(unparsed.reason ?? "", /no recognizable target path/);

  // `>.env` is one whitespace token, so the mutating-token scan never matched it.
  const redirect = guard.verifyToolCall({ toolName: "bash", input: { command: "echo pwn >.env" } }, workspace);
  assert.equal(redirect.block, true);
  assert.equal(guard.verifyToolCall({ toolName: "bash", input: { command: "npm run build >build.log" } }, workspace).block, false);

  // Scope patterns come from the LLM; metacharacters must not throw out of the hook.
  const stage: BlueprintStage = {
    stageId: "s1",
    title: "Regex Stage",
    coreObjective: "touch one file",
    boundCapabilities: {},
    expectedArtifact: "src/app.ts",
    artifactContract: "app exists",
    allowedTools: ["read", "write"],
    targetPatterns: ["src/(draft)+/*.ts"],
  };
  guard.configureStageScope(stage);
  assert.doesNotThrow(() => guard.verifyToolCall({ toolName: "write", input: { path: "src/app.ts" } }, workspace));

  fs.rmSync(workspace, { recursive: true, force: true });
});

test("stats: resetLedger deletes the ledger so counters cannot come back on re-read", () => {
  const workspace = makeWorkspace("reset-ledger");
  const manager = new StatsManager(workspace);
  manager.recordSavings({ tokensSaved: 900, readCacheHits: 2 });
  assert.equal(manager.getStats().totalTokensSaved, 900);

  manager.resetLedger();
  assert.equal(manager.getStats().totalTokensSaved, 0);
  assert.equal(fs.existsSync(manager.getLedgerPath()), false);

  // A fresh manager for the same workspace sees nothing to resurrect.
  assert.equal(new StatsManager(workspace).getStats().totalTokensSaved, 0);

  fs.rmSync(workspace, { recursive: true, force: true });
});

test("dehydrator: archiving a stage log does not claim inflated token savings", () => {
  const workspace = makeWorkspace("stage-log");
  const dehydrator = new ContextDehydrator(workspace);
  const raw = Array.from({ length: 400 }, (_, i) => `line ${i} of stage output`).join("\n");

  dehydrator.dehydrateStageLog({
    stageId: "stage-1",
    stageTitle: "Build API",
    rawStageOutput: raw,
    verifiedArtifacts: [],
    contractSummary: "api exists",
  });

  const stats = getStatsManager(workspace).getStats();
  assert.equal(stats.totalTokensSaved, 0, "archival is not a reclaim");
  assert.equal(stats.dehydratedLogsCount, 0);

  fs.rmSync(workspace, { recursive: true, force: true });
  clearAllStatsManagers();
});
