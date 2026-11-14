import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerToolFlowHooks } from "../src/extension/hooks.js";
import { updateToolFlowStatusBar } from "../src/extension/commands.js";
import { getStatsManager } from "../src/optimizer/stats.js";
import { clearAllWorkspaceStores, getWorkspaceStore } from "../src/core/workspace-store.js";
import type { SessionPlanState } from "../src/core/types.js";
import { openArchitectNavigator } from "../src/ui/navigator.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface FakeHarness {
  handlers: Map<string, Handler>;
  notifications: string[];
  statuses: string[];
  sentMessages: string[];
  activeTools: string[];
}

function createHarness(): FakeHarness {
  const harness: FakeHarness = {
    handlers: new Map<string, Handler>(),
    notifications: [],
    statuses: [],
    sentMessages: [],
    activeTools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
  };

  // The extension only consumes the documented ExtensionAPI surface; this fake mirrors it.
  const pi = {
    on: (name: string, handler: Handler) => harness.handlers.set(name, handler),
    registerCommand: () => {},
    registerTool: () => {},
    sendUserMessage: (message: string) => harness.sentMessages.push(message),
    getActiveTools: () => [...harness.activeTools],
    getAllTools: () => [...harness.activeTools],
    setActiveTools: (tools: string[]) => {
      harness.activeTools = [...tools];
    },
  } as unknown as ExtensionAPI;

  registerToolFlowHooks(pi, () => process.cwd(), () => {});
  return harness;
}

function createContext(workspace: string) {
  const ctx = {
    cwd: workspace,
    ui: {
      notify: () => {},
      setStatus: () => {},
      confirm: async () => false,
    },
    getActiveTools: () => ["read", "write", "edit", "bash", "grep", "find", "ls"],
    getAllTools: () => ["read", "write", "edit", "bash", "grep", "find", "ls"],
    setActiveTools: () => {},
  };
  // Only the members the hooks touch are provided; Pi supplies the rest at runtime.
  return ctx as unknown as ExtensionContext;
}

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolflow-hooks-"));
  fs.writeFileSync(path.join(dir, "package.json"), "{}", "utf-8");
  return dir;
}

test("hooks: registers the full lifecycle surface", () => {
  const harness = createHarness();
  assert.deepEqual(
    [...harness.handlers.keys()].sort(),
    ["before_agent_start", "context", "session_start", "tool_call", "tool_result", "turn_end"]
  );
});

test("hooks: blocks protected writes and dehydrates verbose command output", async () => {
  clearAllWorkspaceStores();
  const workspace = makeWorkspace();
  const harness = createHarness();
  const ctx = createContext(workspace);

  await harness.handlers.get("session_start")!({ type: "session_start", reason: "new" }, ctx);

  const toolCall = harness.handlers.get("tool_call")!;
  const blocked = (await toolCall(
    { type: "tool_call", toolCallId: "call_1", toolName: "write", input: { path: ".env", content: "SECRET=1" } },
    ctx
  )) as { block?: boolean; reason?: string };
  assert.equal(blocked.block, true);
  assert.match(blocked.reason ?? "", /protected file/i);

  const allowed = await toolCall(
    { type: "tool_call", toolCallId: "call_2", toolName: "read", input: { path: "package.json" } },
    ctx
  );
  assert.equal(allowed, undefined);

  const noisy = Array.from({ length: 120 }, (_, index) => `compiled module ${index}`).join("\n");
  const toolResult = harness.handlers.get("tool_result")!;
  const dehydrated = (await toolResult(
    {
      type: "tool_result",
      toolCallId: "call_3",
      toolName: "bash",
      input: { command: "npm run build" },
      content: [{ type: "text", text: noisy }],
      details: {},
      isError: false,
    },
    ctx
  )) as { content: Array<{ type: string; text: string }> } | undefined;

  assert.ok(dehydrated);
  assert.match(dehydrated.content[0].text, /ToolFlow Dehydrated Output/);
  assert.equal(fs.existsSync(path.join(workspace, ".pi", "toolflow", "runs")), true);

  const quiet = await toolResult(
    {
      type: "tool_result",
      toolCallId: "call_4",
      toolName: "bash",
      input: { command: "echo ok" },
      content: [{ type: "text", text: "ok" }],
      details: {},
      isError: false,
    },
    ctx
  );
  assert.equal(quiet, undefined);

  fs.rmSync(workspace, { recursive: true, force: true });
  clearAllWorkspaceStores();
});

