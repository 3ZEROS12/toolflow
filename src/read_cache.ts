import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { StatsManager } from "./stats.js";

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
  bypassReason?: "targeted_window" | "recent_edit_failure" | "small_file" | "command_dirty" | "not_cached";
}

const TS_JS_DECL_REGEX = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const)\s+([A-Za-z_$][\w$]*)/;
const PYTHON_DECL_REGEX = /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/;
const RUST_GO_DECL_REGEX = /^\s*(?:pub\s+)?(?:async\s+)?(?:fn|struct|enum|trait|func|type)\s+([A-Za-z_]\w*)/;

/**
 * 提取文件中的符号大纲 (Symbol Outline)，精确标注行号 (1-indexed)
 */
export function extractSymbolOutline(fileContent: string, maxItems = 12): string[] {
  if (!fileContent || typeof fileContent !== "string") return [];
  const lines = fileContent.split(/\r?\n/);
  const outline: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (
      TS_JS_DECL_REGEX.test(line) ||
      PYTHON_DECL_REGEX.test(line) ||
      RUST_GO_DECL_REGEX.test(line)
    ) {
      const lineNum = i + 1;
      const formatted = `L${lineNum}: ${trimmed.slice(0, 72).replace(/\s*\{$/, "")}`;
      outline.push(formatted);
      if (outline.length >= maxItems) {
        break;
      }
    }
  }

  return outline;
}

/**
 * ⚡ 文件读取去重与短期缓存管理器 (ReadCacheManager)
 * 具备 6 级穿透门禁与极速代码骨架提取 (Symbol Outline)，彻底避免 Agent 致盲与死锁
 */
export class ReadCacheManager {
  private cache: Map<string, { mtimeMs: number; hash: string; lastTurnIndex: number; linesCount: number }> = new Map();
  private lastCommandTimestamp: number = 0;
  private editFailures: Map<string, { failedTurn: number; timestamp: number }> = new Map();
  private stats: StatsManager;
  private cwd: string;

  constructor(cwd: string = process.cwd()) {
    this.cwd = path.resolve(cwd);
    this.stats = new StatsManager(cwd);
  }

  /**
   * 记录外部命令（如 bash）执行，作废任何潜在的命令副效应
   */
  public recordCommandExecution(): void {
    this.lastCommandTimestamp = Date.now();
  }

