import { getWorkspaceStore } from "../core/workspace-store.js";
import { loadActiveAnchorFiles, isProtectedAnchorText } from "../planner/anchor-handshake.js";
import { getStatsManager } from "./stats.js";

const HEAVY_TOOL_NAMES: Record<string, true> = {
  browser_probe_interaction: true,
  browser_target_lease: true,
  browser_reload_extension: true,
  subagent: true,
  subagent_supervisor: true,
  bg_wait: true,
  web_search: true,
  source_check: true,
  fetch_content: true,
  image_describe: true,
};

/** Messages kept verbatim at the tail of the transcript (roughly four turns). */
const RECENT_MESSAGE_WINDOW = 8;

export interface ProviderToolEntry {
  name?: string;
  [key: string]: unknown;
}

export interface ContextSlimmingMessage {
  role?: string;
  toolName?: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface ContextSlimmingEvent {
  tools?: ProviderToolEntry[];
  messages?: ContextSlimmingMessage[];
}

export function isHeavyTool(name: string): boolean {
  if (!name) return false;
  return Boolean(HEAVY_TOOL_NAMES[name]) || name.startsWith("mcp_") || name.startsWith("browser_");
}

/**
 * Prunes heavy external MCP, browser, and subagent tool schemas from the LLM context
 * unless explicitly permitted by the active blueprint stage.
 */
export function pruneHeavyProviderTools(event: ContextSlimmingEvent, cwd?: string): void {
  if (!event || !Array.isArray(event.tools) || event.tools.length === 0) return;

  const store = getWorkspaceStore(cwd);
  const state = store.getState();

  const isInActiveBlueprint = state.status === "in_progress" && state.currentBlueprint !== null;
  let stageAllowedSet: Set<string> | null = null;

  if (isInActiveBlueprint && state.currentBlueprint) {
    const activeStage = state.currentBlueprint.stages[state.currentStageIndex];
    if (activeStage) {
      stageAllowedSet = new Set(store.computeStageTools(activeStage.allowedTools || []));
    }
  }

  const originalLength = event.tools.length;
  const prunedTools = event.tools.filter(tool => {
    const name = typeof tool?.name === "string" ? tool.name : "";
    if (!name) return true;
    if (stageAllowedSet) {
      return stageAllowedSet.has(name) || !isHeavyTool(name);
    }
    return !isHeavyTool(name);
  });

  if (prunedTools.length < originalLength && prunedTools.length > 0) {
    event.tools = prunedTools;
  }
}

function compactBlock(text: string, toolName: string): string {
  const lineCount = text.split("\n").length;
  const firstLine = text.split("\n")[0]?.slice(0, 80) || "";
  return (
    `[ToolFlow Slimmed History | ${toolName}] (${lineCount} lines, ${text.length} chars). ` +
    `Head: "${firstLine}..." -> Inspect the archived log or re-read the file if needed.`
  );
}

/**
 * Folds verbose historical tool results and `write`/`edit` argument echoes in the older half
 * of the transcript. Recent messages and anchor-protected contracts stay byte-identical.
 */
export function slimHistoricalContextMessages(event: ContextSlimmingEvent, cwd?: string): void {
  if (!event || !Array.isArray(event.messages) || event.messages.length === 0) return;

  const messages = event.messages;
  if (messages.length <= RECENT_MESSAGE_WINDOW) return;

  const anchorFiles = loadActiveAnchorFiles(cwd);
  const protectIndex = messages.length - RECENT_MESSAGE_WINDOW;
  let tokensReclaimed = 0;

  for (let i = 0; i < protectIndex; i++) {
    const message = messages[i];
    if (!message) continue;

    if (message.role === "toolResult") {
      const toolName = message.toolName || "tool";

      if (Array.isArray(message.content)) {
        for (const item of message.content) {
          if (!item || typeof item !== "object" || !("type" in item) || !("text" in item)) continue;
          const block = item as { type?: unknown; text?: unknown };
          if (block.type !== "text" || typeof block.text !== "string") continue;
          if (block.text.length <= 600) continue;
          if (isProtectedAnchorText(block.text, anchorFiles)) continue;

          const compact = compactBlock(block.text, toolName);
          tokensReclaimed += Math.max(0, Math.round((block.text.length - compact.length) / 4));
          block.text = compact;
        }
      } else if (typeof message.content === "string" && message.content.length > 600) {
        if (!isProtectedAnchorText(message.content, anchorFiles)) {
          const compact = compactBlock(message.content, toolName);
          tokensReclaimed += Math.max(0, Math.round((message.content.length - compact.length) / 4));
          message.content = compact;
        }
      }
      continue;
    }

    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const item of message.content) {
        if (!item || typeof item !== "object" || !("type" in item)) continue;
        const part = item as {
          type?: unknown;
          name?: unknown;
          arguments?: Record<string, unknown>;
        };
        if (part.type !== "toolCall" || !part.arguments) continue;
        if (part.name !== "write" && part.name !== "edit") continue;

        const targetPath = typeof part.arguments.path === "string" ? part.arguments.path : "file";
        for (const key of ["content", "newText"]) {
          const value = part.arguments[key];
          if (typeof value !== "string" || value.length <= 400) continue;
          const summary = `[ToolFlow Slimmed ToolArg] ${part.name} -> ${targetPath} (${value.length} chars)`;
          tokensReclaimed += Math.max(0, Math.round((value.length - summary.length) / 4));
          part.arguments[key] = summary;
        }
      }
    }
  }

  if (tokensReclaimed > 0) {
    getStatsManager(cwd).recordSavings({ tokensSaved: tokensReclaimed });
  }
}
