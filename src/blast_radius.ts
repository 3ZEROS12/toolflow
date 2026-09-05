import * as path from "node:path";
import type { BlueprintStage } from "./types.js";

export interface ToolCallSecurityEvent {
  toolName: string;
  input?: Record<string, any>;
}

const WRITE_TOOLS = new Set([
  "write",
  "edit",
  "create",
  "delete",
  "unlink",
  "append",
  "patch",
  "modify",
  "save",
  "overwrite"
]);

export class BlastRadiusGuard {
  private allowedExactPaths: Set<string> = new Set();
  private allowedGlobPatterns: string[] = [];

  private static readonly DOS_DEVICE_REGEX =
    /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CONIN\$|CONOUT\$)(\..*)?$/i;

  private criticalConfigPatterns: RegExp[] = [
    /^\.env(\..+)?$/i,
    /^\.git([\\/].+)?$/i,
    /^package-lock\.json$/i,
    /^pnpm-lock\.yaml$/i,
    /^yarn\.lock$/i,
    /^Cargo\.lock$/i,
    /^pnpm-workspace\.yaml$/i,
    /^turbo\.json$/i,
    /^lerna\.json$/i,
    /^nx\.json$/i,
    // DOS 8.3 short name protection
    /^(packag|pnpm-l|pnpm-w|yarn|cargo|turbo|lerna|nx)~\d+(\.(jso|yam|loc|txt))?$/i,
    /^git~\d+([\\/].+)?$/i,
    /^env~\d+(\..*)?$/i
  ];

  private normalizePath(p: string): string {
    let normalized = path.normalize(p).replace(/\\/g, "/");
    if (process.platform === "win32") {
      normalized = normalized
        .split("/")
        .map(seg => seg.replace(/[.\s]+$/, ""))
        .join("/")
        .toLowerCase();
    }
    return normalized;
  }

  private matchGlob(targetPath: string, globPattern: string): boolean {
    const normTarget = this.normalizePath(targetPath).replace(/^\.\//, "");
    const normPattern = this.normalizePath(globPattern).replace(/^\.\//, "");

    if (normPattern === normTarget || normPattern === "**" || normPattern === "*") {
      return true;
    }

    let regexStr = "";
    let i = 0;
    const p = normPattern;
    while (i < p.length) {
      if (p.slice(i, i + 3) === "**/") {
        regexStr += "(?:.+/)?";
        i += 3;
      } else if (p.slice(i, i + 2) === "**") {
        regexStr += ".*";
        i += 2;
      } else if (p[i] === "*") {
        regexStr += "[^/]*";
        i++;
      } else if (p[i] === "?") {
        regexStr += "[^/]";
        i++;
      } else if (/[.+^${}()|[\]\\]/.test(p[i])) {
        regexStr += "\\" + p[i];
        i++;
      } else {
        regexStr += p[i];
        i++;
      }
    }

    const regex = new RegExp(`^${regexStr}$`, process.platform === "win32" ? "i" : undefined);
    return regex.test(normTarget);
  }

  /**
   * 根据当前 Stage 与蓝图设置动态构建写权限白名单
   */
  public updateAllowedScope(stage: BlueprintStage, cwd: string = process.cwd()) {
    this.allowedExactPaths.clear();
    this.allowedGlobPatterns = [];

    if (stage.expectedArtifact) {
      this.allowedExactPaths.add(this.normalizePath(path.resolve(cwd, stage.expectedArtifact)));
    }
    if (stage.expectedArtifacts) {
      stage.expectedArtifacts.forEach(p => {
        this.allowedExactPaths.add(this.normalizePath(path.resolve(cwd, p)));
      });
    }
    if (stage.targetPatterns) {
      stage.targetPatterns.forEach(p => {
        this.allowedGlobPatterns.push(p);
      });
    }
  }

  /**
   * 清空作用域白名单（在会话重置时恢复无白名单约束状态）
   */
  public clearAllowedScope(): void {
    this.allowedExactPaths.clear();
    this.allowedGlobPatterns = [];
  }

  /**
   * 显式追加白名单路径（如阶段中由自愈推导出的动态文件）
   */
  public allowPath(filePath: string, cwd: string = process.cwd()) {
    this.allowedExactPaths.add(this.normalizePath(path.resolve(cwd, filePath)));
  }

  /**
   * 检查路径是否在工作区根目录范围内 (防止跨盘符 / 越界穿越)
   */
  public isPathWithinWorkspace(targetPath: string, cwd: string = process.cwd()): boolean {
    const resolved = path.resolve(cwd, targetPath);
    const normResolved = this.normalizePath(resolved);
    const normCwd = this.normalizePath(cwd);
    return normResolved === normCwd || normResolved.startsWith(normCwd + "/");
  }

  /**
   * 静态安全校验接口
   */
  public validateFileAccess(targetPath: string, cwd: string = process.cwd()): { allowed: boolean; reason?: string } {
    const check = this.verifyToolCall({ toolName: "write", input: { path: targetPath } }, cwd);
    return { allowed: !check.block, reason: check.reason };
  }

  /**
   * 拦截与审计 tool_call
   */
  public verifyToolCall(
    event: ToolCallSecurityEvent,
    cwd: string = process.cwd()
  ): { block: boolean; reason?: string; escalationCandidate?: { filePath: string; absolutePath: string } } {
    const tool = (event.toolName || "").toLowerCase();
    if (WRITE_TOOLS.has(tool)) {
      const targetPath = event.input?.path;
      if (!targetPath || typeof targetPath !== "string") {
        return { block: false };
      }

      // NTFS Alternate Data Streams 防御 (阻止形如 file.ts::$DATA 的流注入)
      const sanitizedTargetPath = targetPath.replace(/^[a-zA-Z]:/, "");
      if (sanitizedTargetPath.includes(":")) {
        return {
          block: true,
          reason: `[ToolFlow 保护红线] 拦截操作：检测到非法 NTFS 附加数据流路径 "${targetPath}"！`
        };
      }

      const resolved = path.resolve(cwd, targetPath);
      const relative = path.relative(cwd, resolved);
      const normResolved = this.normalizePath(resolved);
      const normRelative = this.normalizePath(relative);
      const normCwd = this.normalizePath(cwd);
      const baseName = path.basename(resolved);
      const cleanBaseName = process.platform === "win32" ? baseName.replace(/[.\s]+$/, "").toLowerCase() : baseName;

      // 0. Windows DOS 保留设备名物理拦截 (CON, PRN, AUX, NUL, COM1-9, LPT1-9, CONIN$, CONOUT$)
      const rawSegments = targetPath.split(/[\\/]/).map(s => s.replace(/[.\s]+$/, ""));
      const pathSegments = normRelative.split("/");
      if (
        BlastRadiusGuard.DOS_DEVICE_REGEX.test(cleanBaseName) ||
        rawSegments.some(s => BlastRadiusGuard.DOS_DEVICE_REGEX.test(s)) ||
        pathSegments.some(s => BlastRadiusGuard.DOS_DEVICE_REGEX.test(s))
      ) {
        return {
          block: true,
          reason: `[ToolFlow 保护红线] 拦截操作：检测到 Windows DOS 保留设备名 "${targetPath}"，禁止访问！`
        };
      }

      // 1. 跨盘符越界与外部驱动器穿越拦截
      const isInsideCwd = normResolved === normCwd || normResolved.startsWith(normCwd + "/");
      if (!isInsideCwd || pathSegments.some(seg => seg === "..") || (path.isAbsolute(relative) && relative !== resolved)) {
        return {
          block: true,
          reason: `[ToolFlow 保护红线] 拦截操作：检测到试图越界访问工作区外部路径 "${targetPath}"！`
        };
      }

      // 2. 核心敏感配置文件与 .git 目录物理级绝对拦截 (无条件优先)
      if (pathSegments.some(seg => seg === ".git" || /^git~\d+$/i.test(seg))) {
        return {
          block: true,
          reason: `[ToolFlow 保护红线] 拦截操作：检测到试图访问或篡改 Git 内部结构/越界路径 "${relative}"！`
        };
      }

      for (const pattern of this.criticalConfigPatterns) {
        if (
          pattern.test(baseName) ||
          pattern.test(cleanBaseName) ||
          pattern.test(normRelative) ||
          pattern.test(relative)
        ) {
          return {
            block: true,
            reason: `[ToolFlow 保护红线] 拦截操作：检测到试图修改核心关键文件 "${baseName}"，该配置处于受保护状态！`
          };
        }
      }

      // 3. 影响面白名单与 Glob 校验 (当白名单非空时生效)
      const hasScopeConfigured = this.allowedExactPaths.size > 0 || this.allowedGlobPatterns.length > 0;
      if (hasScopeConfigured) {
        const isExactMatch = this.allowedExactPaths.has(normResolved);
        const isGlobMatch = this.allowedGlobPatterns.some(pat => {
          return (
            this.matchGlob(relative, pat) ||
            this.matchGlob(targetPath, pat) ||
            this.matchGlob(resolved, pat) ||
            this.matchGlob(normRelative, pat)
          );
        });

        if (!isExactMatch && !isGlobMatch) {
          return {
            block: true,
            reason: `[ToolFlow 影响面拦截] 目标文件 "${relative}" 不在当前阶段的允许修改白名单内。已阻断以防乱改代码。如需修改请更新蓝图。`,
            escalationCandidate: {
              filePath: relative,
              absolutePath: resolved
            }
          };
        }
      }
    }

    // 终端命令逃逸审计 (拦截通过 bash/powershell 直接写入、覆盖或删除绝密配置)
    if (tool === "bash" || tool === "powershell" || tool === "exec") {
      const command = (event.input?.command || event.input?.cmd || "").toString();
      if (command) {
        // 匹配输出重定向（> / >>）、删除指令（rm, del, Remove-Item）或写入流操作
        const isDestructiveOrWrite = /(?:>|>>|\brm\b|\bdel\b|\bRemove-Item\b|\bset-content\b|\bout-file\b)/i.test(command);
        if (isDestructiveOrWrite) {
          for (const pattern of this.criticalConfigPatterns) {
            if (pattern.test(command)) {
              return {
                block: true,
                reason: `[ToolFlow 保护红线] 拦截终端命令：检测到试图通过终端脚本篡改或删除核心敏感文件（匹配受保护目标）！`
              };
            }
          }
        }
      }
      return { block: false };
    }

    return { block: false };
  }
}
