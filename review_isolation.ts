import { execSync } from "child_process";
import * as path from "path";
import { BlueprintStage } from "./types.js";

export interface ReviewSnapshot {
  baseSha?: string;
  headSha?: string;
  diffSummary: string;
  detailedDiff: string;
  changedFiles: string[];
  hasChanges?: boolean;
}

export interface ReviewIsolationResult {
  isIsolated: boolean;
  isolationMode: "fresh_subagent" | "context_stripped_turn";
  snapshot: ReviewSnapshot;
  isolatedSystemPrompt: string;
  isolatedUserPrompt: string;
}

/**
 * 捕获当前 Git 仓库的物理变更 Diff 快照
 */
export function captureReviewDiffSnapshot(cwd: string = process.cwd()): ReviewSnapshot {
  try {
    // 检查是否在 git 仓库中
    const isGit = execSync("git rev-parse --is-inside-work-tree", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 2000
    }).trim() === "true";

    if (!isGit) {
      return {
        diffSummary: "Non-git directory: unable to extract git diff.",
        detailedDiff: "",
        changedFiles: []
      };
    }

    let headSha = "";
    try {
      headSha = execSync("git rev-parse HEAD", {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
        timeout: 2000
      }).trim();
    } catch {
      // 新仓库可能尚无 HEAD
      headSha = "INITIAL_UNCOMMITTED";
    }

    // 获取变更文件清单 (staged + unstaged + untracked)
    const statusOut = execSync("git status --porcelain", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 3000
    }).trim();

    const changedFiles: string[] = [];
    if (statusOut) {
      const lines = statusOut.split("\n");
      for (const line of lines) {
        const filePart = line.substring(3).trim();
        if (filePart) changedFiles.push(filePart);
      }
    }

    // 获取详细 diff
    let detailedDiff = "";
    try {
      detailedDiff = execSync("git diff HEAD", {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
        timeout: 5000
      });
      if (!detailedDiff.trim()) {
        // 如果没有与 HEAD 的 diff，尝试抓取未暂存 diff
        detailedDiff = execSync("git diff", {
          cwd,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "ignore"],
          timeout: 5000
        });
      }
    } catch {
      detailedDiff = statusOut;
    }

    // 限制 diff 尺寸以防膨胀
    if (detailedDiff.length > 8000) {
      detailedDiff = detailedDiff.substring(0, 8000) + "\n... [Diff truncated to 8000 chars for context hygiene]";
    }

    const summary = `${changedFiles.length} file(s) changed: ${changedFiles.slice(0, 5).join(", ")}${changedFiles.length > 5 ? "..." : ""}`;

    return {
      headSha,
      diffSummary: summary,
      detailedDiff,
      changedFiles,
      hasChanges: changedFiles.length > 0
    };
  } catch (err: any) {
    return {
      diffSummary: `Failed to inspect git diff: ${err?.message || String(err)}`,
      detailedDiff: "",
      changedFiles: [],
      hasChanges: false
    };
  }
}

/**
 * 构建针对 Reviewer 智能体的冷启动隔离上下文与脱水提示词契约。
 * 杜绝承袭 Implementer 的历史推理心智，以客观物理视角审视 Diff 与验收标准。
 */
export function buildColdStartReviewContract(
  stage: BlueprintStage,
  stageIndex: number,
  totalStages: number,
  snapshot: ReviewSnapshot
): ReviewIsolationResult {
  const isolatedSystemPrompt = [
    "=== ZERO-MEMORY INDEPENDENT CODE AUDITOR ===",
    "ROLE: You are an independent, objective software auditor and QA reviewer.",
    "ISOLATION STATUS: Cold start enabled. You have NO prior implementation context or bias.",
    "OBJECTIVE: Objectively verify the git changes against the expected artifacts and quality gates.",
    "GUIDELINES:",
    "1. Base your verdict strictly on actual physical file diffs and command verifications, NOT developer promises.",
    "2. Check for syntax correctness, edge case security, blast radius violations, and test assertions.",
    "3. Be adversarial yet fair. Report concrete bugs or approve if all quality gates pass.",
    "ALLOWED OPERATIONS: Read, inspect files, execute verification commands (bash/powershell)."
  ].join("\n");

  const gateCommands = stage.verificationCommands && stage.verificationCommands.length > 0
    ? `\nVerification Gate: ${stage.verificationCommands.join(" && ")}`
    : "";

  const isolatedUserPrompt = [
    `[Stage ${stageIndex + 1}/${totalStages}: ${stage.title} (Independent Review)]`,
    `Review Target: ${stage.expectedArtifact}`,
    `Core Objective: ${stage.coreObjective}${gateCommands}`,
    `Changes Under Review:\n${snapshot.diffSummary}`,
    snapshot.detailedDiff ? `\n--- DIFF AUDIT PAYLOAD ---\n${snapshot.detailedDiff}\n--- END DIFF ---` : "",
    `\nInstruction: Perform cold-start audit on these changes. Validate correctness and artifact integrity.`
  ].join("\n");

  return {
    isIsolated: true,
    isolationMode: "fresh_subagent",
    snapshot,
    isolatedSystemPrompt,
    isolatedUserPrompt
  };
}

/**
 * 审查阶段运行时工具防线 (Review Isolation Guard)
 * 物理阻断任何修改代码的动作 (write, edit 等)，强制要求审核员保持“只读/只验证”客观状态。
 */
export class ReviewIsolationGuard {
  private active: boolean = false;
  private allowedAuditTools = new Set(["read", "bash", "powershell", "grep", "find", "goal_complete", "goal_blocked", "goal_wait", "mcp"]);

  public activate(): void {
    this.active = true;
  }

  public deactivate(): void {
    this.active = false;
  }

  public isActive(): boolean {
    return this.active;
  }

  public isToolAllowedInReview(toolName: string): boolean {
    if (!this.active) return true;
    return this.allowedAuditTools.has(toolName);
  }
}

