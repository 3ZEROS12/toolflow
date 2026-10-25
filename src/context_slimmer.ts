import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getSessionState } from "./state.js";
import { StatsManager } from "./stats.js";

const HEAVY_TOOL_NAMES = new Set([
  "browser_probe_interaction",
  "browser_target_lease",
  "browser_reload_extension",
  "subagent",
  "subagent_supervisor",
  "bg_wait",
  "web_search",
  "source_check",
  "fetch_content",
  "image_describe"
]);

/**
 * Prunes heavy external MCP, browser, and subagent tool schemas during regular
 * conversational turns unless explicitly required by user prompt.
 */
export function pruneHeavyProviderTools(
  event: any,
  getActiveCwd?: () => string
): void {
  const state = getSessionState();
  // If actively running a blueprint, let stage-gated applyToolScoping handle it
  if (state.currentBlueprint && state.status === "in_progress") {
    return;
  }

  const payload = event?.payload;
  if (!payload || !Array.isArray(payload.tools) || payload.tools.length <= 10) {
    return;
  }

  const messages = payload.messages;
  if (!Array.isArray(messages) || messages.length === 0) return;
  const lastUserMsg = [...messages].reverse().find((m: any) => m.role === "user");
  let promptText = "";
  if (typeof lastUserMsg?.content === "string") {
    promptText = lastUserMsg.content;
  } else if (Array.isArray(lastUserMsg?.content)) {
    promptText = lastUserMsg.content.map((c: any) => c.text || "").join(" ");
  }

  // If user prompt mentions web, browser, subagents, or links, preserve all tools
  const needsHeavy = /(https?:\/\/|www\.|chrome|browser|web_search|search|crawl|subagent|delegate|supervisor|advisor|council|image_describe|screenshot)/i.test(promptText);
  if (needsHeavy) {
    return;
  }

  const removed: any[] = [];
  payload.tools = payload.tools.filter((t: any) => {
    const name = t.name || t.function?.name || "";
    if (HEAVY_TOOL_NAMES.has(name)) {
      removed.push(t);
      return false;
    }
    return true;
  });

  if (removed.length > 0) {
    let removedChars = 0;
    for (const def of removed) {
      try {
        removedChars += JSON.stringify(def).length;
      } catch (_) {}
    }
    const cwd = getActiveCwd ? getActiveCwd() : process.cwd();
    const stats = new StatsManager(cwd);
    stats.recordSavings(Math.round(removedChars / 4), "log");
  }
}

/**
 * Safely loads active anchor file paths and title keywords for cross-project context preservation.
 * Follows Playbook 7 handshake (anchor -> toolflow).
 */
export function loadActiveAnchorFiles(cwd?: string): string[] {
  try {
    const isTestEnv = !!(
      process.env.NODE_TEST_CONTEXT ||
      process.env.NODE_ENV === "test" ||
      process.env.VITEST ||
      (process.argv && process.argv.some(arg => /test/i.test(arg)))
    );

    if (isTestEnv && !process.env.ANCHOR_DIR) {
      return [];
    }

    const stateFile = process.env.ANCHOR_DIR
      ? path.join(process.env.ANCHOR_DIR, "state.json")
      : path.join(os.homedir(), ".anchor", "state.json");

    if (!fs.existsSync(stateFile)) {
      return [];
    }

    const raw = fs.readFileSync(stateFile, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.anchors)) {
      return [];
    }

    const normTargetCwd = cwd ? path.resolve(cwd).replace(/\\/g, "/").toLowerCase() : null;
    const targetBaseName = cwd ? path.basename(path.resolve(cwd)).toLowerCase() : null;

    const matchedFiles = new Set<string>();

    for (const anc of parsed.anchors) {
      if (!anc || anc.status !== "active") continue;

      if (normTargetCwd) {
        const normAncCwd = anc.cwd ? path.resolve(anc.cwd).replace(/\\/g, "/").toLowerCase() : "";
        const ancProject = typeof anc.project === "string" ? anc.project.toLowerCase() : "";
        const matchesCwd = normAncCwd && (
          normAncCwd === normTargetCwd ||
          normAncCwd.startsWith(normTargetCwd + "/") ||
          normTargetCwd.startsWith(normAncCwd + "/")
        );
        const matchesProject = ancProject && (
          ancProject === "global" ||
          ancProject === targetBaseName ||
          ancProject === normTargetCwd
        );
        if (!matchesCwd && !matchesProject && (normAncCwd || ancProject)) {
          continue;
        }
      }

      if (Array.isArray(anc.files)) {
        for (const file of anc.files) {
          if (typeof file === "string" && file.trim()) {
            matchedFiles.add(file.trim());
          }
        }
      }
      if (typeof anc.title === "string" && anc.title.trim()) {
        matchedFiles.add(anc.title.trim());
      }
    }

    return Array.from(matchedFiles);
  } catch (_) {
    return [];
  }
}

