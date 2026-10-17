import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { ArtifactRecord } from "./types.js";

export interface DehydratedStageHandoff {
  stageId: string;
  stageTitle: string;
  verifiedArtifacts: ArtifactRecord[];
  contractSummary: string;
  rawLogFilePath: string;
  tokenSavingsRatio: string;
  timestamp: number;
  topologyHints?: {
    importedModules?: string[];
    exportedSymbols?: string[];
  };
}

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

export interface ToolFlowStats {
  totalTokensSaved: number;
  dehydratedLogsCount: number;
  readCacheHitsCount: number;
  blastRadiusBlocksCount: number;
  lastUpdated: number;
}

export class StatsManager {
  private statsFile: string;

  constructor(cwd: string = process.cwd()) {
    const baseDir = path.join(cwd, ".pi", "toolflow");
    try {
      fs.mkdirSync(baseDir, { recursive: true });
    } catch (_) {}
    this.statsFile = path.join(baseDir, "stats.json");
  }

  public getStats(): ToolFlowStats {
    try {
      if (fs.existsSync(this.statsFile)) {
        const raw = fs.readFileSync(this.statsFile, "utf-8");
        return JSON.parse(raw);
      }
    } catch (_) {}
    return {
      totalTokensSaved: 0,
      dehydratedLogsCount: 0,
      readCacheHitsCount: 0,
      blastRadiusBlocksCount: 0,
      lastUpdated: Date.now()
    };
  }

  public recordSavings(tokens: number, type: "log" | "read_cache" | "blast"): void {
    const stats = this.getStats();
    stats.totalTokensSaved += Math.max(0, tokens);
    if (type === "log") stats.dehydratedLogsCount++;
    else if (type === "read_cache") stats.readCacheHitsCount++;
    else if (type === "blast") stats.blastRadiusBlocksCount++;
    stats.lastUpdated = Date.now();

    const tempPath = `${this.statsFile}.tmp.${process.pid}.${Date.now()}`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(stats, null, 2), "utf-8");
      fs.renameSync(tempPath, this.statsFile);
    } catch (_) {
    } finally {
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch (_) {}
    }
  }

  public getFormattedSavings(): string {
    const stats = this.getStats();
    const tokens = stats.totalTokensSaved || 0;
    if (tokens < 1000) return `⌬ ${tokens}t`;
    if (tokens < 1000000) return `⌬ -${(tokens / 1000).toFixed(1)}k`;
    return `⌬ -${(tokens / 1000000).toFixed(2)}M`;
  }
}

const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10MB 单阶段日志截断上限
const MAX_TOTAL_DISK_BYTES = 200 * 1024 * 1024; // 200MB 运行归档总配额

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".svg",
  ".exe", ".dll", ".so", ".dylib", ".wasm", ".zip", ".tar", ".gz",
  ".7z", ".pdf", ".db", ".sqlite", ".bin"
]);

const IMPORT_REGEX = /(?:import\s+(?:\{[^}]+\}|\w+|\*\s+as\s+\w+)\s+from\s+["']([^"']+)["']|require\(["']([^"']+)["']\))/g;
const EXPORT_REGEX = /export\s+(?:async\s+)?(?:const|let|var|class|interface|type|enum|function)\s+(\w+)/g;
const NAMED_EXPORT_BLOCK_REGEX = /export\s*\{\s*([^}]+)\s*\}/g;

const INTERACTIVE_PATTERNS = [
  /\[y\/n\]/i,
  /\(y\/n\)/i,
  /\[yes\/no\]/i,
  /are you sure/i,
  /press any key/i,
  /password:/i,
  /enter pass phrase/i,
  /\? /
];

