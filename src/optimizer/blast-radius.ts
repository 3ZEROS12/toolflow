import * as path from "node:path";
import type { BlueprintStage } from "../core/types.js";
import { isPathInsideWorkspace } from "../core/atomic-fs.js";
export interface ToolCallSecurityEvent {
  toolName: string;
  input?: Record<string, unknown>;
}

export interface SecurityVerificationResult {
  block: boolean;
  reason?: string;
  escalationCandidate?: {
    filePath: string;
    absolutePath: string;
  };
}

const WRITE_TOOLS: Record<string, true> = {
  write: true,
  edit: true,
  create: true,
  delete: true,
  unlink: true,
  replace_file_content: true,
  multi_replace_file_content: true,
  write_to_file: true,
};

const DELETE_TOOLS: Record<string, true> = {
  delete: true,
  unlink: true,
};

const CRITICAL_CONFIG_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/i,
  /^\.git([\\/].+)?$/i,
  /^\.npmrc$/i,
  /^package-lock\.json$/i,
  /^pnpm-lock\.yaml$/i,
  /^yarn\.lock$/i,
  /^Cargo\.lock$/i,
  /^bun\.lockb?$/i,
  /^pnpm-workspace\.yaml$/i,
  /^turbo\.json$/i,
  /^lerna\.json$/i,
  /^nx\.json$/i,
  /^(packag|pnpm-l|pnpm-w|yarn|cargo|turbo|lerna|nx|npmrc|bun)~\d+(\.(jso|yam|loc|txt|rc))?$/i,
  /^git~\d+(\..*)?$/i,
];

const DESTRUCTIVE_BASH_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  {
    pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)*(\/|~|\*|\.\.|\.[\\/]?(\s|$)|\.git)/i,
    reason: "Blocked destructive `rm` targeting root, home, parent, or `.git` directory.",
  },
  {
    pattern: /\b(del|erase)\s+\/[sqf]/i,
    reason: "Blocked recursive or forced Windows delete command.",
  },
  {
    pattern: /\brmdir\s+\/s/i,
    reason: "Blocked recursive Windows directory deletion (`rmdir /s`).",
  },
  {
    pattern: /\bRemove-Item\b.*(-Recurse|-Force)/i,
    reason: "Blocked recursive or forced PowerShell `Remove-Item`.",
  },
  {
    pattern: /\bgit\s+reset\s+--hard\b/i,
    reason: "Blocked `git reset --hard` to prevent accidental loss of uncommitted changes.",
  },
  {
    pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/i,
    reason: "Blocked `git clean -f` to protect untracked files.",
  },
  {
    pattern: /\bgit\s+push\s+.*(--force|-f)\b/i,
    reason: "Blocked force-push (`git push --force`) to protect remote history.",
  },
  {
    pattern: /\bchmod\s+(-R\s+)?777\b/i,
    reason: "Blocked unsafe `chmod 777` permission change.",
  },
  {
    pattern: /\b(mkfs|dd\s+if=|format\s+[a-z]:)\b/i,
    reason: "Blocked low-level disk formatting or raw block-device command.",
  },
];

const MUTATING_SHELL_TOKENS = new Set([
  "rm",
  "mv",
  "cp",
  "truncate",
  "chmod",
  "chown",
  "unlink",
  "del",
  "erase",
  "remove-item",
  "clear-content",
  "set-content",
  "out-file",
  "tee",
  ">",
  ">>",
]);

/**
 * Workspace accident guard: enforces CWD containment, protects `.git`/`.env`/lockfiles,
 * blocks destructive shell patterns, and optionally checks active stage file scope.
 */
export class BlastRadiusGuard {
  private allowedScope: Set<string> = new Set();
  private isScopeEnforced = false;

  public configureStageScope(stage: BlueprintStage | null, additionalTargets: string[] = []): void {
    this.allowedScope.clear();
    if (!stage) {
      this.isScopeEnforced = false;
      return;
    }

    if (stage.expectedArtifact) this.allowedScope.add(this.normalizeRel(stage.expectedArtifact));
    for (const art of stage.expectedArtifacts ?? []) {
      if (art) this.allowedScope.add(this.normalizeRel(art));
    }
    for (const pattern of stage.targetPatterns ?? []) {
      if (pattern) this.allowedScope.add(this.normalizeRel(pattern));
    }
    for (const target of additionalTargets) {
      if (target) this.allowedScope.add(this.normalizeRel(target));
    }

    this.isScopeEnforced = this.allowedScope.size > 0;
  }

  public grantDynamicScope(filePath: string): void {
    this.allowedScope.add(this.normalizeRel(filePath));
  }

  public clearScope(): void {
    this.allowedScope.clear();
    this.isScopeEnforced = false;
  }