test("hooks: idle turn_end only refreshes status and never advances a blueprint", async () => {
  clearAllWorkspaceStores();
  const workspace = makeWorkspace();
  const harness = createHarness();
  const ctx = createContext(workspace);

  await harness.handlers.get("session_start")!({ type: "session_start", reason: "new" }, ctx);

  const result = await harness.handlers.get("turn_end")!(
    {
      type: "turn_end",
      message: { role: "assistant", content: [{ type: "text", text: "All done." }] },
      toolResults: [],
    },
    ctx
  );

  assert.equal(result, undefined);
  assert.deepEqual(harness.sentMessages, []);

  fs.rmSync(workspace, { recursive: true, force: true });
  clearAllWorkspaceStores();
});

test("hooks: mid-turn turn_end with non-empty toolResults does not advance stage prematurely", async () => {
  clearAllWorkspaceStores();
  const workspace = makeWorkspace();
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "calc.js"), "export const x = 1;\n", "utf-8");

  const store = getWorkspaceStore(workspace);
  store.startBlueprintExecution({
    blueprintId: "bp_midturn",
    task: "Fix calc",
    createdAt: Date.now(),
    userChoices: {},
    activatedCapabilities: { extensions: [], skills: [], prompts: [] },
    tokenEfficiencySummary: "",
    stages: [
      {
        stageId: "stage_1",
        title: "Stage 1",
        coreObjective: "edit src/calc.js",
        boundCapabilities: {},
        expectedArtifact: "src/calc.js",
        artifactContract: "exists",
        allowedTools: ["read", "edit"],
      },
      {
        stageId: "stage_2",
        title: "Stage 2",
        dependsOn: ["stage_1"],
        coreObjective: "verify",
        boundCapabilities: {},
        expectedArtifact: "src/calc.js",
        artifactContract: "passes",
        allowedTools: ["read"],
      },
    ],
  });

  const harness = createHarness();
  const ctx = createContext(workspace);

  await harness.handlers.get("turn_end")!(
    {
      type: "turn_end",
      message: { role: "assistant", content: [{ type: "text", text: "Reading file first." }] },
      toolResults: [{ role: "toolResult", toolName: "read", content: [] }],
    },
    ctx
  );
  assert.equal(store.getState().currentStageIndex, 0);
  assert.deepEqual(harness.sentMessages, []);

  fs.writeFileSync(path.join(workspace, "src", "calc.js"), "export const x = 2;\n", "utf-8");
  await harness.handlers.get("turn_end")!(
    {
      type: "turn_end",
      message: { role: "assistant", content: [{ type: "text", text: "Updated calc.js." }] },
      toolResults: [],
    },
    ctx
  );
  assert.equal(store.getState().currentStageIndex, 1);
  assert.equal(harness.sentMessages.length, 1);

  fs.rmSync(workspace, { recursive: true, force: true });
  clearAllWorkspaceStores();
});

test("navigator: detects unmounted RPC ui.custom stub and returns custom_ui_unavailable", async () => {
  const rpcStubUi = {
    custom: async <T>() => undefined as unknown as T,
  };
  const res = await openArchitectNavigator(rpcStubUi, {
    version: "rpc",
    scannedAt: Date.now(),
    extensions: [],
    skills: [],
    prompts: [],
    tools: [],
  });
  assert.deepEqual(res, { kind: "custom_ui_unavailable" });
});

