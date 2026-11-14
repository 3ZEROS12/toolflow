import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { t } from "../core/messages.js";
import { getWorkspaceStore, type ToolRegistryHost } from "../core/workspace-store.js";
import { BlastRadiusGuard } from "../optimizer/blast-radius.js";
import { getReadCache } from "../optimizer/read-cache.js";
import { getDehydrator } from "../optimizer/dehydrator.js";
import { slimHistoricalContextMessages, type ContextSlimmingEvent } from "../optimizer/context-slimmer.js";
import { getStatsManager } from "../optimizer/stats.js";
import { getCodebaseMemory } from "../planner/memory.js";
import { generateStageActionPrompt } from "../planner/synthesizer.js";
import {
  buildReviewIsolationPrompt,
  ReviewIsolationGuard,
  verifyStageArtifacts,
} from "../planner/verifier.js";
import { renderExecutionPipelineCard, renderValueReceipt } from "../ui/cards.js";
import { updateToolFlowStatusBar } from "./commands.js";

const TOOL_HOST_KEYS = ["setActiveTools", "getAllTools", "getActiveTools"] as const;

/**
 * Pi exposes tool registry control both on the extension API and on some contexts;
 * prefer the context when it can actually mutate the active tool set.
 */
function resolveToolHost(pi: ExtensionAPI, ctx: ExtensionContext): ToolRegistryHost {
  const candidate = ctx as unknown as Partial<ToolRegistryHost>;
  if (TOOL_HOST_KEYS.some(key => typeof candidate?.[key] === "function")) {
    return candidate as ToolRegistryHost;
  }
  return pi;
}

function extractToolText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === "object" && "type" in item && "text" in item) {
      const block = item as { type?: unknown; text?: unknown };
      if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
  }
  return parts.join("\n");
}

