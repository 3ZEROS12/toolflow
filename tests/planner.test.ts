import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { BlueprintStage, EcosystemTaxonomy } from "../src/core/types.js";
import { planDAGWaves, GracefulDegradationMatrix } from "../src/planner/dag.js";
import {
  diagnoseTaskExecutionMode,
  generateABTradeOffMatrix,
  inferArtifactProfile,
} from "../src/planner/router.js";
import { discoverEcosystemTaxonomy, sniffProjectFingerprint } from "../src/planner/taxonomy.js";
import { synthesizeBlueprint } from "../src/planner/synthesizer.js";
import { verifyStageArtifacts } from "../src/planner/verifier.js";
import { clearAllWorkspaceStores } from "../src/core/workspace-store.js";
import { formatActiveAnchorHint, loadActiveAnchorFiles } from "../src/planner/anchor-handshake.js";

function makeWorkspace(prefix: string, files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `toolflow-plan-${prefix}-`));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf-8");
  }
  return dir;
}

function stage(stageId: string, dependsOn: string[] = []): BlueprintStage {
  return {
    stageId,
    title: stageId,
    dependsOn,
    coreObjective: `Run ${stageId}`,
    boundCapabilities: {},
    expectedArtifact: `out/${stageId}.ts`,
    artifactContract: "exists",
    allowedTools: ["read", "write"],
  };
}

const EMPTY_TAXONOMY: EcosystemTaxonomy = {
  version: "test",
  scannedAt: Date.now(),
  extensions: [],
  skills: [],
  prompts: [],
  tools: [],
};

test("dag: linear chains serialize, independent stages share a wave, cycles are detected", () => {
  const linear = planDAGWaves([stage("a"), stage("b", ["a"]), stage("c", ["b"])]);
  assert.equal(linear.hasCycles, false);
  assert.deepEqual(
    linear.waves.map((wave) => wave.stages.map((item) => item.stageId)),
    [["a"], ["b"], ["c"]]
  );

  const parallel = planDAGWaves([stage("a"), stage("b"), stage("c", ["a", "b"])]);
  assert.deepEqual(
    parallel.waves.map((wave) => wave.stages.length),
    [2, 1]
  );
  assert.equal(parallel.waves[0].isParallel, true);

  const cyclic = planDAGWaves([stage("a", ["b"]), stage("b", ["a"])]);
  assert.equal(cyclic.hasCycles, true);
  assert.ok((cyclic.cycleNodes ?? []).length > 0);
});

test("dag: degradation matrix falls back when browser or subagent tools are absent", () => {
  const matrix = new GracefulDegradationMatrix(["read", "write", "bash", "grep", "find", "ls"]);
  assert.equal(matrix.resolveCapability("browser").tier, "TIER_3_FALLBACK");
  assert.equal(matrix.resolveCapability("subagent").tier, "TIER_3_FALLBACK");
  assert.equal(matrix.resolveCapability("lsp").tier, "TIER_2_GENERIC");

  const rich = new GracefulDegradationMatrix(["browser_probe_interaction", "subagent", "web_search"]);
  assert.equal(rich.resolveCapability("browser").tier, "TIER_1_NATIVE");
  assert.equal(rich.resolveCapability("subagent").tier, "TIER_1_NATIVE");

  const adaptive = rich.computeAdaptiveTools(["browser_probe_interaction", "unknown_browser_tool"]);
  assert.ok(adaptive.mergedTools.includes("read"));
  assert.ok(adaptive.mergedTools.includes("browser_probe_interaction"));
});

test("router: routes micro tasks to fast mode and architectural work to blueprints", () => {
  assert.equal(diagnoseTaskExecutionMode("fix typo").mode, "fast");
  assert.equal(diagnoseTaskExecutionMode("task", undefined, "fast").mode, "fast");
  assert.equal(diagnoseTaskExecutionMode("refactor the auth pipeline").mode, "blueprint");
  assert.equal(diagnoseTaskExecutionMode("anything", undefined, "blueprint").mode, "blueprint");

  const matrix = generateABTradeOffMatrix("refactor the parser");
  assert.equal(matrix.recommendedPlan, "B");
  assert.equal(generateABTradeOffMatrix("add a label").recommendedPlan, "A");
});

