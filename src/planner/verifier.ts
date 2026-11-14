import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type {
  ArtifactRecord,
  BlueprintStage,
  StageVerificationResult,
} from "../core/types.js";
import { isPathInsideWorkspace } from "../core/atomic-fs.js";
import {
  computeFileSha256,
  getGitChangedFiles,
  getWorkspaceStore,
} from "../core/workspace-store.js";
import { getDehydrator } from "../optimizer/dehydrator.js";

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

export function captureReviewSnapshot(cwd: string = process.cwd()): ReviewSnapshot {
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      cwd,
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 2000,
    });

    const headSha = execSync("git rev-parse --short HEAD", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 2000,
    }).trim();

    const diffStat = execSync("git diff --stat HEAD", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 3000,
    }).trim();

    let detailedDiff = execSync("git diff HEAD", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }).trim();

    if (detailedDiff.length > 8000) {
      detailedDiff =
        detailedDiff.slice(0, 8000) +
        "\n\n... [Diff truncated after 8000 chars; inspect targeted files via `read`] ...";
    }

    const nameStatus = execSync("git status --porcelain", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 2000,
    }).trim();

    const changedFiles = nameStatus
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => line.slice(3).trim());

    return {
      headSha,
      diffSummary: diffStat || "(No tracked git diff; inspect untracked/modified files directly)",
      detailedDiff: detailedDiff || "(Clean tracked diff; inspect untracked files if newly created)",
      changedFiles,
      hasChanges: changedFiles.length > 0 || detailedDiff.length > 0,
    };
  } catch {
    return {
      diffSummary: "(Non-git workspace; inspect expected artifact paths directly)",
      detailedDiff: "",
      changedFiles: [],
      hasChanges: false,
    };
  }
}

export function buildReviewIsolationPrompt(
  stage: BlueprintStage,
  taskDescription: string,
  cwd: string = process.cwd(),
  hasSubagentTool: boolean = false
): ReviewIsolationResult {
  const snapshot = captureReviewSnapshot(cwd);
  const isolatedSystemPrompt = [
    "You are an independent read-only verification auditor.",
    "Review the implementation objectively against the acceptance contract and diff.",
    "Do not edit files during a review stage; report exact file paths, line numbers, and failed assertions.",
  ].join("\n");

  const isolatedUserPrompt = [
    `# Isolated Review: ${stage.title}`,
    `Task: ${taskDescription}`,
    `Acceptance Contract: ${stage.artifactContract}`,
    `Changed Files: ${snapshot.changedFiles.length > 0 ? snapshot.changedFiles.join(", ") : "(none detected via git)"}`,
    "## Git Diff Summary",
    snapshot.diffSummary,
    snapshot.detailedDiff ? `## Detailed Diff\n\`\`\`diff\n${snapshot.detailedDiff}\n\`\`\`` : "",
    "Verify tests, build invariants, and edge cases cleanly.",
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    isIsolated: true,
    isolationMode: hasSubagentTool ? "fresh_subagent" : "context_stripped_turn",
    snapshot,
    isolatedSystemPrompt,
    isolatedUserPrompt,
  };
}

const REVIEW_FORBIDDEN_TOOLS: Record<string, true> = {
  write: true,
  edit: true,
  create: true,
  delete: true,
  unlink: true,
  replace_file_content: true,
  multi_replace_file_content: true,
  write_to_file: true,
};

/**
 * Blocks file-mutating tool calls during read-only review stages.
 */
export class ReviewIsolationGuard {
  private active = false;

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
    return !REVIEW_FORBIDDEN_TOOLS[(toolName || "").toLowerCase()];
  }
}

function getArtifactPaths(stage: BlueprintStage): string[] {
  const paths: string[] = [];
  if (stage.expectedArtifact) paths.push(stage.expectedArtifact);
  for (const extra of stage.expectedArtifacts ?? []) {
    if (extra && !paths.includes(extra)) paths.push(extra);
  }
  return paths;
}

/**
 * Verifies stage artifacts on disk, executes verification commands, records SHA-256 ledger entries,
 * and drives the 3-attempt remediation circuit breaker.
 */
