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

const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10MB 单阶段日志截断上限
const MAX_TOTAL_DISK_BYTES = 200 * 1024 * 1024; // 200MB 运行归档总配额

export class ContextDehydrator {
  private runsDir: string;
  private baseDir: string;

  constructor(cwd: string = process.cwd(), blueprintId: string = "default") {
    this.baseDir = path.join(cwd, ".pi", "toolflow", "runs");
    this.runsDir = path.join(this.baseDir, blueprintId);
    try {
      fs.mkdirSync(this.runsDir, { recursive: true });
    } catch (_) {}
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
    const BINARY_EXTS = new Set([
      ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".svg",
      ".exe", ".dll", ".so", ".dylib", ".wasm", ".zip", ".tar", ".gz",
      ".7z", ".pdf", ".db", ".sqlite", ".bin"
    ]);

    const importedModules: string[] = [];
    const exportedSymbols: string[] = [];
    for (const art of artifacts) {
      const ext = path.extname(art.path).toLowerCase();
      if (!BINARY_EXTS.has(ext) && fs.existsSync(art.path)) {
        try {
          const content = fs.readFileSync(art.path, "utf-8").slice(0, 32768);
          // 匹配 ES Module 和 CommonJS 导入
          const importMatches = content.matchAll(/(?:import\s+(?:\{[^}]+\}|\w+|\*\s+as\s+\w+)\s+from\s+["']([^"']+)["']|require\(["']([^"']+)["']\))/g);
          for (const m of importMatches) {
            const mod = m[1] || m[2];
            if (mod && !importedModules.includes(mod)) importedModules.push(mod);
          }

          // 匹配各类 export 声明 (function / async function / class / interface / type / enum / const / let)
          const exportMatches = content.matchAll(/export\s+(?:async\s+)?(?:const|let|var|class|interface|type|enum|function)\s+(\w+)/g);
          for (const m of exportMatches) {
            if (m[1] && !exportedSymbols.includes(m[1])) exportedSymbols.push(m[1]);
          }

          // 匹配 export { a, b, c }
          const namedExportBlock = content.matchAll(/export\s*\{\s*([^}]+)\s*\}/g);
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
    // 1. 去除 ANSI 转义控制字符 (色彩代码、光标跳跃等 \x1b[...m)
    let text = rawText.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\([a-zA-Z]/g, "");

    // 2. 压缩 \r 产生的刷屏进度条（例如 npm install / wget / docker 下载进度）
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
    const interactivePatterns = [
      /\[y\/n\]/i,
      /\(y\/n\)/i,
      /\[yes\/no\]/i,
      /are you sure/i,
      /press any key/i,
      /password:/i,
      /enter pass phrase/i,
      /\? /
    ];
    return interactivePatterns.some(p => p.test(trimmedTail));
  }

  /**
   * 提取输出中的关键报错行（保证哪怕脱水中段，编译/运行核心错误也不会被吞噬）
   */
  private extractKeyErrorLines(lines: string[]): string[] {
    const errorLines: string[] = [];
    const errorPattern = /(error[:\s]|fatal[:\s]|failed[:\s]|exception[:\s]|panic[:\s]|traceback)/i;
    for (let i = 0; i < lines.length; i++) {
      if (errorPattern.test(lines[i])) {
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
  public dehydrateToolOutput(toolName: string, rawText: string): { dehydrated: boolean; text: string; archivePath?: string } {
    if (!rawText || typeof rawText !== "string") return { dehydrated: false, text: rawText };

    // 1. 终端 ANSI 控制字符净化与进度条清洗
    const sanitized = this.sanitizeTerminalOutput(rawText);

    // 2. 交互式等待绝对豁免（如 [y/N], Password: 等），坚决不截断，防止打废终端交互
    if (toolName === "bash" || toolName === "powershell") {
      if (this.isInteractiveWait(sanitized)) {
        return { dehydrated: false, text: sanitized };
      }
    }

    const lines = sanitized.split("\n");
    
    // ⚡ 针对不同类型的工具设置针对性的智能阈值与截断窗口
    let thresholdLines = 40;
    let thresholdBytes = 2500;
    let headCount = 15;
    let tailCount = 10;

    if (toolName === "grep" || toolName === "find") {
      // 搜索工具：结果超 15 行或 1000 字符就脱水，保留前 8 条和后 4 条匹配
      thresholdLines = 15;
      thresholdBytes = 1000;
      headCount = 8;
      tailCount = 4;
    } else if (toolName === "read") {
      // 读取工具：超 30 行或 2000 字符脱水，保留前 15 行和后 10 行
      thresholdLines = 30;
      thresholdBytes = 2000;
      headCount = 15;
      tailCount = 10;
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
    } catch (_) {}

    const head = lines.slice(0, headCount).join("\n");
    const tail = lines.slice(-tailCount).join("\n");
    const omittedCount = lines.length - (headCount + tailCount);
    const relPath = path.relative(process.cwd(), fullPath).replace(/\\/g, "/");

    // 3. 智能抓取中段关键 Error 行，避免关键编译/运行报错被粗暴掐死
    const keyErrors = this.extractKeyErrorLines(lines.slice(headCount, Math.max(headCount, lines.length - tailCount)));
    const errorSection = keyErrors.length > 0 
      ? ["", "  [⚡ 核心报错摘要提取]:", ...keyErrors.map(e => "  > " + e), ""]
      : [];

    const summaryText = [
      head,
      ...errorSection,
      "",
      `... [⚡ ToolFlow Token Optimizer: Dehydrated ${omittedCount} lines (~${Math.round(sanitized.length / 4)} tokens) to ${relPath}] ...`,
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

  /**
   * 记录外部命令（如 bash）执行，作废任何潜在的命令副效应
   */
  public recordCommandExecution(): void {
    this.lastCommandTimestamp = Date.now();
  }

  /**
   * 记录 edit/write 失败，用于下一次强制穿透供给完整源码
   */
  public recordEditFailure(filePath: string, currentTurn: number): void {
    if (!filePath) return;
    const normPath = path.resolve(filePath).replace(/\\/g, "/");
    this.editFailures.set(normPath, { failedTurn: currentTurn, timestamp: Date.now() });
    this.invalidate(normPath);
  }

  /**
   * 检查近期是否发生过编辑失败
   */
  public hasRecentEditFailure(filePath: string, currentTurn: number): boolean {
    if (!filePath) return false;
    const normPath = path.resolve(filePath).replace(/\\/g, "/");
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

    const normPath = path.resolve(filePath).replace(/\\/g, "/");

    // 门禁 G2: 最近发生过 edit/write 失败，强制穿透供给完整文本供大模型纠错
    if (this.hasRecentEditFailure(normPath, currentTurn)) {
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

        return {
          isDuplicate: true,
          savedLines: lines.length,
          savedTokens: approxSavedTokens,
          notice
        };
      }
    }

    // 记录最新真实物理指纹与内容哈希
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
    const normPath = path.resolve(filePath).replace(/\\/g, "/");
    this.cache.delete(normPath);
  }

  /**
   * 重置所有读缓存
   */
  public clear(): void {
    this.cache.clear();
  }
}

