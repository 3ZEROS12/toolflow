import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { ArtifactRecord } from "../core/types.js";
import { normalizeWorkspaceKey } from "../core/atomic-fs.js";
import { getStatsManager } from "./stats.js";

export interface DehydratedStageHandoff {
  stageId: string;
  stageTitle: string;
  verifiedArtifacts: ArtifactRecord[];
  contractSummary: string;
  rawLogFilePath: string;
  tokenSavingsRatio: string;
  timestamp: number;
  topologyHints?: {
    importedFiles: string[];
    exportedSymbols: string[];
  };
}

export interface ToolDehydrationResult {
  dehydrated: boolean;
  text: string;
  logFilePath?: string;
  originalLines: number;
  originalBytes: number;
  tokensSaved: number;
  loopBusterTriggered?: boolean;
}

interface FailureStreak {
  lastFailureHash: string;
  consecutiveIdenticalFailures: number;
}

const MAX_RUNS_DISK_QUOTA_BYTES = 50 * 1024 * 1024;
const MAX_LINE_THRESHOLD = 40;
const MAX_BYTE_THRESHOLD = 4096;
let logSeqCounter = 0;
/**
 * Compacts oversized bash/grep/find logs to `.pi/toolflow/runs/`, extracts semantic error frames,
 * triggers Loop Buster on repeated identical failures, and enforces disk quota hygiene.
 */
export class ContextDehydrator {
  private readonly cwd: string;
  private readonly runsBaseDir: string;
  private lastFailedCommandHash = "";
  private consecutiveIdenticalFailures = 0;

  private static readonly latestLogPaths = new Map<string, string>();
  private static readonly protectedPathPools = new Map<string, Set<string>>();

  constructor(cwd: string = process.cwd()) {
    this.cwd = path.resolve(cwd);
    this.runsBaseDir = path.join(this.cwd, ".pi", "toolflow", "runs");
  }

  private static workspaceKey(cwd: string): string {
    return normalizeWorkspaceKey(cwd);
  }

  public static setProtectedPaths(paths: string[], cwd: string = process.cwd()): void {
    const key = ContextDehydrator.workspaceKey(cwd);
    const set = new Set<string>();
    for (const p of paths) {
      if (p) set.add(path.resolve(cwd, p));
    }
    ContextDehydrator.protectedPathPools.set(key, set);
  }

  public static getProtectedPaths(cwd: string = process.cwd()): Set<string> {
    return ContextDehydrator.protectedPathPools.get(ContextDehydrator.workspaceKey(cwd)) ?? new Set();
  }

  public static clearProtectedPaths(cwd?: string): void {
    if (cwd) {
      ContextDehydrator.protectedPathPools.delete(ContextDehydrator.workspaceKey(cwd));
    } else {
      ContextDehydrator.protectedPathPools.clear();
    }
  }

  public static getLatestLogPath(cwd?: string): string | null {
    if (cwd) {
      return ContextDehydrator.latestLogPaths.get(ContextDehydrator.workspaceKey(cwd)) ?? null;
    }
    let last: string | null = null;
    for (const value of ContextDehydrator.latestLogPaths.values()) last = value;
    return last;
  }

  public static setLatestLogPath(filePath: string, cwd: string = process.cwd()): void {
    ContextDehydrator.latestLogPaths.set(ContextDehydrator.workspaceKey(cwd), filePath);
  }

  public static clearLatestLogPaths(): void {
    ContextDehydrator.latestLogPaths.clear();
  }

