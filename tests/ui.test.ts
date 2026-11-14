import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  padToVisibleWidth,
  renderBlueprintSummary,
  renderCJKSafeInputBox,
  renderCompactEcosystemOverview,
  renderSavingsLedger,
  renderExecutionPipelineCard,
  renderUnicodeDAG,
  renderValueReceipt,
} from "../src/ui/cards.js";
import type { Blueprint, BlueprintStage, EcosystemTaxonomy } from "../src/core/types.js";

const STAGES: BlueprintStage[] = [
  {
    stageId: "stage_1",
    title: "Design",
    coreObjective: "design",
    boundCapabilities: { extensions: ["pi-anchor"] },
    expectedArtifact: "src/app.ts",
    artifactContract: "exists",
    allowedTools: ["read", "write", "bash"],
  },
  {
    stageId: "stage_2",
    title: "Review",
    dependsOn: ["stage_1"],
    coreObjective: "review",
    boundCapabilities: {},
    expectedArtifact: "tests/app.test.ts",
    artifactContract: "passes",
    allowedTools: ["read", "grep"],
    isReviewStage: true,
  },
];

test("cards: padToVisibleWidth matches the requested column budget for CJK text", () => {
  const padded = padToVisibleWidth("中文标签 ASCII", 30);
  assert.equal(visibleWidth(padded), 30);

  const truncated = padToVisibleWidth("x".repeat(80), 20);
  assert.equal(visibleWidth(truncated), 20);
});

test("cards: CJK-safe input box keeps the viewport width stable while scrolling", () => {
  const short = renderCJKSafeInputBox("> ", "hello", 40, { fg: (_c, s) => s });
  assert.equal(visibleWidth(short), 40);

  const longCjk = renderCJKSafeInputBox("> ", "中文输入".repeat(20), 30, { fg: (_c, s) => s });
  assert.equal(visibleWidth(longCjk), 30);

  const noCursor = renderCJKSafeInputBox("> ", "abc", 24, { fg: (_c, s) => s }, false);
  assert.equal(visibleWidth(noCursor), 24);
});

test("cards: value receipt lists verified artifacts and efficiency", () => {
  const receipt = renderValueReceipt({
    task: "Ship parser",
    blueprintId: "bp_abc",
    stageCount: 3,
    verifiedFiles: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"],
    totalDurationSec: 42,
    tokenSavingsRatio: "72%",
  }).join("\n");

  assert.match(receipt, /VALUE DELIVERY RECEIPT/);
  assert.match(receipt, /src\/a\.ts/);
  assert.match(receipt, /and 1 more verified artifacts/);
  assert.match(receipt, /72% token overhead saved/);
  assert.match(receipt, /42s/);
});

test("cards: DAG renders dependency and capability rows", () => {
  const lines = renderUnicodeDAG(STAGES, { currentStageIndex: 1 }).join("\n");
  assert.match(lines, /\[Stage 1\] Design/);
  assert.match(lines, /\[Artifact\] {2}src\/app\.ts/);
  assert.match(lines, /\[Ecosystem\] @pi-anchor/);
  assert.match(lines, /\[Depends\] {3}stage_1/);
  assert.match(lines, /\[>\]/);
});

test("cards: pipeline card reports progress, artifacts, and worker status", () => {
  const card = renderExecutionPipelineCard({
    blueprintId: "bp_x",
    task: "Ship parser",
    currentStageIndex: 1,
    stages: STAGES,
    verifiedArtifactCount: 1,
    activeWorkers: [{ name: "worker-a", tool: "bash", status: "running" }],
  });
  assert.match(card, /Pipeline Progress/);
  assert.match(card, /Stage 1\*\*: Design `\(Verified\)`/);
  assert.match(card, /Stage 2\*\*: Review \[review\] `\(Running\)`/);
  assert.match(card, /worker-a/);
});

test("cards: ecosystem overview groups capabilities by layer", () => {
  const taxonomy: EcosystemTaxonomy = {
    version: "t",
    scannedAt: Date.now(),
    extensions: [
      {
        id: "ext_1",
        name: "pi-anchor",
        cleanName: "anchor",
        type: "extension",
        layer: "L3_ORCHESTRATION",
        description: "dock",
        compactDigest: "",
      },
      {
        id: "ext_2",
        name: "pi-web-access",
        cleanName: "web-access",
        type: "extension",
        layer: "L2_PERCEPTION",
        description: "search",
        compactDigest: "",
      },
    ],
    skills: [],
    prompts: [],
    tools: [],
  };

  const overview = renderCompactEcosystemOverview(taxonomy);
  assert.match(overview, /Search & Perception.*`pi-web-access`/);
  assert.match(overview, /Orchestration.*`pi-anchor`/);
  assert.match(overview, /Skills\*\*: none/);
});

test("cards: blueprint summary includes stage table and DAG block", () => {
  const blueprint: Blueprint = {
    blueprintId: "bp_1",
    task: "Ship parser",
    createdAt: Date.now(),
    userChoices: {},
    activatedCapabilities: { extensions: [], skills: [], prompts: [] },
    tokenEfficiencySummary: "",
    stages: STAGES,
  };
  const summary = renderBlueprintSummary(blueprint);
  assert.match(summary, /Execution Blueprint/);
  assert.match(summary, /\| \*\*1\. Design\*\*/);
  assert.match(summary, /```text/);
});

test("cards: savings ledger reports counters, ratio, and ledger path", () => {
  const card = renderSavingsLedger({
    stats: {
      totalTokensSaved: 1400,
      dehydratedLogsCount: 2,
      readCacheHitsCount: 3,
      blastRadiusBlocksCount: 1,
      lastUpdated: Date.UTC(2026, 10, 14, 12, 0, 0),
    },
    estimatedRatioPercent: 5,
    ledgerPath: ".pi/toolflow/stats.jsonl",
  });

  assert.match(card, /\[ToolFlow Ledger\]/);
  assert.match(card, /~1\.4k/);
  assert.match(card, /2 log\(s\)/);
  assert.match(card, /3 hit\(s\)/);
  assert.match(card, /1 block\(s\)/);
  assert.match(card, /~5%/);
  assert.match(card, /2026-11-14 12:00:00/);
  assert.match(card, /\.pi\/toolflow\/stats\.jsonl/);
  assert.ok(!card.includes("No savings recorded yet"));

  const idle = renderSavingsLedger({
    stats: {
      totalTokensSaved: 0,
      dehydratedLogsCount: 0,
      readCacheHitsCount: 0,
      blastRadiusBlocksCount: 0,
      lastUpdated: 0,
    },
  });
  assert.match(idle, /never/);
  assert.match(idle, /No savings recorded yet/);
});
