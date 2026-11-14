import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { normalizeWorkspaceKey } from "../core/atomic-fs.js";
import { getStatsManager } from "./stats.js";

export interface ReadToolInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface CacheCheckResult {
  isDuplicate: boolean;
  notice?: string;
  savedLines?: number;
  savedTokens?: number;
  bypassReason?:
    | "targeted_window"
    | "recent_edit_failure"
    | "small_file"
    | "command_dirty"
    | "not_cached";
}

const TS_JS_DECL_REGEX =
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|enum)\s+([a-zA-Z0-9_$]+)/;
const PYTHON_DECL_REGEX = /^\s*(?:async\s+)?(?:def|class)\s+([a-zA-Z0-9_]+)/;
const RUST_GO_DECL_REGEX = /^\s*(?:pub\s+)?(?:async\s+)?(?:fn|struct|enum|impl|trait|func|type)\s+([a-zA-Z0-9_]+)/;

/**
 * Extracts a compact top-level symbol outline with line numbers for cache hit reminders.
 */
export function extractSymbolOutline(fileContent: string, maxItems = 12): string[] {
  if (!fileContent || typeof fileContent !== "string") return [];
  const lines = fileContent.split(/\r?\n/);
  const outline: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    if (
      TS_JS_DECL_REGEX.test(line) ||
      PYTHON_DECL_REGEX.test(line) ||
      RUST_GO_DECL_REGEX.test(line)
    ) {
      const compact = line.trim().replace(/\s*\{.*$/, "").slice(0, 56);
      outline.push(`L${i + 1}: ${compact}`);
      if (outline.length >= maxItems) break;
    }
  }
  return outline;
}

interface CachedFileEntry {
  hash: string;
  mtimeMs: number;
  size: number;
  lines: number;
  estimatedTokens: number;
  symbolOutline: string[];
  lastReadAt: number;
}

/**
 * Workspace-scoped file read cache with 6 penetration gates so targeted slices,
 * small files, command-dirtied files, and post-edit-failure re-reads always pass through.
 */
export class ReadCacheManager {
  private readonly cwd: string;
  private readonly cache = new Map<string, CachedFileEntry>();
  private readonly recentEditFailurePaths = new Set<string>();
  private isWorkspaceDirtyByCommand = false;
  private readonly minLineThreshold = 30;

  constructor(cwd: string = process.cwd()) {
    this.cwd = path.resolve(cwd);
  }

  private resolveTarget(targetPath: string): string {
    return path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : path.resolve(this.cwd, targetPath);
  }

  private computeHashAndStats(fullPath: string): {
    hash: string;
    mtimeMs: number;
    size: number;
    lines: number;
    tokens: number;
    symbolOutline: string[];
  } | null {
    try {
      if (!fs.existsSync(fullPath)) return null;
      const stat = fs.statSync(fullPath);
      if (!stat.isFile()) return null;

      const content = fs.readFileSync(fullPath, "utf-8");
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      const lines = content.split(/\r?\n/).length;
      const tokens = Math.round(content.length / 4);
      const symbolOutline = extractSymbolOutline(content);
      return { hash, mtimeMs: stat.mtimeMs, size: stat.size, lines, tokens, symbolOutline };
    } catch {
      return null;
    }
  }

  public recordRead(input: ReadToolInput): void {
    if (!input || !input.path) return;
    if (input.offset !== undefined || input.limit !== undefined) return;

    const fullPath = this.resolveTarget(input.path);
    const info = this.computeHashAndStats(fullPath);
    if (!info) return;

    this.cache.set(fullPath, {
      hash: info.hash,
      mtimeMs: info.mtimeMs,
      size: info.size,
      lines: info.lines,
      estimatedTokens: info.tokens,
      symbolOutline: info.symbolOutline,
      lastReadAt: Date.now(),
    });
    this.recentEditFailurePaths.delete(fullPath);
    this.isWorkspaceDirtyByCommand = false;
  }

  public markFileDirty(targetPath: string): void {
    if (!targetPath) return;
    const fullPath = this.resolveTarget(targetPath);
    this.cache.delete(fullPath);
  }

  public markEditFailure(targetPath: string): void {
    if (!targetPath) return;
    const fullPath = this.resolveTarget(targetPath);
    this.recentEditFailurePaths.add(fullPath);
    this.cache.delete(fullPath);
  }