export function verifyStageArtifacts(
  stage: BlueprintStage,
  cwd: string = process.cwd(),
  rawStageOutput: string = ""
): StageVerificationResult {
  const store = getWorkspaceStore(cwd);
  const currentState = store.getState();
  const artifactPaths = getArtifactPaths(stage);
  const primaryRelPath = artifactPaths[0] || "";
  const resolvedCwd = path.resolve(cwd);

  const missingArtifacts: string[] = [];
  const verifiedRecords: ArtifactRecord[] = [];
  const gitInfo = getGitChangedFiles(cwd);

  for (const relPath of artifactPaths) {
    const fullPath = path.resolve(resolvedCwd, relPath);
    if (!isPathInsideWorkspace(fullPath, resolvedCwd)) {
      missingArtifacts.push(relPath);
      continue;
    }
    if (!fs.existsSync(fullPath)) {
      missingArtifacts.push(relPath);
      continue;
    }
    try {
      const stat = fs.statSync(fullPath);
      const sha256 = stat.isFile() ? computeFileSha256(fullPath) : "dir";
      const gitStatus: ArtifactRecord["gitStatus"] = gitInfo.untrackedFiles.includes(relPath)
        ? "untracked"
        : gitInfo.changedFiles.includes(relPath)
          ? "modified"
          : "unmodified";

      const record: ArtifactRecord = {
        path: relPath,
        sha256,
        sizeBytes: stat.size,
        verifiedAt: Date.now(),
        gitStatus,
      };
      verifiedRecords.push(record);
      store.recordArtifact(relPath, record);
    } catch {
      missingArtifacts.push(relPath);
    }
  }

  if (missingArtifacts.length > 0) {
    const nextRetry = store.incrementRetry();
    const isCircuitBroken = nextRetry >= 3;
    const missingStr = missingArtifacts.join(", ");
    return {
      valid: false,
      artifactPath: primaryRelPath,
      isPrimaryMissing: missingArtifacts.includes(primaryRelPath),
      missingExpected: missingStr,
      retryCount: nextRetry,
      healingAttempt: nextRetry,
      isCircuitBroken,
      reason: `Expected artifact(s) missing on disk: ${missingStr}`,
      remediationGuidance:
        `[ToolFlow Stage Gate Failed (${nextRetry}/3)] Missing expected artifact(s): ${missingStr}. ` +
        `Create or update the required files before completing "${stage.title}".`,
    };
  }

  // Zero-change check: if git is clean and no artifact changed since stage snapshot, still check if files were just created or commands pass
  const currentSnapshot = currentState.snapshots?.[currentState.currentStageIndex];
  const anyFileModifiedSinceSnapshot = verifiedRecords.some(rec => {
    const prevHash = currentSnapshot?.fileHashes?.[rec.path];
    return prevHash === undefined || prevHash !== rec.sha256;
  });

  if (stage.verificationCommands && stage.verificationCommands.length > 0) {
    for (const cmd of stage.verificationCommands) {
      try {
        execSync(cmd, {
          cwd,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 60000,
        });
      } catch (err: unknown) {
        const nextRetry = store.incrementRetry();
        const isCircuitBroken = nextRetry >= 3;
        const stderr =
          err && typeof err === "object" && "stderr" in err && typeof err.stderr === "string"
            ? err.stderr
            : err instanceof Error
              ? err.message
              : String(err);
        const stdout =
          err && typeof err === "object" && "stdout" in err && typeof err.stdout === "string"
            ? err.stdout
            : "";
        const combinedErr = `${stdout}\n${stderr}`.trim().slice(-1200);
        const exitCode =
          err && typeof err === "object" && "status" in err && typeof err.status === "number"
            ? err.status
            : 1;

        return {
          valid: false,
          artifactPath: primaryRelPath,
          record: verifiedRecords[0],
          verificationCommands: stage.verificationCommands,
          exitCode,
          stderrOutput: combinedErr,
          retryCount: nextRetry,
          healingAttempt: nextRetry,
          isCircuitBroken,
          reason: `Verification command failed (${cmd}) with exit code ${exitCode}`,
          remediationGuidance:
            `[ToolFlow Verification Failed (${nextRetry}/3)] Command \`${cmd}\` exited with ${exitCode}.\n` +
            `Output excerpt:\n${combinedErr}\nFix the failing check and re-verify.`,
        };
      }
    }
  } else if (
    !anyFileModifiedSinceSnapshot &&
    gitInfo.isGit &&
    gitInfo.changedFiles.length === 0 &&
    gitInfo.untrackedFiles.length === 0 &&
    !stage.isReviewStage &&
    rawStageOutput.length > 0
  ) {
    return {
      valid: false,
      artifactPath: primaryRelPath,
      isExploring: true,
      reason: "Turn ended with exploration only and no file updates yet.",
      remediationGuidance: `Continue implementing "${stage.title}" until ${primaryRelPath} reflects the required changes.`,
    };
  }

  store.resetRetry();

  if (rawStageOutput) {
    getDehydrator(cwd).dehydrateStageLog({
      stageId: stage.stageId,
      stageTitle: stage.title,
      rawStageOutput,
      verifiedArtifacts: verifiedRecords,
      contractSummary: stage.artifactContract,
    });
  }

  return {
    valid: true,
    artifactPath: primaryRelPath,
    record: verifiedRecords[0],
    changedFiles: [...gitInfo.changedFiles, ...gitInfo.untrackedFiles],
  };
}