test("router: artifact profiles follow the detected project type", () => {
  const rust = inferArtifactProfile({} as never);
  assert.equal(rust.srcPath, "src/index.ts");

  const rustProfile = inferArtifactProfile({
    projectType: "rust",
    packageManager: "cargo",
    sourceDir: "src",
    testDir: "tests",
    hasGit: false,
    isDirty: false,
    changedModules: [],
    keyConfigFiles: [],
  });
  assert.equal(rustProfile.srcPath, "src/main.rs");
  assert.deepEqual(rustProfile.testCommands, ["cargo check", "cargo test"]);
});

test("taxonomy: discovery never writes into the package source tree", () => {
  const workspace = makeWorkspace("taxonomy", {
    "package.json": JSON.stringify({ name: "demo", dependencies: { react: "^19.0.0" } }),
    ".pi/skills/alpha/SKILL.md": "# Alpha\n\n- Keep contracts typed\n",
  });

  const taxonomy = discoverEcosystemTaxonomy(workspace, [{ name: "read", description: "Read files" }]);
  assert.equal(taxonomy.projectFingerprint?.projectType, "web");
  assert.equal(taxonomy.projectFingerprint?.mainFramework, "React");
  assert.equal(taxonomy.skills.some((skill) => skill.cleanName === "alpha"), true);
  assert.equal(taxonomy.tools.length, 1);
  assert.equal(fs.existsSync(path.join(process.cwd(), "src", "ecosystem_taxonomy.json")), false);

  fs.rmSync(workspace, { recursive: true, force: true });
});

test("taxonomy: fingerprint detects monorepo and package manager", () => {
  const workspace = makeWorkspace("fingerprint", {
    "package.json": "{}",
    "pnpm-lock.yaml": "",
    "pnpm-workspace.yaml": "",
  });
  const fp = sniffProjectFingerprint(workspace);
  assert.equal(fp.projectType, "monorepo");
  assert.equal(fp.packageManager, "pnpm");
  fs.rmSync(workspace, { recursive: true, force: true });
});

test("synthesizer: plan A yields 2 stages, plan B yields 3 ordered DAG stages", () => {
  const workspace = makeWorkspace("synth", { "package.json": "{}" });
  const taxonomy: EcosystemTaxonomy = {
    ...EMPTY_TAXONOMY,
    projectFingerprint: sniffProjectFingerprint(workspace),
  };
  const diagnosis = {
    taskDescription: "refactor the parser",
    researchSummary: "",
    requirementSlots: [],
    dynamicGoals: ["Ship verified work"],
  };

  const agile = synthesizeBlueprint("refactor the parser", diagnosis, {}, taxonomy, "A", undefined, undefined, workspace);
  assert.equal(agile.stages.length, 2);
  assert.ok((agile.stages[1].verificationCommands ?? []).length > 0);
  assert.equal(agile.stages[1].isReviewStage, undefined);
  assert.ok(agile.stages[0].allowedTools.includes("bash"));

  const modular = synthesizeBlueprint("refactor the parser", diagnosis, {}, taxonomy, "B", undefined, undefined, workspace);
  assert.equal(modular.stages.length, 3);
  assert.deepEqual(modular.stages.map((s) => s.stageId), [
    "stage_1_design",
    "stage_2_implement",
    "stage_3_review",
  ]);
  assert.equal(modular.stages[2].isReviewStage, true);
  assert.equal(modular.dagWaves?.length, 3);
  assert.match(modular.blueprintId, /^bp_/);

  fs.rmSync(workspace, { recursive: true, force: true });
});

