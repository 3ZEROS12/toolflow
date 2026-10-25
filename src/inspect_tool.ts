import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { ContextDehydrator } from "./dehydrator.js";

/**
 * Validates that a candidate log file exists within the workspace's `.pi/toolflow/runs/` root
 * and does not escape via symlinks, path traversal, or outside drive letters.
 */
export function isSafeRunLog(candidate: string | null, workDir: string): candidate is string {
  if (!candidate || typeof candidate !== "string" || !fs.existsSync(candidate)) return false;
  const baseDir = path.join(workDir, ".pi", "toolflow");
  const runsRoot = path.resolve(baseDir, "runs");
  if (!fs.existsSync(runsRoot)) return false;

  try {
    const statRuns = fs.lstatSync(runsRoot);
    if (statRuns.isSymbolicLink() || !statRuns.isDirectory()) return false;

    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) return false;

    const real = fs.realpathSync(candidate);
    const realRunsRoot = fs.realpathSync(runsRoot);

    // Ensure runsRoot does not escape workDir
    const realWorkDir = fs.existsSync(workDir) ? fs.realpathSync(workDir) : path.resolve(workDir);
    const relRunsToWork = path.relative(realWorkDir, realRunsRoot);
    if (relRunsToWork.startsWith("..") || path.isAbsolute(relRunsToWork)) return false;

    const rel = path.relative(realRunsRoot, real);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;

    // Cross-platform slash and case normalization
    const normReal = real.replace(/\\/g, "/");
    const normRoot = realRunsRoot.replace(/\\/g, "/");
    const isMatch = process.platform === "win32"
      ? normReal.toLowerCase().startsWith(normRoot.toLowerCase() + "/")
      : normReal.startsWith(normRoot + "/");
    return isMatch;
  } catch {
    return false;
  }
}

export interface InspectParams {
  id?: string;
  findText?: string;
  offset?: number;
  limit?: number;
}

export interface InspectResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, any>;
  isError: boolean;
}

const clampLine = (l: string, maxLen: number = 500) =>
  l.length > maxLen ? l.slice(0, maxLen) + "... [line clamped]" : l;

/**
 * Slices or greps dehydrated log files bounded to the caller's offset and limit.
 */
export function executeToolFlowInspect(params: InspectParams, workDir: string): InspectResult {
  const baseDir = path.join(workDir, ".pi", "toolflow");
  const runsRoot = path.resolve(baseDir, "runs");

  const latestLogPath = ContextDehydrator.getLatestLogPath(workDir);
  let targetFile: string | null = isSafeRunLog(latestLogPath, workDir) ? latestLogPath : null;

  if (params.id && typeof params.id === "string") {
    const rawId = params.id.trim();
    // Reject null bytes and path traversal sequences
    if (!rawId.includes("\0") && !rawId.includes("..")) {
      const candidates = [
        path.resolve(workDir, rawId),
        path.join(baseDir, rawId),
        path.resolve(runsRoot, rawId),
        path.join(runsRoot, "default", path.basename(rawId))
      ];
      // Check subdirectories inside runsRoot
      if (fs.existsSync(runsRoot)) {
        try {
          const subDirs = fs.readdirSync(runsRoot, { withFileTypes: true });
          for (const sub of subDirs) {
            if (sub.isDirectory()) {
              candidates.push(path.join(runsRoot, sub.name, path.basename(rawId)));
            }
          }
        } catch (_) {}
      }
      const found = candidates.find(c => isSafeRunLog(c, workDir));
      targetFile = found || null;
    }
  }

  if (!targetFile || !fs.existsSync(targetFile)) {
    return {
      content: [{ type: "text", text: `No dehydrated log found matching "${params.id || 'latest'}".` }],
      details: { found: false, id: params.id || 'latest' },
      isError: true
    };
  }

  const raw = fs.readFileSync(targetFile, "utf-8");
  const lines = raw.split("\n");

  if (params.findText && typeof params.findText === "string") {
    const limit = Math.min(200, Math.max(1, typeof params.limit === "number" && !isNaN(params.limit) ? Math.floor(params.limit) : 50));
    const matches: string[] = [];

    let regex: RegExp | null = null;
    const trimmedFind = params.findText.trim();
    const regexMatch = trimmedFind.match(/^\/(.+)\/([gimsuy]*)$/);
    if (regexMatch && regexMatch[1].length <= 200) {
      try {
        const flags = regexMatch[2] ? regexMatch[2].replace(/g/g, "") : "i";
        regex = new RegExp(regexMatch[1], flags);
      } catch {
        regex = null;
      }
    }

    const queryLower = params.findText.toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const testLine = line.length > 2000 ? line.slice(0, 2000) : line;
      let matched = false;
      if (regex) {
        try {
          regex.lastIndex = 0;
          matched = regex.test(testLine);
        } catch {
          matched = false;
        }
      } else {
        matched = testLine.toLowerCase().includes(queryLower);
      }

      if (matched) {
        matches.push(`[Line ${i + 1}] ${clampLine(line, 500)}`);
        if (matches.length >= limit) break;
      }
    }

    return {
      content: [{
        type: "text",
        text: matches.length > 0
          ? `Found ${matches.length} matching lines in ${path.basename(targetFile)}:\n\n${matches.join("\n")}`
          : `No lines matching "${params.findText}" found in ${path.basename(targetFile)}.`
      }],
      details: { matches, totalLines: lines.length, targetFile },
      isError: false
    };
  }

  const offset = Math.max(1, typeof params.offset === "number" && !isNaN(params.offset) ? Math.floor(params.offset) : 1);
  const limit = Math.min(200, Math.max(1, typeof params.limit === "number" && !isNaN(params.limit) ? Math.floor(params.limit) : 50));

  if (offset > lines.length) {
    return {
      content: [{
        type: "text",
        text: `[${path.basename(targetFile)}] Offset ${offset} exceeds total line count (${lines.length}).`
      }],
      details: { offset, limit, totalLines: lines.length, targetFile },
      isError: false
    };
  }

  const slice = lines.slice(offset - 1, offset - 1 + limit).map(l => clampLine(l, 500));

  return {
    content: [{
      type: "text",
      text: `[${path.basename(targetFile)} Lines ${offset}-${offset + slice.length - 1} of ${lines.length}]\n\n${slice.join("\n")}`
    }],
    details: { offset, limit, totalLines: lines.length, targetFile },
    isError: false
  };
}

/**
 * Registers the `toolflow_inspect` tool with the Pi extension host.
 */
export function registerToolFlowInspectTool(
  pi: ExtensionAPI,
  getActiveCwd: () => string
): void {
  if (typeof pi.registerTool !== "function") return;

  pi.registerTool({
    name: "toolflow_inspect",
    label: "ToolFlow Log Inspector",
    description: "Inspect or search dehydrated tool output files stored by ToolFlow without blowing up the context window. Returns bounded line slices or matching grep passages.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Log ID or partial file path returned by ToolFlow dehydration notice" })),
      findText: Type.Optional(Type.String({ description: "Optional search query to locate matching lines" })),
      offset: Type.Optional(Type.Number({ description: "Starting line number (1-indexed, default 1)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum lines to return (default 50, max 200)" }))
    }),
    execute: async (_toolCallId, params: any, _signal, _onUpdate, ctx) => {
      const workDir = ctx?.cwd || getActiveCwd();
      return executeToolFlowInspect(params, workDir);
    }
  });
}
