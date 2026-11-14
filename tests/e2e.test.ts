import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearAllWorkspaceStores, getWorkspaceStore } from "../src/core/workspace-store.js";
import { sniffProjectFingerprint } from "../src/planner/taxonomy.js";
import { synthesizeBlueprint } from "../src/planner/synthesizer.js";
import { verifyStageArtifacts } from "../src/planner/verifier.js";
import type { EcosystemTaxonomy } from "../src/core/types.js";

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolflow-e2e-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "e2e-app", version: "1.0.0", scripts: { build: "tsc", test: "node -e 0" } }),
    "utf-8"
  );
  return dir;
}

test("e2e: full stage lifecycle runs from blueprint to verified receipt and rollback", () => {
  clearAllWorkspaceStores();
  const workspace = makeWorkspace();
  const store = getWorkspaceStore(workspace);

  const taxonomy: EcosystemTaxonomy = {
    version: "e2e",
    scannedAt: Date.now(),
    projectFingerprint: sniffProjectFingerprint(workspace),
    extensions: [],
    skills: [],
    prompts: [],
    tools: [],
  };

  const blueprint = synthesizeBlueprint(
    "refactor the parser and verify it",
    {
      taskDescription: "refactor the parser and verify it",
      researchSummary: "",
      requirementSlots: [],
      dynamicGoals: ["Ship a verified parser"],
    },
    {},
    taxonomy,
    "B",
    ["Keep public API stable"],
    undefined,
    workspace
  );

  assert.equal(blueprint.stages.length, 3);
  store.startBlueprintExecution(blueprint);

  const [design, implement, review] = blueprint.stages;
  assert.equal(store.getState().status, "in_progress");
  assert.ok(store.getState().dynamicTargetFiles?.includes(design.expectedArtifact));

  // Stage 1: produce the design artifact.
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "index.ts"), "export interface Parser { parse(input: string): number; }\n", "utf-8");

  const stage1 = verifyStageArtifacts(design, workspace, "Defined Parser interface.");
  assert.equal(stage1.valid, true);
  assert.equal(store.advanceStage(), true);
  assert.equal(store.getState().currentStageIndex, 1);

  // Stage 2: implement plus tests; verification commands are executed for real.
  implement.verificationCommands = ['node -e "process.exit(0)"'];
  fs.mkdirSync(path.join(workspace, "tests"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "tests", "index.test.ts"), "// tests\n", "utf-8");
  fs.writeFileSync(
    path.join(workspace, "src", "index.ts"),
    "export interface Parser { parse(input: string): number; }\nexport const parse = (input: string): number => input.length;\n",
    "utf-8"
  );

  const stage2 = verifyStageArtifacts(implement, workspace, "Implemented parser with tests.");
  assert.equal(stage2.valid, true);
  assert.equal(store.advanceStage(), true);
  assert.equal(store.getState().currentStageIndex, 2);

  // Stage 3: read-only review gate.
  assert.equal(review.isReviewStage, true);
  const stage3 = verifyStageArtifacts(review, workspace, "Reviewed diff.");
  assert.equal(stage3.valid, true);
  assert.equal(store.advanceStage(), false);

  const completed = store.getState();
  assert.equal(completed.status, "completed");
  assert.equal(Object.keys(completed.artifactLedger).length >= 2, true);

  // Rollback to stage 1 removes later-stage artifacts.
  const rollback = store.rollbackStage(0);
  assert.equal(rollback.success, true);
  assert.equal(rollback.deletedFiles.includes("tests/index.test.ts"), true);
  assert.equal(fs.existsSync(path.join(workspace, "tests", "index.test.ts")), false);
  assert.equal(store.getState().status, "in_progress");

  fs.rmSync(workspace, { recursive: true, force: true });
  clearAllWorkspaceStores();
});

test("e2e: retry escalation trips the circuit breaker after three missing artifacts", () => {
  clearAllWorkspaceStores();
  const workspace = makeWorkspace();
  const store = getWorkspaceStore(workspace);
  store.startBlueprintExecution({
    blueprintId: "bp_retry",
    task: "retry",
    createdAt: Date.now(),
    userChoices: {},
    activatedCapabilities: { extensions: [], skills: [], prompts: [] },
    tokenEfficiencySummary: "",
    stages: [
      {
        stageId: "stage_1",
        title: "Stage 1",
        coreObjective: "create",
        boundCapabilities: {},
        expectedArtifact: "src/never.ts",
        artifactContract: "exists",
        allowedTools: ["read", "write"],
      },
    ],
  });

  const stage = store.getState().currentBlueprint!.stages[0];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = verifyStageArtifacts(stage, workspace);
    assert.equal(result.valid, false);
    assert.equal(result.retryCount, attempt);
  }

  assert.equal(store.getState().status, "healing_failed_circuit_break");

  fs.rmSync(workspace, { recursive: true, force: true });
  clearAllWorkspaceStores();
});