test("hooks: context folds stale history once, then reports the reclaim on the badge", async () => {
  clearAllWorkspaceStores();
  const workspace = makeWorkspace();
  const anchorDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolflow-anchor-ctx-"));
  const previousAnchorDir = process.env.ANCHOR_DIR;
  process.env.ANCHOR_DIR = anchorDir;

  const harness = createHarness();
  await harness.handlers.get("session_start")!({ type: "session_start", reason: "new" }, createContext(workspace));

  const notifications: string[] = [];
  const statuses: string[] = [];
  const ctx = {
    cwd: workspace,
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: (_key: string, value: string) => statuses.push(value),
      confirm: async () => false,
    },
    getActiveTools: () => ["read"],
    getAllTools: () => ["read"],
    setActiveTools: () => {},
  } as unknown as ExtensionContext;

  const longText = `build log\n${"q".repeat(4000)}`;
  const messages: Array<Record<string, unknown>> = [
    { role: "toolResult", toolName: "bash", content: [{ type: "text", text: longText }] },
    ...Array.from({ length: 8 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: "ok" })),
  ];

  const context = harness.handlers.get("context")!;
  const first = (await context({ type: "context", messages }, ctx)) as { messages: unknown[] };
  assert.equal(first.messages, messages);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /Stage history compacted \(~\d+ tokens released\)/);
  assert.match(statuses.at(-1) ?? "", /saved/);

  // Folded blocks are short, so the next LLM call reclaims nothing and stays silent.
  await context({ type: "context", messages }, ctx);
  assert.equal(notifications.length, 1);

  if (previousAnchorDir === undefined) delete process.env.ANCHOR_DIR;
  else process.env.ANCHOR_DIR = previousAnchorDir;

  fs.rmSync(anchorDir, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
  clearAllWorkspaceStores();
});

test("status bar: compact badge tracks stage progress, guards, and clamps long titles", () => {
  clearAllWorkspaceStores();
  const workspace = makeWorkspace();
  const statuses: string[] = [];
  const ctx = {
    cwd: workspace,
    ui: { setStatus: (_key: string, value: string) => statuses.push(value) },
  } as unknown as ExtensionContext;

  const longTitle = "Extremely verbose architectural refactor stage title that would wrap";
  const blueprint = {
    blueprintId: "bp_status",
    task: "Refactor",
    createdAt: Date.now(),
    userChoices: {},
    activatedCapabilities: { extensions: [], skills: [], prompts: [] },
    tokenEfficiencySummary: "",
    stages: [
      { stageId: "stage_1", title: longTitle, coreObjective: "a", boundCapabilities: {}, expectedArtifact: "src/a.ts", artifactContract: "exists", allowedTools: ["read"] },
      { stageId: "stage_2", title: "Verify", coreObjective: "b", boundCapabilities: {}, expectedArtifact: "src/b.ts", artifactContract: "exists", allowedTools: ["read"] },
    ],
  } as unknown as SessionPlanState["currentBlueprint"];

  const baseState = {
    currentBlueprint: blueprint,
    currentStageIndex: 0,
    stepByStepGate: true,
    artifactLedger: {},
  };

  updateToolFlowStatusBar(ctx, { ...baseState, status: "in_progress" } as unknown as SessionPlanState, workspace);
  updateToolFlowStatusBar(ctx, { ...baseState, status: "completed" } as unknown as SessionPlanState, workspace);
  updateToolFlowStatusBar(ctx, { ...baseState, status: "healing_failed_circuit_break" } as unknown as SessionPlanState, workspace);
  updateToolFlowStatusBar(ctx, { ...baseState, currentBlueprint: null, status: "idle" } as unknown as SessionPlanState, workspace);

  assert.match(statuses[0], /^\[1\/2\] /);
  assert.ok(!statuses[0].includes("toolflow"), "the status key already carries the product name");
  assert.ok(statuses[0].includes("…"), "long stage titles are clamped");
  assert.ok(!statuses[0].includes(longTitle));
  assert.match(statuses[1], /^✓ Completed · ~0 saved$/);
  assert.match(statuses[2], /^▲ Paused · rollback · ~0 saved$/);
  assert.equal(statuses[3], "~0 saved");

  getStatsManager(workspace).recordSavings({ blastRadiusBlocks: 2, tokensSaved: 1200 });
  updateToolFlowStatusBar(ctx, { ...baseState, status: "in_progress" } as unknown as SessionPlanState, workspace);
  assert.match(statuses.at(-1)!, /~1\.2k saved · 2 guarded/);

  fs.rmSync(workspace, { recursive: true, force: true });
  clearAllWorkspaceStores();
});