test("verifier: missing artifacts fail the gate, present artifacts record hashes", () => {
  clearAllWorkspaceStores();
  const workspace = makeWorkspace("verify", { "package.json": "{}" });
  const target = inferArtifactProfile(sniffProjectFingerprint(workspace));

  const gate: BlueprintStage = {
    stageId: "stage_1",
    title: "Stage 1",
    coreObjective: "create index",
    boundCapabilities: {},
    expectedArtifact: "src/index.ts",
    artifactContract: "exists",
    allowedTools: ["read", "write"],
  };

  const missing = verifyStageArtifacts(gate, workspace);
  assert.equal(missing.valid, false);
  assert.equal(missing.isPrimaryMissing, true);
  assert.match(missing.remediationGuidance ?? "", /Missing expected artifact/);

  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "index.ts"), "export const value = 1;\n", "utf-8");

  const ok = verifyStageArtifacts(gate, workspace);
  assert.equal(ok.valid, true);
  assert.equal(ok.record?.path, gate.expectedArtifact);
  assert.equal((ok.record?.sha256 ?? "").length, 64);

  verifyStageArtifacts(gate, workspace);
  const failedOnce = verifyStageArtifacts(
    { ...gate, expectedArtifact: "src/missing.ts" },
    workspace
  );
  assert.equal(failedOnce.retryCount, 1);

  fs.rmSync(workspace, { recursive: true, force: true });
  assert.ok(target.summaryPath.includes(".pi/toolflow/reports"));
  clearAllWorkspaceStores();
});

test("anchor handshake: only active anchors bound to the workspace feed the planning hint", () => {
  const workspace = makeWorkspace("anchor", { "package.json": "{}" });
  const otherWorkspace = makeWorkspace("anchor-other", { "package.json": "{}" });
  const anchorDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolflow-anchor-state-"));

  fs.writeFileSync(
    path.join(anchorDir, "state.json"),
    JSON.stringify({
      anchors: [
        { id: 7, title: "Parser contract", status: "active", cwd: workspace, files: ["src/pinned.ts"] },
        { id: 8, title: "Closed note", status: "settled", cwd: workspace, files: ["src/ignored.ts"] },
        { id: 9, title: "Foreign note", status: "active", cwd: otherWorkspace, files: ["src/foreign.ts"] },
      ],
    }),
    "utf-8"
  );

  const previousAnchorDir = process.env.ANCHOR_DIR;
  process.env.ANCHOR_DIR = anchorDir;

  assert.deepEqual(loadActiveAnchorFiles(workspace).sort(), ["Parser contract", "src/pinned.ts"]);
  const hint = formatActiveAnchorHint(workspace);
  assert.match(hint, /Active Anchors: \[#7\] "Parser contract" \(Files: src\/pinned\.ts\)/);
  assert.equal(hint.includes("Closed note"), false);
  assert.equal(hint.includes("Foreign note"), false);

  if (previousAnchorDir === undefined) delete process.env.ANCHOR_DIR;
  else process.env.ANCHOR_DIR = previousAnchorDir;

  fs.rmSync(anchorDir, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(otherWorkspace, { recursive: true, force: true });
});

test("synthesizer: extracts task-mentioned source and test file paths into stage contracts", () => {
  const workspace = makeWorkspace("mentioned", { "package.json": "{}" });
  const bp = synthesizeBlueprint(
    "Fix divide by zero in src/calc.js so tests/calc.test.js passes",
    {
      taskDescription: "Fix divide by zero in src/calc.js so tests/calc.test.js passes",
      researchSummary: "",
      requirementSlots: [],
      dynamicGoals: [],
    },
    {},
    EMPTY_TAXONOMY,
    "A",
    undefined,
    undefined,
    workspace
  );
  assert.equal(bp.stages[0].expectedArtifact, "src/calc.js");
  assert.equal(bp.stages[1].expectedArtifact, "tests/calc.test.js");
  assert.ok(bp.stages[0].targetPatterns?.includes("src/calc.js"));
  assert.ok(bp.stages[0].targetPatterns?.includes("tests/calc.test.js"));
  fs.rmSync(workspace, { recursive: true, force: true });
});