const ERROR_LINE_PATTERN = /(error[:\s]|fatal[:\s]|failed[:\s]|exception[:\s]|panic[:\s]|traceback)/i;
const ANSI_ESCAPE_REGEX = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\([a-zA-Z]/g;

export class ContextDehydrator {
  private static latestLogPath: string | null = null;
  private runsDir: string;
  private baseDir: string;
  private stats: StatsManager;
  private lastCommandRecord: {
    command: string;
    timestamp: number;
    outputDigest: string;
    mutationCount: number;
  } | null = null;
  private workspaceMutationCount = 0;

  constructor(cwd: string = process.cwd(), blueprintId: string = "default") {
    this.baseDir = path.join(cwd, ".pi", "toolflow", "runs");
    this.runsDir = path.join(this.baseDir, blueprintId);
    this.stats = new StatsManager(cwd);
    try {
      fs.mkdirSync(this.runsDir, { recursive: true });
    } catch (_) {}
  }

  public recordWorkspaceMutation(): void {
    this.workspaceMutationCount++;
  }

  private dehydrateCount: number = 0;

  public static getLatestLogPath(): string | null {
    return ContextDehydrator.latestLogPath;
  }

  public static setLatestLogPath(filePath: string): void {
    ContextDehydrator.latestLogPath = filePath;
  }

  private getDirectorySizeBytes(dirPath: string): number {
    let total = 0;
    try {
      if (!fs.existsSync(dirPath)) return 0;
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          total += this.getDirectorySizeBytes(full);
        } else if (entry.isFile()) {
          total += fs.statSync(full).size;
        }
      }
    } catch (_) {}
    return total;
  }

  /**
   * 清理单个运行目录下过量或过期的日志切片文件 (默认保留最近 50 个文件，总大小不超过 30MB)
   */
  public pruneRunLogs(
    dirPath: string = this.runsDir,
    maxFiles: number = 50,
    maxAgeMs: number = 7 * 24 * 60 * 60 * 1000,
    maxBytes: number = 30 * 1024 * 1024
  ): string[] {
    const deleted: string[] = [];
    try {
      if (!fs.existsSync(dirPath)) return deleted;
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const logFiles = entries
        .filter(e => e.isFile() && e.name.endsWith(".log"))
        .map(e => {
          const fullPath = path.join(dirPath, e.name);
          const stat = fs.statSync(fullPath);
          return { name: e.name, fullPath, mtimeMs: stat.mtimeMs, sizeBytes: stat.size };
        })
        .filter(f => f.fullPath !== ContextDehydrator.latestLogPath) // 保护当前最新的日志指针
        .sort((a, b) => a.mtimeMs - b.mtimeMs); // 最旧的排前面

      const now = Date.now();
      let totalSize = logFiles.reduce((acc, f) => acc + f.sizeBytes, 0);
      const retained = [...logFiles];

      for (const file of logFiles) {
        const isTooOld = now - file.mtimeMs > maxAgeMs;
        const isExceedingCount = retained.length > maxFiles;
        const isExceedingQuota = totalSize > maxBytes;

        if (isTooOld || isExceedingCount || isExceedingQuota) {
          try {
            fs.unlinkSync(file.fullPath);
            totalSize -= file.sizeBytes;
            const idx = retained.findIndex(r => r.name === file.name);
            if (idx >= 0) retained.splice(idx, 1);
            deleted.push(file.name);
          } catch (_) {}
        }
      }
    } catch (_) {}
    return deleted;
  }

  /**
   * 清理过期或超过容量配额的脱水归档运行目录 (LRU + 200MB 硬配额)
   */
  public pruneOldRuns(
    maxRuns: number = 10,
    maxAgeMs: number = 7 * 24 * 60 * 60 * 1000,
    maxDiskBytes: number = MAX_TOTAL_DISK_BYTES
  ): string[] {
    const deletedDirs: string[] = [];
    try {
      if (!fs.existsSync(this.baseDir)) return deletedDirs;
      const entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
      const runFolders = entries
        .filter(e => e.isDirectory())
        .map(e => {
          const fullPath = path.join(this.baseDir, e.name);
          const stat = fs.statSync(fullPath);
          const sizeBytes = this.getDirectorySizeBytes(fullPath);
          return { name: e.name, fullPath, mtimeMs: stat.mtimeMs, sizeBytes };
        })
        .filter(f => f.fullPath !== this.runsDir) // 保护当前正在执行的 Run，仅对其余历史运行目录实施配额管理
        .sort((a, b) => a.mtimeMs - b.mtimeMs); // 升序，最旧在前面 (Index 0 is Oldest)

      const now = Date.now();
      let totalSize = runFolders.reduce((acc, f) => acc + f.sizeBytes, 0);
      const retained = [...runFolders];

      for (const folder of runFolders) {
        const isTooOld = now - folder.mtimeMs > maxAgeMs;
        const isExceedingCount = retained.length > maxRuns;
        const isExceedingQuota = totalSize > maxDiskBytes;

        if (isTooOld || isExceedingCount || isExceedingQuota) {
          try {
            fs.rmSync(folder.fullPath, { recursive: true, force: true });
            totalSize -= folder.sizeBytes;
            const idx = retained.findIndex(r => r.name === folder.name);
            if (idx >= 0) retained.splice(idx, 1);
            deletedDirs.push(folder.name);
          } catch (_) {}
        }
      }
      // 深度盘点当前运行目录，清理当前 Run 内部积压的旧日志切片
      this.pruneRunLogs(this.runsDir);
    } catch (_) {}
    return deletedDirs;
  }

  /**
   * 将阶段庞大原始调试与执行日志落盘归档，返回脱水三元组，自动提取拓扑依赖提示
   */
  public dehydrateStageLog(
    stageId: string,
    stageTitle: string,
    rawLogs: string,
    artifacts: ArtifactRecord[],
    contractSummary: string
  ): DehydratedStageHandoff {
    const logFileName = `stage_${stageId}_raw.log`;
    const rawLogFilePath = path.join(this.runsDir, logFileName);

    // V8 堆内存与超大日志落盘截断保护 (基于 UTF-8 字节长度精确计量)
    const rawStr = typeof rawLogs === "string" ? rawLogs : String(rawLogs ?? "");
    const byteLen = Buffer.byteLength(rawStr, "utf-8");
    let sanitizedLogs = rawStr;
    if (byteLen > MAX_LOG_SIZE_BYTES) {
      const head = rawStr.slice(0, 1024 * 1024);
      const tail = rawStr.slice(-1024 * 1024);
      sanitizedLogs = `${head}\n\n... [TOOLFLOW LOG TRUNCATED: Exceeded 10MB safety cap, original size: ${byteLen} bytes] ...\n\n${tail}`;
    }

    try {
      fs.writeFileSync(rawLogFilePath, sanitizedLogs, "utf-8");
    } catch (_) {}

    // 解析产物中涉及的导入与导出符号拓扑 (跳过二进制文件)
    const importedModules: string[] = [];
    const exportedSymbols: string[] = [];
    for (const art of artifacts) {
      const ext = path.extname(art.path).toLowerCase();
      if (!BINARY_EXTS.has(ext) && fs.existsSync(art.path)) {
        try {
          const content = fs.readFileSync(art.path, "utf-8").slice(0, 32768);
          // 匹配 ES Module 和 CommonJS 导入
          const importMatches = content.matchAll(IMPORT_REGEX);
          for (const m of importMatches) {
            const mod = m[1] || m[2];
            if (mod && !importedModules.includes(mod)) importedModules.push(mod);
          }

          // 匹配各类 export 声明 (function / async function / class / interface / type / enum / const / let)
          const exportMatches = content.matchAll(EXPORT_REGEX);
          for (const m of exportMatches) {
            if (m[1] && !exportedSymbols.includes(m[1])) exportedSymbols.push(m[1]);
          }

          // 匹配 export { a, b, c }
          const namedExportBlock = content.matchAll(NAMED_EXPORT_BLOCK_REGEX);
          for (const block of namedExportBlock) {
            if (block[1]) {
              const names = block[1].split(",").map(n => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
              for (const n of names) {
                if (!exportedSymbols.includes(n)) exportedSymbols.push(n);
              }
            }
          }
        } catch (_) {}
      }
    }

    return {
      stageId,
      stageTitle,
      verifiedArtifacts: artifacts,
      contractSummary,
      rawLogFilePath,
      tokenSavingsRatio: ">95%",
      timestamp: Date.now(),
      topologyHints: (importedModules.length > 0 || exportedSymbols.length > 0)
        ? { importedModules, exportedSymbols }
        : undefined
    };
  }

  /**
   * 格式化为注入下一个 Stage 的紧凑型上下文提示词 (<150 Token)
   */
  public formatHandoffPrompt(handoff: DehydratedStageHandoff): string {
    const artifactList = handoff.verifiedArtifacts.length > 0
      ? handoff.verifiedArtifacts
          .map(a => `  - 产物: \`${a.path}\` (${a.sizeBytes} bytes, SHA: \`${(a.sha256 || "unknown").slice(0, 12)}\`)`)
          .join("\n")
      : "  - 无物理文件";

    const topologyInfo = handoff.topologyHints
      ? `\n[代码拓扑引用] 依赖模块: [${handoff.topologyHints.importedModules?.join(", ") || "无"}], 暴露符号: [${handoff.topologyHints.exportedSymbols?.join(", ") || "无"}]`
      : "";

    return [
      `[上一阶段交付凭证] 阶段: ${handoff.stageTitle} (已物理放行)`,
      `[核心接口与状态] ${handoff.contractSummary}${topologyInfo}`,
      `[已验证物理产物]\n${artifactList}`,
      `[脱水日志归档] 详细调试日志已落盘至: \`${handoff.rawLogFilePath}\` (必要时可通过 read 按需索引)`
    ].join("\n");
  }

  /**
   * ⚡ 终端 ANSI 控制字符清洗与进度条折叠辅助函数
   */
  private sanitizeTerminalOutput(rawText: string): string {
    if (!rawText) return "";
    // 1. 去除 ANSI 转义控制字符，并将 Windows CRLF (\r\n) 统一归一化为 \n
    let text = rawText.replace(ANSI_ESCAPE_REGEX, "").replace(/\r\n/g, "\n");

    // 2. 压缩独立 \r 产生的刷屏进度条（例如 npm install / wget / docker 下载进度）
    // 仅保留由 \r 覆盖的最后一行
    if (text.includes("\r")) {
      const parts = text.split("\n").map(line => {
        if (!line.includes("\r")) return line;
        const sub = line.split("\r").filter(s => s.trim().length > 0);
        return sub.length > 0 ? sub[sub.length - 1] : "";
      });
      text = parts.join("\n");
    }

    return text;
  }

  /**
   * 检查文本是否处于交互式等待中（等待用户输入，此时绝对不可脱水截断）
   */
  private isInteractiveWait(text: string): boolean {
    if (!text) return false;
    const trimmedTail = text.slice(-300).trim();
    return INTERACTIVE_PATTERNS.some(p => p.test(trimmedTail));
  }

  /**
   * 提取输出中的语义峰值报错行 (Semantic Peak Error Extraction)
   * 优先自底向上抓取断言失败、Panic、编译错误等核心高信噪比块，防止被前置警告吞噬
   */
  private extractSemanticPeakErrors(lines: string[]): string[] {
    const PEAK_ERROR_PATTERN = /(?:AssertionError|FAIL:|FAILED|panic:|SyntaxError|TypeError|ReferenceError|error\s+TS\d+|Traceback\s+\(most\s+recent\s+call\s+last\)|Exception\s+in\s+thread|fatal\s+error|Uncaught\s+\w+Error)/i;
    const errorLines: string[] = [];

    for (let i = lines.length - 1; i >= 0; i--) {
      if (PEAK_ERROR_PATTERN.test(lines[i])) {
        const start = Math.max(0, i - 1);
        const end = Math.min(lines.length, i + 3);
        for (let j = start; j < end; j++) {
          if (!errorLines.includes(lines[j])) {
            errorLines.push(lines[j]);
          }
        }
        if (errorLines.length >= 8) break;
      }
    }

    if (errorLines.length === 0) {
      return this.extractKeyErrorLines(lines);
    }

    return errorLines.reverse();
  }

  /**
   * 提取输出中的关键报错行（保证哪怕脱水中段，编译/运行核心错误也不会被吞噬）
   */
  private extractKeyErrorLines(lines: string[]): string[] {
    const errorLines: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (ERROR_LINE_PATTERN.test(lines[i])) {
        // 抓取报错行及其上下文前后各 1 行
        const start = Math.max(0, i - 1);
        const end = Math.min(lines.length, i + 2);
        for (let j = start; j < end; j++) {
          if (!errorLines.includes(lines[j])) {
            errorLines.push(lines[j]);
          }
        }
        if (errorLines.length >= 6) break; // 最多优先抓取 6 行关键报错
      }
    }
    return errorLines;
  }

  /**
   * ⚡ 实时单次工具输出脱水 (Tool Result Dehydration)
   * 当 bash, powershell, fetch_content 或重型 MCP 输出过长时，自动将完整原始输出落盘归档，
   * 仅向下游返回摘要与指纹，彻底阻断数万 Token 垃圾日志污染会话上下文。
   */
  public dehydrateToolOutput(toolName: string, rawText: string, inputCommand?: string): { dehydrated: boolean; text: string; archivePath?: string } {
    if (!rawText || typeof rawText !== "string") return { dehydrated: false, text: rawText };

    // 1. 终端 ANSI 控制字符净化与进度条清洗
    const sanitized = this.sanitizeTerminalOutput(rawText);

    // 2. 交互式等待绝对豁免（如 [y/N], Password: 等），坚决不截断，防止打废终端交互
    if (toolName === "bash" || toolName === "powershell") {
      if (this.isInteractiveWait(sanitized)) {
        return { dehydrated: false, text: sanitized };
      }

      // ⚡ 死循环击碎器 (Loop Buster): 检测 45 秒内无任何文件变动的完全重复命令执行
      if (inputCommand && inputCommand.trim()) {
        const cmd = inputCommand.trim();
        const now = Date.now();
        const outputDigest = crypto.createHash("sha256").update(sanitized).digest("hex").slice(0, 16);
        if (
          this.lastCommandRecord &&
          this.lastCommandRecord.command === cmd &&
          (now - this.lastCommandRecord.timestamp) < 45000 &&
          this.lastCommandRecord.mutationCount === this.workspaceMutationCount &&
          this.lastCommandRecord.outputDigest === outputDigest
        ) {
          const elapsedSec = Math.round((now - this.lastCommandRecord.timestamp) / 1000);
          return {
            dehydrated: true,
            text: `[⚡ ToolFlow Loop Buster: Command "${cmd}" was re-executed within ${elapsedSec}s with zero workspace code changes. Output is identical to previous run. Avoid running repetitive commands without modifying files!]`
          };
        }
        this.lastCommandRecord = {
          command: cmd,
          timestamp: now,
          outputDigest,
          mutationCount: this.workspaceMutationCount
        };
      }
    }

    const lines = sanitized.split("\n");
    
    // ⚡ 针对不同类型的工具设置针对性的智能阈值与截断窗口
    let thresholdLines = 40;
    let thresholdBytes = 2500;
    let headCount = 15;
    let tailCount = 10;

    if (toolName === "grep" || toolName === "find") {
      // 搜索工具：结果超 60 行或 4000 字符才做脱水，保留前 25 条和后 15 条匹配，保证跨文件调用点完整呈现
      thresholdLines = 60;
      thresholdBytes = 4000;
      headCount = 25;
      tailCount = 15;
    } else if (toolName === "read") {
      // 读取工具：正常源码读取绝不拦腰截断；仅当单次超过 600 行且超过 25KB 时做超长归档保护
      thresholdLines = 600;
      thresholdBytes = 25000;
      headCount = 150;
      tailCount = 50;
    } else if (toolName === "bash" || toolName === "powershell") {
      // 终端工具：超 35 行或 2200 字符脱水，保留前 12 行和后 12 行错误/尾部
      thresholdLines = 35;
      thresholdBytes = 2200;
      headCount = 12;
      tailCount = 12;
    } else if (toolName === "fetch_content" || toolName === "web_search" || toolName === "get_search_content") {
      // ⚡ 网络与爬虫工具：网页与搜索内容通常包含大量无用 HTML/脚本/长文，极易撑爆上下文
      thresholdLines = 25;
      thresholdBytes = 1500;
      headCount = 10;
      tailCount = 8;
    } else if (toolName.startsWith("computer_use_") || toolName.startsWith("cua_")) {
      // ⚡ 视觉/桌面自动化工具：UIA 树、Accessibility Tree 和状态诊断返回海量树状节点
      thresholdLines = 30;
      thresholdBytes = 2000;
      headCount = 12;
      tailCount = 8;
    } else if (toolName === "mcp" || toolName === "mcpScript") {
      // ⚡ 重型外部 MCP 工具输出：截断大型 JSON 或对象转储
      thresholdLines = 30;
      thresholdBytes = 2000;
      headCount = 10;
      tailCount = 10;
    }

    if (lines.length <= thresholdLines && sanitized.length < thresholdBytes) {
      return { dehydrated: false, text: sanitized };
    }

    const safeTool = toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `tool_${safeTool}_${Date.now()}.log`;
    const fullPath = path.join(this.runsDir, filename);

    try {
      fs.writeFileSync(fullPath, rawText, "utf-8");
      ContextDehydrator.latestLogPath = fullPath;
      const approxTokens = Math.max(10, Math.round(sanitized.length / 4));
      this.stats.recordSavings(approxTokens, "log");
      if (++this.dehydrateCount % 10 === 0) {
        this.pruneRunLogs(this.runsDir);
      }
    } catch (_) {}

    const relPath = path.relative(process.cwd(), fullPath).replace(/\\/g, "/");
    if (lines.length <= headCount + tailCount) {
      const charHead = sanitized.slice(0, Math.floor(thresholdBytes * 0.5));
      const charTail = sanitized.slice(-Math.floor(thresholdBytes * 0.3));
      const omittedChars = Math.max(0, sanitized.length - (charHead.length + charTail.length));
      return {
        dehydrated: true,
        text: `${charHead}\n\n... [⚡ ToolFlow Token Optimizer: Dehydrated ${omittedChars} chars (~${Math.round(sanitized.length / 4)} tokens) to ${relPath}] ...\n\n${charTail}`,
        archivePath: fullPath
      };
    }

    const clampLine = (l: string) => (l.length > 500 ? l.slice(0, 500) + "... [line clamped]" : l);
    const head = lines.slice(0, headCount).map(clampLine).join("\n");
    const tail = lines.slice(-tailCount).map(clampLine).join("\n");
    const omittedCount = lines.length - (headCount + tailCount);

    // 3. 智能抓取语义峰值 Error 行，避免关键编译/运行报错被粗暴掐死
    const keyErrors = this.extractSemanticPeakErrors(lines.slice(headCount, Math.max(headCount, lines.length - tailCount))).map(clampLine);
    const errorSection = keyErrors.length > 0 
      ? ["", "  [⚡ 核心报错摘要提取]:", ...keyErrors.map(e => "  > " + e), ""]
      : [];

    const summaryText = [
      head,
      ...errorSection,
      "",
      `... [⚡ ToolFlow Token Optimizer: Dehydrated ${omittedCount} lines (~${Math.round(sanitized.length / 4)} tokens) to ${relPath}] [Hint: Call toolflow_inspect(id="${relPath}", offset=1, limit=50) to inspect details without context bloat] ...`,
      "",
      tail
    ].join("\n");

    return {
      dehydrated: true,
      text: summaryText,
      archivePath: fullPath
    };
  }
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

  constructor(cwd: string = process.cwd()) {
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

    // 1. 全量内容 SHA256 哈希计算（Node 22 原生极速哈希，耗时 <0.1ms）
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
        const relativePath = path.relative(process.cwd(), filePath).replace(/\\/g, "/");
        const approxSavedTokens = Math.max(20, Math.round(fileContent.length / 4));

        const notice = [
          `=== [⚡ ToolFlow Read Cache: "${relativePath}" (${lines.length} 行, 与第 ${lastTurn} 轮内容一致, 节约 ~${approxSavedTokens} Tokens) ] ===`,
          `=== [⚡ 提示: 内容完全一致且未变更。若需查看或精准修改实现，请调用 read 传入 offset=<行号> limit=<行数> 按需读取] ===`
        ].join("\n");

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