  private normalizeRel(p: string): string {
    return p.replace(/\\/g, "/").replace(/^\.\//, "");
  }

  private extractTargetPath(input?: Record<string, unknown>): string | null {
    if (!input) return null;
    for (const key of ["path", "filePath", "TargetFile", "file", "target"]) {
      const val = input[key];
      if (typeof val === "string" && val.length > 0) return val;
    }
    return null;
  }

  private extractBashCommand(input?: Record<string, unknown>): string | null {
    if (!input) return null;
    for (const key of ["command", "cmd", "script"]) {
      const val = input[key];
      if (typeof val === "string" && val.length > 0) return val;
    }
    return null;
  }

  public isCriticalFile(relPath: string): boolean {
    const normalized = this.normalizeRel(relPath);
    const baseName = path.basename(normalized);
    if (normalized.startsWith(".git/") || normalized === ".git") return true;
    return CRITICAL_CONFIG_PATTERNS.some(
      pattern => pattern.test(baseName) || pattern.test(normalized)
    );
  }

  private matchesScope(relPath: string): boolean {
    if (!this.isScopeEnforced) return true;
    const normalized = this.normalizeRel(relPath);
    if (this.allowedScope.has(normalized)) return true;

    for (const pattern of this.allowedScope) {
      if (pattern.endsWith("/*") || pattern.endsWith("/**")) {
        const prefix = pattern.replace(/\/\*+$/, "");
        if (normalized.startsWith(`${prefix}/`) || normalized === prefix) return true;
      } else if (pattern.includes("*")) {
        const regexStr = "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$";
        if (new RegExp(regexStr).test(normalized)) return true;
      }
    }
    return false;
  }

  public verifyToolCall(
    event: ToolCallSecurityEvent,
    cwd: string = process.cwd()
  ): SecurityVerificationResult {
    const tool = (event.toolName || "").toLowerCase();
    const resolvedCwd = path.resolve(cwd);

    if (WRITE_TOOLS[tool]) {
      const targetPath = this.extractTargetPath(event.input);
      if (!targetPath) return { block: false };

      const absoluteTarget = path.isAbsolute(targetPath)
        ? path.resolve(targetPath)
        : path.resolve(resolvedCwd, targetPath);

      const isInsideWorkspace = isPathInsideWorkspace(absoluteTarget, resolvedCwd);
      if (!isInsideWorkspace) {
        return {
          block: true,
          reason: `[ToolFlow Guard] Blocked "${tool}" outside workspace root (${absoluteTarget}).`,
        };
      }

      const relPath = this.normalizeRel(path.relative(resolvedCwd, absoluteTarget));
      if (this.isCriticalFile(relPath)) {
        return {
          block: true,
          reason: `[ToolFlow Guard] Blocked "${tool}" on protected file "${relPath}" (.env, .git, or lockfile).`,
        };
      }

      if (DELETE_TOOLS[tool] && this.isScopeEnforced && !this.matchesScope(relPath)) {
        return {
          block: true,
          reason: `[ToolFlow Guard] Blocked "${tool}" on "${relPath}": outside active stage file scope.`,
        };
      }

      if (this.isScopeEnforced && !this.matchesScope(relPath)) {
        return {
          block: true,
          reason: `[ToolFlow Guard] Scope violation: "${relPath}" is outside active stage targets (${Array.from(this.allowedScope).join(", ")}).`,
          escalationCandidate: {
            filePath: relPath,
            absolutePath: absoluteTarget,
          },
        };
      }

      return { block: false };
    }

    if (tool === "bash" || tool === "run_command" || tool === "powershell") {
      const command = this.extractBashCommand(event.input);
      if (!command) return { block: false };

      for (const rule of DESTRUCTIVE_BASH_PATTERNS) {
        if (rule.pattern.test(command)) {
          return {
            block: true,
            reason: `[ToolFlow Guard] ${rule.reason}`,
          };
        }
      }

      const tokens = command
        .replace(/&&|\|\||;/g, " ; ")
        .split(/\s+/)
        .filter(Boolean);

      let inMutatingCommand = false;
      for (let i = 0; i < tokens.length; i++) {
        const rawTok = tokens[i];
        if (rawTok === ";" || rawTok === "|") {
          inMutatingCommand = false;
          continue;
        }
        const cleaned = rawTok.replace(/^['"`]+|['"`]+$/g, "");
        const lowerTok = cleaned.toLowerCase();

        if (
          MUTATING_SHELL_TOKENS.has(lowerTok) ||
          (lowerTok === "sed" && tokens[i + 1]?.includes("-i"))
        ) {
          inMutatingCommand = true;
          continue;
        }

        if (!inMutatingCommand || cleaned.startsWith("-")) continue;

        const baseName = path.basename(cleaned);
        if (
          this.isCriticalFile(baseName) ||
          cleaned.includes(".git/") ||
          cleaned.includes(".git\\")
        ) {
          return {
            block: true,
            reason: `[ToolFlow Guard] Blocked shell command mutating protected file "${baseName}".`,
          };
        }
      }
    }

    return { block: false };
  }
}