  public markWorkspaceDirtyByCommand(): void {
    this.isWorkspaceDirtyByCommand = true;
  }
  public checkRead(input: ReadToolInput, autoRecord = true): CacheCheckResult {
    if (!input || !input.path) return { isDuplicate: false, bypassReason: "not_cached" };

    if (input.offset !== undefined || input.limit !== undefined) {
      return { isDuplicate: false, bypassReason: "targeted_window" };
    }

    const fullPath = this.resolveTarget(input.path);

    if (this.recentEditFailurePaths.has(fullPath)) {
      this.recentEditFailurePaths.delete(fullPath);
      if (autoRecord) this.recordRead(input);
      return { isDuplicate: false, bypassReason: "recent_edit_failure" };
    }

    if (this.isWorkspaceDirtyByCommand) {
      this.isWorkspaceDirtyByCommand = false;
      this.cache.clear();
      if (autoRecord) this.recordRead(input);
      return { isDuplicate: false, bypassReason: "command_dirty" };
    }

    const cached = this.cache.get(fullPath);
    if (!cached) {
      if (autoRecord) this.recordRead(input);
      return { isDuplicate: false, bypassReason: "not_cached" };
    }

    if (cached.lines < this.minLineThreshold) {
      return { isDuplicate: false, bypassReason: "small_file" };
    }

    try {
      if (!fs.existsSync(fullPath)) {
        this.cache.delete(fullPath);
        return { isDuplicate: false, bypassReason: "not_cached" };
      }
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs === cached.mtimeMs && stat.size === cached.size) {
        return this.formatCacheHit(input.path, cached);
      }

      const info = this.computeHashAndStats(fullPath);
      if (!info) {
        this.cache.delete(fullPath);
        return { isDuplicate: false, bypassReason: "not_cached" };
      }

      if (info.hash === cached.hash) {
        cached.mtimeMs = info.mtimeMs;
        cached.lastReadAt = Date.now();
        return this.formatCacheHit(input.path, cached);
      }

      this.cache.set(fullPath, {
        hash: info.hash,
        mtimeMs: info.mtimeMs,
        size: info.size,
        lines: info.lines,
        estimatedTokens: info.tokens,
        symbolOutline: info.symbolOutline,
        lastReadAt: Date.now(),
      });
      return { isDuplicate: false, bypassReason: "not_cached" };
    } catch {
      return { isDuplicate: false, bypassReason: "not_cached" };
    }
  }

  private formatCacheHit(displayPath: string, cached: CachedFileEntry): CacheCheckResult {
    const savedTokens = Math.max(0, cached.estimatedTokens - 45);
    if (savedTokens > 0) {
      getStatsManager(this.cwd).recordSavings({
        tokensSaved: savedTokens,
        readCacheHits: 1,
      });
    }

    const outlineBlock =
      cached.symbolOutline.length > 0
        ? `\nSymbol outline (use offset/limit for targeted slices):\n  ${cached.symbolOutline.join(" | ")}`
        : "";

    const notice =
      `[ToolFlow Read Cache Hit] "${displayPath}" is unchanged since your last full read ` +
      `(${cached.lines} lines, SHA-256: ${cached.hash.slice(0, 8)}; saved ~${savedTokens} tokens). ` +
      `Reuse existing context or pass \`offset\` + \`limit\` to inspect a specific slice.${outlineBlock}`;

    return {
      isDuplicate: true,
      notice,
      savedLines: cached.lines,
      savedTokens,
    };
  }

  public clear(): void {
    this.cache.clear();
    this.recentEditFailurePaths.clear();
    this.isWorkspaceDirtyByCommand = false;
  }

  public getCachedCount(): number {
    return this.cache.size;
  }
}

const readCachePool = new Map<string, ReadCacheManager>();

export function getReadCache(cwd: string = process.cwd()): ReadCacheManager {
  const key = normalizeWorkspaceKey(cwd);
  let instance = readCachePool.get(key);
  if (!instance) {
    instance = new ReadCacheManager(cwd);
    readCachePool.set(key, instance);
  }
  return instance;
}

export function clearAllReadCaches(): void {
  for (const cache of readCachePool.values()) {
    cache.clear();
  }
  readCachePool.clear();
}
