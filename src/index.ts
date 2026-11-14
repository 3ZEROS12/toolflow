import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerToolFlowCommand } from "./extension/commands.js";
import { registerToolFlowHooks } from "./extension/hooks.js";
import { registerToolFlowInspectTool } from "./extension/inspect-tool.js";

// Core exports
export * from "./core/types.js";
export * from "./core/atomic-fs.js";
export * from "./core/json-extract.js";
export * from "./core/messages.js";
export * from "./core/workspace-store.js";

// Optimizer exports
export * from "./optimizer/stats.js";
export * from "./optimizer/blast-radius.js";
export * from "./optimizer/read-cache.js";
export * from "./optimizer/dehydrator.js";
export * from "./optimizer/context-slimmer.js";

// Planner exports
export * from "./planner/taxonomy.js";
export * from "./planner/deep-ecosystem.js";
export * from "./planner/dag.js";
export * from "./planner/router.js";
export * from "./planner/synthesizer.js";
export * from "./planner/verifier.js";
export * from "./planner/prompts-manager.js";
export * from "./planner/memory.js";
export * from "./planner/anchor-handshake.js";
export * from "./planner/llm-client.js";

// UI exports
export * from "./ui/cards.js";
export * from "./ui/navigator.js";

/**
 * ToolFlow Pi Coding Agent Extension entrypoint.
 * Initializes lazily with zero filesystem side effects until session hooks or commands execute.
 */
export default function toolflow(pi: ExtensionAPI): void {
  let activeWorkspaceCwd = process.cwd();
  const getActiveCwd = () => activeWorkspaceCwd;
  const setActiveCwd = (cwd: string) => {
    if (cwd) activeWorkspaceCwd = cwd;
  };

  registerToolFlowInspectTool(pi, getActiveCwd);
  registerToolFlowCommand(pi, getActiveCwd, setActiveCwd);
  registerToolFlowHooks(pi, getActiveCwd, setActiveCwd);
}