  public getDirectorySizeBytes(dirPath: string = this.runsBaseDir): number {
    let total = 0;
    try {
      if (!fs.existsSync(dirPath)) return 0;
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          total += this.getDirectorySizeBytes(full);
        } else if (entry.isFile()) {
          try {
            total += fs.statSync(full).size;
          } catch {
            // Ignore transient vanished file
          }
        }
      }
    } catch {
      return 0;
    }
    return total;
  }

  public pruneOldRuns(maxAgeHours: number = 24, maxTotalBytes: number = MAX_RUNS_DISK_QUOTA_BYTES): number {
    let deletedCount = 0;
    try {
      if (!fs.existsSync(this.runsBaseDir)) return 0;

      const cutoffMs = Date.now() - maxAgeHours * 60 * 60 * 1000;
      const allFiles: Array<{ path: string; mtimeMs: number; size: number }> = [];
      const protectedSet = ContextDehydrator.getProtectedPaths(this.cwd);

      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.isFile()) {
            try {
              const stat = fs.statSync(full);
              allFiles.push({ path: full, mtimeMs: stat.mtimeMs, size: stat.size });
            } catch {
              // Ignore vanished file
            }
          }
        }
      };

      walk(this.runsBaseDir);
      allFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);

      let currentTotal = allFiles.reduce((acc, f) => acc + f.size, 0);
      for (const file of allFiles) {
        const isProtected = protectedSet.has(path.resolve(file.path));
        const expired = file.mtimeMs < cutoffMs;
        const overQuota = currentTotal > maxTotalBytes;

        if (!isProtected && (expired || overQuota)) {
          try {
            fs.unlinkSync(file.path);
            currentTotal -= file.size;
            deletedCount++;
          } catch {
            // Ignore locked file
          }
        }
      }

      for (const entry of fs.readdirSync(this.runsBaseDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const stageDir = path.join(this.runsBaseDir, entry.name);
        try {
          if (fs.readdirSync(stageDir).length === 0) {
            fs.rmdirSync(stageDir);
          }
        } catch {
          // Ignore non-empty or busy dir
        }
      }
    } catch {
      // Best-effort cleanup
    }
    return deletedCount;
  }

  public extractTopologyHints(stageText: string): { importedFiles: string[]; exportedSymbols: string[] } {
    const importedFiles = new Set<string>();
    const exportedSymbols = new Set<string>();

    const importRegex = /(?:import|from|require\()\s*['"]([^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(stageText)) !== null) {
      if (match[1]) importedFiles.add(match[1]);
      if (importedFiles.size >= 15) break;
    }

    const exportRegex =
      /export\s+(?:async\s+)?(?:function|class|const|interface|type|enum)\s+([a-zA-Z0-9_]+)/g;
    while ((match = exportRegex.exec(stageText)) !== null) {
      if (match[1]) exportedSymbols.add(match[1]);
      if (exportedSymbols.size >= 20) break;
    }

    return {
      importedFiles: Array.from(importedFiles),
      exportedSymbols: Array.from(exportedSymbols),
    };
  }

  public extractSemanticErrors(lines: string[], isError: boolean): string[] {
    if (!isError && lines.length === 0) return [];

    const highlights: string[] = [];
    const seen = new Set<string>();
    const errorMatchers: readonly RegExp[] = [
      /\berror\s+TS\d+:/i,
      /\bTypeError:|ReferenceError:|SyntaxError:|RangeError:|AssertionError/i,
      /\bERR![^\n]+/,
      /\berror\[E\d+\]:/i,
      /\bpanicked at\b/i,
      /\bTraceback \(most recent call last\):/i,
      /\b[A-Za-z]+Error:\s+.+/,
      /\bFAIL\s+[^\s]+/,
      /\bAssertionFailed|Expected.*to equal/i,
      /\.go:\d+:\d+:/,
      /\bat\s+[^\n]+\([^)]+:\d+:\d+\)/,
      /^\s*-->\s+[^:]+:\d+:\d+/,
    ];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.length > 500) continue;

      if (errorMatchers.some(rx => rx.test(line))) {
        const trimmed = line.trim();
        if (!seen.has(trimmed)) {
          seen.add(trimmed);
          highlights.push(trimmed);
          const nextLine = lines[i + 1]?.trim();
          if (nextLine && nextLine.length < 240 && !seen.has(nextLine)) {
            if (/^(\^|~+|\s*\||at\s+|Expected|Received)/.test(nextLine)) {
              seen.add(nextLine);
              highlights.push(`  ${nextLine}`);
            }
          }
        }
      }
      if (highlights.length >= 16) break;
    }
    return highlights;
  }

  public getFailureStreak(): FailureStreak {
    return {
      lastFailureHash: this.lastFailedCommandHash,
      consecutiveIdenticalFailures: this.consecutiveIdenticalFailures,
    };
  }

  public dehydrateToolOutput(
    toolName: string,
    rawText: string,
    isError: boolean = false,
    stageId: string = "default"
  ): ToolDehydrationResult {
    const safeText = typeof rawText === "string" ? rawText : String(rawText ?? "");
    const lines = safeText.split(/\r?\n/);
    const originalLines = lines.length;
    const originalBytes = Buffer.byteLength(safeText, "utf-8");

    let loopBusterTriggered = false;
    if (isError) {
      const errorSignature = safeText.slice(0, 600).replace(/\d{10,}/g, "<TS>");
      const errHash = crypto.createHash("md5").update(`${toolName}:${errorSignature}`).digest("hex");
      if (errHash === this.lastFailedCommandHash) {
        this.consecutiveIdenticalFailures++;
        if (this.consecutiveIdenticalFailures >= 2) {
          loopBusterTriggered = true;
        }
      } else {
        this.lastFailedCommandHash = errHash;
        this.consecutiveIdenticalFailures = 1;
      }
    } else {
      this.lastFailedCommandHash = "";
      this.consecutiveIdenticalFailures = 0;
    }

    if (originalLines <= MAX_LINE_THRESHOLD && originalBytes <= MAX_BYTE_THRESHOLD) {
      if (loopBusterTriggered) {
        const loopWarning =
          `[ToolFlow Loop Buster] Tool "${toolName}" failed identically ${this.consecutiveIdenticalFailures} times in a row. ` +
          `Stop repeating the same call. Inspect the root cause or switch strategy.\n\n${safeText}`;
        return {
          dehydrated: true,
          text: loopWarning,
          originalLines,
          originalBytes,
          tokensSaved: 0,
          loopBusterTriggered: true,
        };
      }
      return {
        dehydrated: false,
        text: safeText,
        originalLines,
        originalBytes,
        tokensSaved: 0,
        loopBusterTriggered: false,
      };
    }

    const safeStageId = stageId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const stageDir = path.join(this.runsBaseDir, safeStageId);
    const logFileName = `tool_${toolName.replace(/[^a-zA-Z0-9_-]/g, "_")}_${Date.now()}_${++logSeqCounter}.log`;
    const logFilePath = path.join(stageDir, logFileName);
    const relLogPath = path.relative(this.cwd, logFilePath).replace(/\\/g, "/");

    try {
      fs.mkdirSync(stageDir, { recursive: true });
      fs.writeFileSync(logFilePath, safeText, "utf-8");
      ContextDehydrator.setLatestLogPath(relLogPath, this.cwd);
      this.pruneOldRuns(24, MAX_RUNS_DISK_QUOTA_BYTES);
    } catch {
      return {
        dehydrated: false,
        text: safeText,
        originalLines,
        originalBytes,
        tokensSaved: 0,
      };
    }

    const semanticErrors = this.extractSemanticErrors(lines, isError);
    const headCount = Math.min(8, Math.floor(originalLines / 2));
    const tailCount = isError ? 24 : 14;
    const headSnippet = lines.slice(0, headCount).join("\n");
    const tailSnippet = lines.slice(Math.max(headCount, originalLines - tailCount)).join("\n");

    const sections: string[] = [];
    if (loopBusterTriggered) {
      sections.push(
        `[ToolFlow Loop Buster] "${toolName}" failed identically ${this.consecutiveIdenticalFailures} consecutive times. ` +
          `Stop retrying the exact command; inspect "${relLogPath}" or change approach.`
      );
    }

    if (semanticErrors.length > 0) {
      sections.push(
        `--- [Semantic Error Peak (${semanticErrors.length} frames)] ---\n${semanticErrors.join("\n")}`
      );
    }

    sections.push(`--- [Head (${headCount} lines)] ---\n${headSnippet}`);
    sections.push(`--- [Tail (${Math.min(tailCount, originalLines)} lines)] ---\n${tailSnippet}`);

    const summaryText =
      `[ToolFlow Dehydrated Output | ${toolName}]\n` +
      `Full output (${originalLines} lines, ${(originalBytes / 1024).toFixed(1)} KB) saved to: ${relLogPath}\n` +
      `Use \`toolflow_inspect(mode="grep", pattern="...")\` or \`read(path="${relLogPath}", offset=..., limit=...)\` to inspect details.\n\n` +
      sections.join("\n\n");

    const tokensSaved = Math.max(0, Math.round((safeText.length - summaryText.length) / 4));
    getStatsManager(this.cwd).recordSavings({
      tokensSaved,
      dehydratedLogs: 1,
    });

    return {
      dehydrated: true,
      text: summaryText,
      logFilePath: relLogPath,
      originalLines,
      originalBytes,
      tokensSaved,
      loopBusterTriggered,
    };
  }

  public dehydrateStageLog(params: {
    stageId: string;
    stageTitle: string;
    rawStageOutput: string;
    verifiedArtifacts: ArtifactRecord[];
    contractSummary: string;
  }): DehydratedStageHandoff {
    const safeStageId = params.stageId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const stageDir = path.join(this.runsBaseDir, safeStageId);
    const logFileName = `stage_run_${Date.now()}_${++logSeqCounter}.log`;
    const logFilePath = path.join(stageDir, logFileName);
    const relLogPath = path.relative(this.cwd, logFilePath).replace(/\\/g, "/");

    try {
      fs.mkdirSync(stageDir, { recursive: true });
      fs.writeFileSync(logFilePath, params.rawStageOutput, "utf-8");
      ContextDehydrator.setLatestLogPath(relLogPath, this.cwd);
      this.pruneOldRuns(24, MAX_RUNS_DISK_QUOTA_BYTES);
    } catch {
      // Ignore write failures
    }

    const rawBytes = Buffer.byteLength(params.rawStageOutput || "", "utf-8");
    const compactText =
      `Stage ${params.stageTitle} completed. Contract: ${params.contractSummary}. ` +
      `Artifacts: ${params.verifiedArtifacts.map(a => a.path).join(", ")}`;
    const compactBytes = Buffer.byteLength(compactText, "utf-8");
    const ratio = rawBytes > 0 ? `${Math.max(0, Math.round((1 - compactBytes / rawBytes) * 100))}%` : "0%";

    // No recordSavings here: the raw turn text is copied to `.pi/toolflow/runs/`, not replaced
    // in context, so nothing was reclaimed. The compact summary is returned as a handoff and the
    // same bytes are folded (and counted) later by the context slimmer.

    const topologyHints = this.extractTopologyHints(params.rawStageOutput || "");
    return {
      stageId: params.stageId,
      stageTitle: params.stageTitle,
      verifiedArtifacts: params.verifiedArtifacts,
      contractSummary: params.contractSummary,
      rawLogFilePath: relLogPath,
      tokenSavingsRatio: ratio,
      timestamp: Date.now(),
      topologyHints,
    };
  }
}

const dehydratorPool = new Map<string, ContextDehydrator>();

export function getDehydrator(cwd: string = process.cwd()): ContextDehydrator {
  const key = normalizeWorkspaceKey(cwd);
  let instance = dehydratorPool.get(key);
  if (!instance) {
    instance = new ContextDehydrator(cwd);
    dehydratorPool.set(key, instance);
  }
  return instance;
}

export function clearAllDehydrators(): void {
  dehydratorPool.clear();
  ContextDehydrator.clearLatestLogPaths();
  ContextDehydrator.clearProtectedPaths();
}