export function registerToolFlowHooks(
  pi: ExtensionAPI,
  getActiveCwd: () => string,
  setActiveCwd: (cwd: string) => void
): void {
  const blastGuard = new BlastRadiusGuard();
  const reviewGuard = new ReviewIsolationGuard();

  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd || getActiveCwd();
    setActiveCwd(cwd);
    const toolHost = resolveToolHost(pi, ctx);

    const store = getWorkspaceStore(cwd);
    store.load();
    store.recordInitialActiveTools(toolHost);

    const state = store.getState();
    const activeStage =
      state.status === "in_progress" && state.currentBlueprint
        ? state.currentBlueprint.stages[state.currentStageIndex]
        : undefined;

    if (activeStage) {
      store.applyToolScoping(activeStage.allowedTools, toolHost);
      blastGuard.configureStageScope(activeStage, state.dynamicTargetFiles ?? []);
      if (activeStage.isReviewStage) reviewGuard.activate();
      else reviewGuard.deactivate();
    } else {
      blastGuard.clearScope();
      reviewGuard.deactivate();
    }

    updateToolFlowStatusBar(ctx, state, cwd);
  });

  pi.on("context", async (event, ctx) => {
    const cwd = ctx.cwd || getActiveCwd();
    setActiveCwd(cwd);
    const tokensReclaimed = slimHistoricalContextMessages(
      event as unknown as ContextSlimmingEvent,
      cwd
    );

    // Pi owns tool declarations here (the `context` event carries messages only), so the
    // stage allowlist is already enforced through setActiveTools. Report the reclaim once:
    // folded blocks are short, so the next pass reclaims 0 and stays silent.
    if (tokensReclaimed > 0) {
      updateToolFlowStatusBar(ctx, getWorkspaceStore(cwd).getState(), cwd);
      ctx.ui?.notify?.(t.compactNotice(tokensReclaimed), "info");
    }

    return { messages: event.messages };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const cwd = ctx.cwd || getActiveCwd();
    setActiveCwd(cwd);
    const store = getWorkspaceStore(cwd);
    const state = store.getState();

    const keywords =
      state.currentBlueprint && state.currentBlueprint.task
        ? state.currentBlueprint.task.split(/\s+/).slice(0, 6)
        : [];
    const memoryPrompt = getCodebaseMemory(cwd).getRelevantLessonsPrompt(keywords);

    const activeStage =
      state.status === "in_progress" && state.currentBlueprint
        ? state.currentBlueprint.stages[state.currentStageIndex]
        : undefined;

    if (!activeStage || !state.currentBlueprint) {
      return memoryPrompt ? { systemPrompt: `${event.systemPrompt}\n\n${memoryPrompt}` } : undefined;
    }

    store.applyToolScoping(activeStage.allowedTools, resolveToolHost(pi, ctx));
    blastGuard.configureStageScope(activeStage, state.dynamicTargetFiles ?? []);

    if (activeStage.isReviewStage) {
      reviewGuard.activate();
      const isolation = buildReviewIsolationPrompt(
        activeStage,
        state.currentBlueprint.task,
        cwd,
        false
      );
      return {
        systemPrompt: [event.systemPrompt, isolation.isolatedSystemPrompt, memoryPrompt]
          .filter(Boolean)
          .join("\n\n"),
      };
    }

    reviewGuard.deactivate();
    const pipelineCard = renderExecutionPipelineCard({
      blueprintId: state.currentBlueprint.blueprintId,
      task: state.currentBlueprint.task,
      currentStageIndex: state.currentStageIndex,
      stages: state.currentBlueprint.stages,
      verifiedArtifactCount: Object.keys(state.artifactLedger).length,
    });

    return {
      systemPrompt: [event.systemPrompt, pipelineCard, memoryPrompt].filter(Boolean).join("\n\n"),
    };
  });

  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    const cwd = ctx.cwd || getActiveCwd();
    setActiveCwd(cwd);
    const store = getWorkspaceStore(cwd);
    const state = store.getState();
    const input = event.input as Record<string, unknown>;

    if (state.status === "in_progress" && state.currentBlueprint) {
      if (reviewGuard.isActive() && !reviewGuard.isToolAllowedInReview(event.toolName)) {
        return {
          block: true,
          reason: `[ToolFlow Review Isolation] Blocked "${event.toolName}" during read-only review stage.`,
        };
      }
    }

    const securityResult = blastGuard.verifyToolCall({ toolName: event.toolName, input }, cwd);

    if (securityResult.block) {
      const escalation = securityResult.escalationCandidate;
      if (escalation && state.status === "in_progress" && ctx.ui?.confirm) {
        const allow = await ctx.ui.confirm(
          "ToolFlow Scope Check",
          `Allow "${event.toolName}" to write "${escalation.filePath}" outside current stage scope?`
        );
        if (allow) {
          blastGuard.grantDynamicScope(escalation.filePath);
          return undefined;
        }
      }

      getStatsManager(cwd).recordSavings({ blastRadiusBlocks: 1 });
      return { block: true, reason: securityResult.reason };
    }

    if (event.toolName === "read" && typeof input.path === "string") {
      const check = getReadCache(cwd).checkRead(
        {
          path: input.path,
          offset: typeof input.offset === "number" ? input.offset : undefined,
          limit: typeof input.limit === "number" ? input.limit : undefined,
        },
        false
      );
      if (check.isDuplicate && check.notice) {
        updateToolFlowStatusBar(ctx, state, cwd);
        return { block: true, reason: check.notice };
      }
    }

    return undefined;
  });

  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    const cwd = ctx.cwd || getActiveCwd();
    const input = event.input;
    const targetPath = typeof input.path === "string" ? input.path : undefined;
    const readCache = getReadCache(cwd);

    if (targetPath) {
      if (event.toolName === "read" && !event.isError) {
        readCache.recordRead({
          path: targetPath,
          offset: typeof input.offset === "number" ? input.offset : undefined,
          limit: typeof input.limit === "number" ? input.limit : undefined,
        });
      } else if (event.toolName === "write" || event.toolName === "edit") {
        if (event.isError) readCache.markEditFailure(targetPath);
        else readCache.markFileDirty(targetPath);
      }
    }

    if (event.toolName === "bash" || event.toolName === "powershell") {
      readCache.markWorkspaceDirtyByCommand();
    }

    if (
      event.toolName === "bash" ||
      event.toolName === "powershell" ||
      event.toolName === "grep" ||
      event.toolName === "find" ||
      event.toolName === "ls"
    ) {
      const store = getWorkspaceStore(cwd);
      const state = store.getState();
      const stageId =
        state.currentBlueprint?.stages[state.currentStageIndex]?.stageId ?? "default";

      const dehydrated = getDehydrator(cwd).dehydrateToolOutput(
        event.toolName,
        extractToolText(event.content),
        event.isError,
        stageId
      );

      if (dehydrated.dehydrated) {
        updateToolFlowStatusBar(ctx, state, cwd);
        if (ctx.ui?.notify && dehydrated.tokensSaved > 0) {
          ctx.ui.notify(
            t.toolOutputDehydrated(event.toolName, dehydrated.originalLines, dehydrated.tokensSaved),
            "info"
          );
        }
        return { content: [{ type: "text", text: dehydrated.text }] };
      }
    }

    return undefined;
  });

  pi.on("turn_end", async (event: TurnEndEvent, ctx) => {
    const cwd = ctx.cwd || getActiveCwd();
    const store = getWorkspaceStore(cwd);
    store.load();
    const state = store.getState();

    if (state.status !== "in_progress" || !state.currentBlueprint) {
      updateToolFlowStatusBar(ctx, state, cwd);
      return;
    }

    if (Array.isArray(event.toolResults) && event.toolResults.length > 0) {
      updateToolFlowStatusBar(ctx, state, cwd);
      return;
    }

    const activeStage = state.currentBlueprint.stages[state.currentStageIndex];
    if (!activeStage) return;

    const message = event.message;
    const rawOutput = message && "content" in message ? extractToolText(message.content) : "";
    const verification = verifyStageArtifacts(activeStage, cwd, rawOutput);

    if (verification.valid) {
      if (ctx.ui?.notify && verification.record) {
        ctx.ui.notify(
          t.stageVerified(
            state.currentStageIndex + 1,
            verification.artifactPath,
            verification.record.sha256.slice(0, 8)
          ),
          "info"
        );
      }

      const hasMoreStages = store.advanceStage();
      const nextState = store.getState();

      if (hasMoreStages && nextState.currentBlueprint) {
        const nextStage = nextState.currentBlueprint.stages[nextState.currentStageIndex];
        if (nextStage) {
          store.applyToolScoping(nextStage.allowedTools, resolveToolHost(pi, ctx));
          blastGuard.configureStageScope(nextStage, nextState.dynamicTargetFiles ?? []);
          if (nextStage.isReviewStage) reviewGuard.activate();
          else reviewGuard.deactivate();

          updateToolFlowStatusBar(ctx, nextState, cwd);
          pi.sendUserMessage(
            generateStageActionPrompt(nextStage, nextState.currentBlueprint, nextState.currentStageIndex),
            { deliverAs: "followUp" }
          );
        }
        return;
      }

      if (nextState.currentBlueprint) {
        store.restoreInitialActiveTools(resolveToolHost(pi, ctx));
        blastGuard.clearScope();
        reviewGuard.deactivate();
        updateToolFlowStatusBar(ctx, nextState, cwd);

        const summary = getStatsManager(cwd).getSavingsSummary();
        const durationSec = Math.max(
          1,
          Math.round((Date.now() - nextState.currentBlueprint.createdAt) / 1000)
        );
        const receipt = renderValueReceipt({
          task: nextState.currentBlueprint.task,
          blueprintId: nextState.currentBlueprint.blueprintId,
          stageCount: nextState.currentBlueprint.stages.length,
          verifiedFiles: Object.keys(nextState.artifactLedger),
          totalDurationSec: durationSec,
          tokenSavingsRatio: `${summary.estimatedRatioPercent}%`,
        });

        getCodebaseMemory(cwd).recordLesson(
          nextState.currentBlueprint.task.slice(0, 60),
          `Completed ${nextState.currentBlueprint.stages.length}-stage workflow cleanly.`,
          `Verified artifacts: ${Object.keys(nextState.artifactLedger).slice(0, 3).join(", ")}`,
          ["workflow", nextState.currentBlueprint.projectFingerprint?.projectType ?? "general"]
        );

        ctx.ui?.notify?.(
          `${t.allCompleted(nextState.currentBlueprint.task)}\n\n${receipt.join("\n")}`,
          "info"
        );
      }
      return;
    }

    if (verification.isExploring) {
      pi.sendUserMessage(verification.remediationGuidance || "Continue executing the current stage.", {
        deliverAs: "followUp",
      });
      return;
    }

    if (verification.isCircuitBroken) {
      blastGuard.clearScope();
      reviewGuard.deactivate();
      updateToolFlowStatusBar(ctx, store.getState(), cwd);
      ctx.ui?.notify?.(
        t.circuitBroken(state.currentStageIndex + 1, verification.artifactPath),
        "error"
      );
      return;
    }

    if (verification.remediationGuidance) {
      pi.sendUserMessage(verification.remediationGuidance, { deliverAs: "followUp" });
    }
  });
}
