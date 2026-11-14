import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { ContextDehydrator } from "../optimizer/dehydrator.js";

/**
 * Validates that a candidate log path exists inside `<workDir>/.pi/toolflow/runs/`
 * and does not escape via symlinks, path traversal, or external drive paths.
 */
export function isSafeRunLog(candidate: string | null, workDir: string): candidate is string {
  if (!candidate || typeof candidate !== "string") return false;
  try {
    const resolvedWorkDir = path.resolve(workDir);
    const runsRoot = path.join(resolvedWorkDir, ".pi", "toolflow", "runs");
    if (!fs.existsSync(runsRoot)) return false;
    const realRunsRoot = fs.realpathSync(runsRoot);

    const targetPath = path.isAbsolute(candidate)
      ? candidate
      : path.resolve(resolvedWorkDir, candidate);
    if (!fs.existsSync(targetPath)) return false;
    const realTarget = fs.realpathSync(targetPath);

    const prefix = realRunsRoot.endsWith(path.sep) ? realRunsRoot : realRunsRoot + path.sep;
    if (process.platform === "win32") {
      return realTarget.toLowerCase().startsWith(prefix.toLowerCase());
    }
    return realTarget.startsWith(prefix);
  } catch {
    return false;
  }
}

export function registerToolFlowInspectTool(
  pi: ExtensionAPI,
  getActiveCwd: () => string
): void {
  if (typeof pi.registerTool !== "function") return;

  pi.registerTool({
    name: "toolflow_inspect",
    label: "ToolFlow Log Inspector",
    description:
      "Inspect dehydrated full command/tool logs under `.pi/toolflow/runs/` without polluting main context.",
    parameters: Type.Object({
      file: Type.Optional(
        Type.String({
          description: "Log file path inside `.pi/toolflow/runs/` (defaults to the latest dehydrated log).",
        })
      ),
      mode: Type.Optional(
        Type.Union([Type.Literal("head"), Type.Literal("tail"), Type.Literal("grep"), Type.Literal("range")], {
          description: "Inspection mode: tail (default), head, grep, or range.",
        })
      ),
      pattern: Type.Optional(
        Type.String({ description: "Regex or plain-text pattern when mode='grep'." })
      ),
      startLine: Type.Optional(
        Type.Number({ description: "1-based start line when mode='range' (default 1)." })
      ),
      lineCount: Type.Optional(
        Type.Number({ description: "Number of lines to return (default 60, max 200)." })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const workDir = ctx?.cwd || getActiveCwd();
      const candidate = params.file || ContextDehydrator.getLatestLogPath(workDir);

      if (!isSafeRunLog(candidate, workDir)) {
        return {
          content: [
            {
              type: "text",
              text: `[ToolFlow Inspector] Log file unavailable or outside \`.pi/toolflow/runs/\`: ${candidate || "(none)"}`,
            },
          ],
          details: {},
        };
      }

      const fullPath = path.isAbsolute(candidate)
        ? candidate
        : path.resolve(workDir, candidate);
      const raw = fs.readFileSync(fullPath, "utf-8");
      const lines = raw.split(/\r?\n/);
      const mode = params.mode || "tail";
      const limit = Math.min(200, Math.max(1, params.lineCount ?? 60));

      let selected: string[] = [];
      let headerInfo = "";

      if (mode === "head") {
        selected = lines.slice(0, limit);
        headerInfo = `head 1..${selected.length} / ${lines.length}`;
      } else if (mode === "tail") {
        const start = Math.max(0, lines.length - limit);
        selected = lines.slice(start);
        headerInfo = `tail ${start + 1}..${lines.length} / ${lines.length}`;
      } else if (mode === "range") {
        const start = Math.max(1, params.startLine ?? 1);
        selected = lines.slice(start - 1, start - 1 + limit).map((l, idx) => `${start + idx}: ${l}`);
        headerInfo = `range ${start}..${Math.min(lines.length, start - 1 + limit)} / ${lines.length}`;
      } else {
        const query = params.pattern || "";
        if (!query) {
          return {
            content: [{ type: "text", text: "[ToolFlow Inspector] Missing `pattern` for grep mode." }],
            details: {},
          };
        }
        let regex: RegExp | null = null;
        try {
          regex = new RegExp(query, "i");
        } catch {
          regex = null;
        }
        const matched: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          const hit = regex ? regex.test(lines[i]) : lines[i].includes(query);
          if (hit) {
            matched.push(`${i + 1}: ${lines[i]}`);
            if (matched.length >= limit) break;
          }
        }
        selected = matched.length > 0 ? matched : [`(No matches for "${query}")`];
        headerInfo = `grep "${query}" (${matched.length} matches in ${lines.length} lines)`;
      }

      const rel = path.relative(workDir, fullPath).replace(/\\/g, "/");
      return {
        content: [
          {
            type: "text",
            text: `[ToolFlow Inspector | ${rel} | ${headerInfo}]\n\n${selected.join("\n")}`,
          },
        ],
        details: { file: rel, totalLines: lines.length },
      };
    },
  });
}
