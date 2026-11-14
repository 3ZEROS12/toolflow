import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerToolFlowCommand } from "../src/extension/commands.js";
import { clearAllWorkspaceStores } from "../src/core/workspace-store.js";
import { getStatsManager } from "../src/optimizer/stats.js";

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolflow-cmd-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "cmd-app" }), "utf-8");
  return dir;
}

function registerCommandHarness() {
  const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
  const notifications: string[] = [];

  const pi = {
    on: () => {},
    registerTool: () => {},
    registerCommand: (name: string, def: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, def);
    },
    sendUserMessage: () => {},
    getActiveTools: () => ["read", "write", "bash"],
    getAllTools: () => ["read", "write", "bash"],
    setActiveTools: () => {},
  } as unknown as ExtensionAPI;

  registerToolFlowCommand(pi, () => process.cwd(), () => {});

  return { commands, notifications };
}

function makeContext(workspace: string, notifications: string[]): ExtensionContext {
  return {
    cwd: workspace,
    ui: {
      notify: (message: string) => notifications.push(message),
      setStatus: () => {},
      confirm: async () => false,
    },
    getActiveTools: () => ["read", "write", "bash"],
    getAllTools: () => ["read", "write", "bash"],
    setActiveTools: () => {},
  } as unknown as ExtensionContext;
}

test("command: /toolflow stats renders the savings ledger card", async () => {
  clearAllWorkspaceStores();
  const workspace = makeWorkspace();
  const { commands, notifications } = registerCommandHarness();
  getStatsManager(workspace).recordSavings({ tokensSaved: 2400, dehydratedLogs: 1, blastRadiusBlocks: 3 });

  await commands.get("toolflow")!.handler("stats", makeContext(workspace, notifications));

  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /\[ToolFlow Ledger\]/);
  assert.match(notifications[0], /~2\.4k/);
  assert.match(notifications[0], /1 log\(s\)/);
  assert.match(notifications[0], /3 block\(s\)/);
  assert.match(notifications[0], /stats\.jsonl/);

  fs.rmSync(workspace, { recursive: true, force: true });
  clearAllWorkspaceStores();
});

test("command: /toolflow dashboard pairs the stage view with the ledger", async () => {
  clearAllWorkspaceStores();
  const workspace = makeWorkspace();
  const { commands, notifications } = registerCommandHarness();

  await commands.get("toolflow")!.handler("dashboard", makeContext(workspace, notifications));

  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /Installed Ecosystem Capabilities|Execution Blueprint/);
  assert.match(notifications[0], /---/);
  assert.match(notifications[0], /\[ToolFlow Ledger\]/);

  fs.rmSync(workspace, { recursive: true, force: true });
  clearAllWorkspaceStores();
});

test("command: /toolflow help advertises the dashboard subcommand", async () => {
  clearAllWorkspaceStores();
  const workspace = makeWorkspace();
  const { commands, notifications } = registerCommandHarness();

  await commands.get("toolflow")!.handler("help", makeContext(workspace, notifications));

  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /\/toolflow dashboard/);
  assert.match(notifications[0], /\/toolflow stats/);

  fs.rmSync(workspace, { recursive: true, force: true });
  clearAllWorkspaceStores();
});