  private normalizeKey(filePath: string): string {
    const resolved = path.resolve(filePath).replace(/\\/g, "/");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  /**
   * 记录 edit/write 失败，用于下一次强制穿透供给完整源码
   */
  public recordEditFailure(filePath: string, currentTurn: number): void {
    if (!filePath) return;
    const normPath = this.normalizeKey(filePath);
    if (this.editFailures.size >= 50) {
      const now = Date.now();
      for (const [k, v] of this.editFailures.entries()) {
        if (currentTurn - v.failedTurn > 3 || now - v.timestamp >= 60000) {
          this.editFailures.delete(k);
        }
      }
    }
    this.editFailures.set(normPath, { failedTurn: currentTurn, timestamp: Date.now() });
    this.invalidate(filePath);
  }

  /**
   * 检查近期是否发生过编辑失败
   */
  public hasRecentEditFailure(filePath: string, currentTurn: number): boolean {
    if (!filePath) return false;
    const normPath = this.normalizeKey(filePath);
    const record = this.editFailures.get(normPath);
    if (!record) return false;
    // 3 轮内或 60 秒内只要发生过编辑失败，强制允许穿透读取供大模型纠错
    if (currentTurn - record.failedTurn <= 3 || Date.now() - record.timestamp < 60000) {
      return true;
    }
    this.editFailures.delete(normPath);
    return false;
  }

  /**
   * 检查文件读取是否可以命中去重缓存
   * @param filePath 读取的目标文件路径
   * @param fileContent 文件原始内容
   * @param currentTurn 当前会话轮次
   * @param input 工具入参（包含 offset / limit）
   */
  public checkOrUpdate(
    filePath: string,
    fileContent: string,
    currentTurn: number,
    input?: ReadToolInput
  ): CacheCheckResult {
    // 门禁 G1: 显式指定 offset/limit 的局部切片读取，绝对不拦截（提供精确代码上下文供 edit 匹配）
    if (input?.offset !== undefined || input?.limit !== undefined) {
      return { isDuplicate: false, bypassReason: "targeted_window" };
    }

    if (!filePath || !fileContent) {
      return { isDuplicate: false };
    }

    const normPath = this.normalizeKey(filePath);

    // 门禁 G2: 最近发生过 edit/write 失败，强制穿透供给完整文本供大模型纠错
    if (this.hasRecentEditFailure(filePath, currentTurn)) {
      return { isDuplicate: false, bypassReason: "recent_edit_failure" };
    }

    const lines = fileContent.split("\n");

    // 门禁 G3: 极小文件穿透（小于等于 5 行或字符数少于 200 的文件绝对穿透，低成本无拖拽）
    if (lines.length <= 5 || fileContent.length < 200) {
      return { isDuplicate: false, bypassReason: "small_file" };
    }

    // 门禁 G4: 外部命令执行后的副效应保护（15 秒内穿透）
    if (this.lastCommandTimestamp > 0 && Date.now() - this.lastCommandTimestamp < 15000) {
      this.invalidate(normPath);
      return { isDuplicate: false, bypassReason: "command_dirty" };
    }

    let currentMtime = 0;
    try {
      if (fs.existsSync(filePath)) {
        currentMtime = fs.statSync(filePath).mtimeMs;
      }
    } catch (_) {}

    // 1. 全量内容 SHA256 哈希计算（Node 原生极速哈希，耗时 <0.1ms）
    const hash = crypto.createHash("sha256").update(fileContent).digest("hex");
    const cached = this.cache.get(normPath);

    if (cached) {
      // 2. 真实物理 mtimeMs 变动检测：若磁盘修改时间发生变动（哪怕 1ms），一票否决
      const mtimeMatches = currentMtime > 0 ? (cached.mtimeMs === 0 || currentMtime === cached.mtimeMs) : true;
      const isUnchanged = mtimeMatches && cached.hash === hash;
      const turnDistance = currentTurn - cached.lastTurnIndex;

      // 仅在确认文件在磁盘和哈希上毫无任何变动，且处于近邻 15 轮次内生效
      if (isUnchanged && turnDistance >= 1 && turnDistance <= 15) {
        // 更新最后访问轮次
        const lastTurn = cached.lastTurnIndex;
        cached.lastTurnIndex = currentTurn;
        const relativePath = path.relative(this.cwd, filePath).replace(/\\/g, "/");

        const outline = extractSymbolOutline(fileContent, 12);
        const noticeLines = [
          `=== [⚡ ToolFlow Read Cache: "${relativePath}" (${lines.length} 行, 与第 ${lastTurn} 轮内容一致) ] ===`,
          `=== [⚡ 提示: 内容完全一致且未变更。若需查看或精准修改实现，请调用 read 传入 offset=<行号> limit=<行数> 按需读取] ===`
        ];
        if (outline.length > 0) {
          noticeLines.push(`[Symbol Outline]: ${outline.join(" | ")}`);
        }
        let notice = noticeLines.join("\n");
        const approxSavedTokens = Math.max(20, Math.round(Math.max(0, fileContent.length - notice.length) / 4));
        noticeLines[0] = `=== [⚡ ToolFlow Read Cache: "${relativePath}" (${lines.length} 行, 与第 ${lastTurn} 轮内容一致, 节约 ~${approxSavedTokens} Tokens) ] ===`;
        notice = noticeLines.join("\n");

        this.stats.recordSavings(approxSavedTokens, "read_cache");

        return {
          isDuplicate: true,
          savedLines: lines.length,
          savedTokens: approxSavedTokens,
          notice
        };
      }
    }

    // 记录最新真实物理指纹与内容哈希
    // 内存卫士：容量上限控制与长会话防腐淘汰 (LRU & 15-turn TTL)
    if (this.cache.size >= 100) {
      for (const [key, entry] of this.cache.entries()) {
        if (currentTurn - entry.lastTurnIndex > 15) {
          this.cache.delete(key);
        }
      }
      if (this.cache.size >= 100) {
        const excess = this.cache.size - 90;
        let pruned = 0;
        for (const key of this.cache.keys()) {
          this.cache.delete(key);
          if (++pruned >= excess) break;
        }
      }
    }

    this.cache.set(normPath, {
      mtimeMs: currentMtime,
      hash,
      lastTurnIndex: currentTurn,
      linesCount: lines.length
    });

    return { isDuplicate: false, bypassReason: "not_cached" };
  }

  /**
   * 清除特定路径缓存（当发现该文件被 write / edit 时调用，保证缓存不发霉）
   */
  public invalidate(filePath: string): void {
    if (!filePath) return;
    const normPath = this.normalizeKey(filePath);
    this.cache.delete(normPath);
  }

  /**
   * 重置所有读缓存
   */
  public clear(): void {
    this.cache.clear();
    this.editFailures.clear();
    this.lastCommandTimestamp = 0;
  }
}

const readCachePool = new Map<string, ReadCacheManager>();

function normalizeWorkspaceKey(cwd: string = process.cwd()): string {
  const resolved = path.resolve(cwd).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Returns a memoized ReadCacheManager for the specified workspace cwd.
 */
export function getReadCache(cwd: string = process.cwd()): ReadCacheManager {
  const key = normalizeWorkspaceKey(cwd);
  let instance = readCachePool.get(key);
  if (!instance) {
    instance = new ReadCacheManager(cwd);
    readCachePool.set(key, instance);
  }
  return instance;
}

/**
 * Clears and resets all cached read files across all workspace instances.
 */
export function clearAllReadCaches(): void {
  for (const cache of readCachePool.values()) {
    cache.clear();
  }
  readCachePool.clear();
}