export function isProtectedAnchor(text: string, activeAnchorFiles: string[] = []): boolean {
  if (!text || typeof text !== "string") return false;
  return (
    text.includes("[ARCH_CONTRACT]") ||
    text.includes("[BLUEPRINT_ESTABLISHED]") ||
    text.includes("[FATAL_ERROR]") ||
    text.includes("ToolFlow Blueprint") ||
    text.includes("阶段目标:") ||
    text.includes("核心契约") ||
    text.includes("[Active Anchor Focus]") ||
    text.includes("<sticky-notes") ||
    (Array.isArray(activeAnchorFiles) && activeAnchorFiles.some(f => Boolean(f) && text.includes(f)))
  );
}

/**
 * Performs non-destructive sliding window folding on older historical tool results
 * and verbose assistant parameter echoes in the context message array.
 */
export function slimHistoricalContextMessages(event: any, cwd?: string): void {
  try {
    if (!event || !Array.isArray(event.messages)) return;
    const msgs = event.messages;
    const total = msgs.length;
    if (total <= 12) return;

    const activeAnchorFiles = loadActiveAnchorFiles(cwd || event.cwd);

    // Protect the most recent 8 messages (~3-4 turns); fold older tool results and echoes
    const protectIndex = Math.max(0, total - 8);
    for (let i = 0; i < protectIndex; i++) {
      const msg = msgs[i];
      if (!msg) continue;

      // 1. Tool outputs
      if (msg.role === "tool") {
        if (typeof msg.content === "string") {
          if (
            msg.content.length > 800 &&
            !msg.content.includes("ToolFlow Context Slimmer") &&
            !isProtectedAnchor(msg.content, activeAnchorFiles)
          ) {
            const lines = msg.content.split("\n");
            if (lines.length > 12) {
              const head = lines.slice(0, 4).join("\n");
              const tail = lines.slice(-2).join("\n");
              msg.content = `${head}\n... [⚡ ToolFlow Context Slimmer: Pruned ${lines.length - 6} lines of historical tool output] ...\n${tail}`;
            }
          }
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (
              part &&
              part.type === "text" &&
              typeof part.text === "string" &&
              part.text.length > 800 &&
              !part.text.includes("ToolFlow Context Slimmer") &&
              !isProtectedAnchor(part.text, activeAnchorFiles)
            ) {
              const lines = part.text.split("\n");
              if (lines.length > 12) {
                const head = lines.slice(0, 4).join("\n");
                const tail = lines.slice(-2).join("\n");
                part.text = `${head}\n... [⚡ ToolFlow Context Slimmer: Pruned ${lines.length - 6} lines of historical tool output] ...\n${tail}`;
              }
            }
          }
        }
      }

      // 2. Assistant toolCall arguments
      if (msg.role === "assistant") {
        const toolCalls = msg.toolCalls || msg.tool_calls;
        if (Array.isArray(toolCalls)) {
          for (const tc of toolCalls) {
            const fnName = (tc?.function?.name || tc?.name || "").toLowerCase();
            if (["write", "edit"].includes(fnName)) {
              if (tc.function && typeof tc.function.arguments === "string" && tc.function.arguments.length > 600) {
                try {
                  const parsed = JSON.parse(tc.function.arguments);
                  let mutated = false;
                  for (const key of ["content", "oldText", "newText"] as const) {
                    if (typeof parsed[key] === "string" && parsed[key].length > 400) {
                      const originalLines = parsed[key].split("\n").length;
                      parsed[key] = `[⚡ ToolFlow Slimmer: ${originalLines} lines (${key}) already written to ${parsed.path || "disk"}]`;
                      mutated = true;
                    }
                  }
                  if (mutated) {
                    tc.function.arguments = JSON.stringify(parsed);
                  }
                } catch (_) {}
              } else if (tc.input && typeof tc.input === "object") {
                for (const key of ["content", "oldText", "newText"] as const) {
                  if (typeof tc.input[key] === "string" && tc.input[key].length > 400) {
                    const originalLines = tc.input[key].split("\n").length;
                    tc.input[key] = `[⚡ ToolFlow Slimmer: ${originalLines} lines (${key}) already written to ${tc.input.path || "disk"}]`;
                  }
                }
              }
            }
          }
        }

        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part && (part.type === "tool_use" || part.type === "tool_call")) {
              const fnName = (part.name || "").toLowerCase();
              if (["write", "edit"].includes(fnName) && part.input && typeof part.input === "object") {
                if (part.input.content && typeof part.input.content === "string" && part.input.content.length > 400) {
                  const originalLines = part.input.content.split("\n").length;
                  part.input.content = `[⚡ ToolFlow Slimmer: ${originalLines} lines already written to ${part.input.path || "disk"}]`;
                }
              }
            }
          }
        }
      }
    }
  } catch (_) {}
}
