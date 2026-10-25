import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { loadOrRefreshTaxonomy, reflectEnvironmentContext } from "./taxonomy.js";
import { diagnoseTaskRequirements, diagnoseTaskExecutionMode, synthesizeBlueprint, synthesizeBlueprintPlanWithLLM, generateStageActionPrompt } from "./engine.js";
import { EcosystemRadar } from "./deep_ecosystem.js";
import { renderCompactEcosystemOverview, renderBlueprintSummary, openArchitectNavigator, renderValueReceipt, renderExecutionPipelineCard } from "./ui.js";
import { t } from "./i18n.js";
import { ContextDehydrator, StatsManager, getDehydrator, getReadCache, clearAllReadCaches } from "./dehydrator.js";
import { BlastRadiusGuard } from "./blast_radius.js";
import { GracefulDegradationMatrix } from "./degradation_matrix.js";
import { CodebaseMemoryManager } from "./memory.js";
import {
  startBlueprintExecution,
  getSessionState,
  verifyStageArtifacts,
  advanceStage,
  applyToolScoping,
  BASELINE_TOOLS,
  loadPersistedSessionState,
  rollbackStage,
  resetState,
  recordInitialActiveTools,
  restoreInitialActiveTools
} from "./state.js";
import { ReviewIsolationGuard } from "./review_isolation.js";
import { registerToolFlowInspectTool } from "./inspect_tool.js";
import { pruneHeavyProviderTools, slimHistoricalContextMessages } from "./context_slimmer.js";

const CUSTOM_MSG_TYPE = "toolflow:blueprint";
const blastGuard = new BlastRadiusGuard();
const degradationMatrix = new GracefulDegradationMatrix();
const memoryManager = new CodebaseMemoryManager();
let globalTurnCounter = 0;
const reviewGuard = new ReviewIsolationGuard();
let activeWorkspaceCwd = process.cwd();

function updateToolFlowStatusBar(ctx: any): void {
  if (!ctx?.ui?.setStatus) return;
  const state = getSessionState();
  const cwd = ctx?.cwd || activeWorkspaceCwd;
  const stats = new StatsManager(cwd);
  const savings = stats.getFormattedSavings();

  if (!state.currentBlueprint || state.status === "idle" || state.status === "completed") {
    ctx.ui.setStatus("toolflow", stats.getStats().totalTokensSaved > 0 ? savings : undefined);
    return;
  }

  const currentStage = state.currentBlueprint.stages[state.currentStageIndex];
  const stageNum = state.currentStageIndex + 1;
  const totalStages = state.currentBlueprint.stages.length;
  const stageTitle = currentStage?.title || "running";

  ctx.ui.setStatus("toolflow", `⌬ [${stageNum}/${totalStages} · ${stageTitle}] · ${savings}`);
}

export default function (pi: ExtensionAPI) {
  // Silent cross-session blueprint state recovery
  loadPersistedSessionState();

  // Register toolflow_inspect tool
  registerToolFlowInspectTool(pi, () => activeWorkspaceCwd);

  // Register lightweight card renderer
  if (typeof pi.registerMessageRenderer === "function") {
    pi.registerMessageRenderer(CUSTOM_MSG_TYPE, (msg: any, _opts, _theme) => {
      const raw = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content, null, 2);
      return {
        render: (width: number) => {
          const w = width > 0 ? width : 80;
          return raw.split("\n").map((l: string) => truncateToWidth(l, w, "", true));
        },
        invalidate: () => {}
      };
    });
  }

  async function runTaskDecisionPipeline(rawTask: string, taxonomy: any, ctx: ExtensionContext | ExtensionCommandContext, userExplicitMode?: "fast" | "blueprint") {
    if (ctx?.cwd) activeWorkspaceCwd = ctx.cwd;
    if (ctx?.ui?.notify) {
      ctx.ui.notify(t.analyzingTask(rawTask), "info");
    }

    // Fast-Track direct route vs Blueprint pipeline
    const route = diagnoseTaskExecutionMode(rawTask, userExplicitMode);
    if (route.mode === "FAST_TRACK") {
      resetState(activeWorkspaceCwd);
      restoreInitialActiveTools(pi);
      applyToolScoping(BASELINE_TOOLS, pi);

      if (ctx?.ui?.notify) {
        ctx.ui.notify("⚡ Fast-Track enabled (direct execution, 0 stage overhead)", "info");
      }

      if (typeof (pi as any).sendUserMessage === "function") {
        (pi as any).sendUserMessage(
          `⚡ [ToolFlow Fast-Track]\n` +
          `Task: ${rawTask}\n` +
          `Route Rationale: ${route.reason}\n` +
          `Active Tools: @read @edit @write @bash @grep @find\n` +
          `Locate and apply the changes directly, verify, and deliver without multi-stage handoffs.`,
          { deliverAs: "followUp" }
        );
      }
      return;
    }

    const memoryDirective = memoryManager.getPromptContextInjection();
    const promptTask = memoryDirective ? `${rawTask}\n${memoryDirective}` : rawTask;
    const diagnosis = await diagnoseTaskRequirements(promptTask, taxonomy, ctx);
    const slots = diagnosis.requirementSlots || diagnosis.decisionSlots || [];
    let userDecisions: Record<string, string> | null = null;

    // Prefer interactive UI modal if available
    if (ctx?.ui && "custom" in ctx.ui && typeof (ctx.ui as any).custom === "function") {
      try {
        const res = await openArchitectNavigator(ctx.ui, taxonomy, rawTask, slots, diagnosis, ctx);
        if (!res) {
          if (ctx?.ui?.notify) {
            ctx.ui.notify(t.cancelled, "info");
          }
          return;
        }
        if (res.kind === "decisions") {
          userDecisions = res.decisions;
          if (res.customRequirements && res.customRequirements.length > 0) {
            userDecisions.custom_requirements = res.customRequirements.join("; ");
          }
        }
      } catch (err) {
        userDecisions = null;
      }
    }

    // Fallback to basic select in environments without custom UI
    if (!userDecisions && ctx?.ui?.select) {
      const collected: Record<string, string> = {};
      let userCancelled = false;
      for (const slot of slots) {
        const choices = slot.options.map((opt: any) => {
          const optTitle = opt.title || opt.label || opt.id;
          const recPrefix = opt.isRecommended ? "⭐ [推荐] " : "";
          return `${recPrefix}${optTitle} - ${opt.description}`;
        });

        const slotPrompt = slot.question || (slot as any).prompt || "请选择";
        const selectedStr = await ctx.ui.select(`[${slot.title}] ${slotPrompt}`, choices);
        if (!selectedStr) {
          userCancelled = true;
          break;
        }

        const selectedIdx = choices.indexOf(selectedStr);
        const chosen = slot.options[selectedIdx >= 0 ? selectedIdx : 0];
        if (chosen) {
          collected[slot.slotId] = chosen.id || (chosen as any).title || (chosen as any).label;
        }
      }
      if (userCancelled) {
        if (ctx?.ui?.notify) ctx.ui.notify(t.cancelled, "info");
        return;
      }
      userDecisions = Object.keys(collected).length > 0 ? collected : null;
    }

    if (!userDecisions) {
      if (ctx?.ui?.notify) ctx.ui.notify(t.noDecision, "info");
      return;
    }

    // Ecosystem bundle installation proposal
    const ecosystemDecision = userDecisions["slot_ecosystem_expansion"];
    if (ecosystemDecision && ecosystemDecision !== "bundle_scratch") {
      const installedNames = [
        ...(taxonomy.extensions || []).map((e: any) => e.name),
        ...(taxonomy.skills || []).map((s: any) => s.name),
        ...(taxonomy.mcps || []).map((m: any) => m.name)
      ];
      const bundles = await EcosystemRadar.searchEcosystemCatalog(rawTask, installedNames);
      const targetBundle = bundles.find(b => b.id === ecosystemDecision);
      if (targetBundle && targetBundle.packages.length > 0) {
        if (ctx?.ui?.notify) {
          ctx.ui.notify(`Installing ecosystem bundle [${targetBundle.title}]...`, "info");
        }
        const installResult = await EcosystemRadar.installPackagesLocally(targetBundle.packages);
        if (installResult.success) {
          if (ctx?.ui?.notify) {
            ctx.ui.notify(`Ecosystem bundle installed! Reloaded project environment.`, "info");
          }
          taxonomy = await reflectEnvironmentContext(ctx);
        } else {
          if (ctx?.ui?.notify) {
            ctx.ui.notify(`Bundle installation incomplete; falling back to baseline setup.`, "warning");
          }
        }
      }
    }

    const llmArtifactPlan = await synthesizeBlueprintPlanWithLLM(rawTask, diagnosis, userDecisions, taxonomy, ctx);
    const cwd = ctx.cwd || activeWorkspaceCwd;
    const blueprint = synthesizeBlueprint(rawTask, diagnosis, userDecisions, taxonomy, undefined, undefined, llmArtifactPlan);
    recordInitialActiveTools(pi);
    startBlueprintExecution(blueprint, cwd);
    updateToolFlowStatusBar(ctx);

    const firstStage = blueprint.stages[0];
    if (firstStage) {
      if (firstStage.isReviewStage && firstStage.reviewIsolation?.enabled) {
        reviewGuard.activate();
      } else {
        reviewGuard.deactivate();
      }
      blastGuard.updateAllowedScope(firstStage, cwd);
      const pruned = degradationMatrix.resolvePrunedToolsForStage(firstStage.stageId, firstStage.allowedTools);
      applyToolScoping(pruned.allowedTools, pi);
    }

    const summaryMd = renderBlueprintSummary(blueprint);
    if (typeof pi.sendMessage === "function") {
      pi.sendMessage({
        customType: CUSTOM_MSG_TYPE,
        content: summaryMd,
        display: true
      });
    }

    const actionGuidance = generateStageActionPrompt(firstStage, 0, blueprint.stages.length);
    const guidancePrompt = `[Stage 1/${blueprint.stages.length}: ${firstStage.title}]\n` +
      `Target Artifact: ${firstStage.expectedArtifact}\n` +
      `Core Objective: ${firstStage.coreObjective}\n` +
      `Action Guidance: ${actionGuidance} (Run /toolflow rollback anytime to revert stage changes)`;

    if (typeof pi.sendUserMessage === "function") {
      pi.sendUserMessage(guidancePrompt, { deliverAs: "followUp" });
    }
  }

  async function handleBlueprintFlow(args: string, ctx: ExtensionCommandContext) {
    if (ctx?.cwd) activeWorkspaceCwd = ctx.cwd;
    const rawArg = args ? args.trim() : "";
    const cwd = ctx.cwd || activeWorkspaceCwd;

    // 1. Rollback subcommand: /toolflow rollback [stage] or -r
    const lowerArg = rawArg.toLowerCase();
    if (lowerArg === "rollback" || lowerArg === "-r" || lowerArg === "revert" || lowerArg.startsWith("rollback ") || lowerArg.startsWith("-r ")) {
      const tokens = rawArg.split(/\s+/).filter(Boolean);
      let targetStageIndex: number | undefined;
      if (tokens.length > 1) {
        const num = parseInt(tokens[1].replace(/^[sS]/, ""), 10);
        if (!isNaN(num) && num >= 1) {
          targetStageIndex = num - 1;
        }
      }
      const res = rollbackStage(targetStageIndex, cwd);
      reviewGuard.deactivate();
      applyToolScoping(BASELINE_TOOLS, pi);
      if (ctx?.ui?.notify) {
        ctx.ui.notify(res.message, res.success ? "info" : "warning");
      }
      if (res.mentalResetPrompt && ctx) {
        (ctx as any).postSystemMessage?.(res.mentalResetPrompt);
      }
      return;
    }

    // 2. Reset subcommand: /toolflow reset
    if (rawArg === "reset") {
      restoreInitialActiveTools(pi);
      resetState(cwd);
      reviewGuard.deactivate();
      blastGuard.clearAllowedScope();
      ctx?.ui?.setStatus?.("toolflow", undefined);
      if (ctx?.ui?.notify) {
        ctx.ui.notify(t.resetSuccess, "info");
      }
      return;
    }

    // 3. Export subcommand: /toolflow export
    if (rawArg === "export" || rawArg === "-e") {
      const activeState = getSessionState();
      if (!activeState.currentBlueprint) {
        if (ctx?.ui?.notify) {
          ctx.ui.notify(t.exportNoBlueprint, "warning");
        }
        return;
      }
      const summaryMd = renderBlueprintSummary(activeState.currentBlueprint);
      const exportPath = path.join(cwd, "BLUEPRINT.md");
      try {
        fs.writeFileSync(exportPath, summaryMd, "utf-8");
        if (ctx?.ui?.notify) {
          ctx.ui.notify(t.exportSuccess(exportPath), "info");
        }
      } catch (err: any) {
        if (ctx?.ui?.notify) {
          ctx.ui.notify(t.exportFailed(err.message), "error");
        }
      }
      return;
    }

    // 3.5 Token savings report: /toolflow stats
    if (rawArg === "stats" || rawArg === "tokens" || rawArg === "metrics") {
      const statsMgr = new StatsManager(cwd);
      const metrics = statsMgr.getStats();

      const formattedTokens = metrics.totalTokensSaved.toLocaleString();
      const approxKb = Math.round((metrics.totalTokensSaved * 4) / 1024);

      const asciiReport = [
        "+------------------------------------------------------------+",
        "|                TOOLFLOW TOKEN SAVINGS LEDGER               |",
        "+------------------------------------------------------------+",
        `| Verbose Logs Dehydrated : ${String(metrics.dehydratedLogsCount).padStart(6)}x (archived to disk)       |`,
        `| Redundant Reads Cached  : ${String(metrics.readCacheHitsCount).padStart(6)}x (SHA-256 unchanged hit)  |`,
        `| Blast-Radius Blocks     : ${String(metrics.blastRadiusBlocksCount).padStart(6)}x (unsafe writes blocked)  |`,
        "+------------------------------------------------------------+",
        `| Total Context Saved     : ~${formattedTokens.padStart(8)} tokens (~${String(approxKb).padStart(4)} KB)      |`,
        "+------------------------------------------------------------+"
      ].join("\n");

      if (typeof pi.sendMessage === "function") {
        pi.sendMessage({
          customType: CUSTOM_MSG_TYPE,
          content: "```text\n" + asciiReport + "\n```",
          display: true
        });
      } else if (ctx?.ui?.notify) {
        ctx.ui.notify(`ToolFlow saved ~${formattedTokens} tokens`, "info");
      }
      return;
    }

    // 3.6 Latest dehydrated log view: /toolflow logs
    if (rawArg === "logs" || rawArg === "log" || rawArg === "lastlog") {
      const latestPath = ContextDehydrator.getLatestLogPath(cwd);
      if (!latestPath || !fs.existsSync(latestPath)) {
        if (ctx?.ui?.notify) {
          ctx.ui.notify("No dehydrated logs recorded in this session yet.", "info");
        }
        return;
      }

      const relPath = path.relative(cwd, latestPath).replace(/\\/g, "/");
      let content = "";
      try {
        content = fs.readFileSync(latestPath, "utf-8");
      } catch (err: any) {
        content = `Failed to read log: ${err.message}`;
      }

      const lines = content.split("\n");
      const displayLines = lines.length > 150 ? lines.slice(-150).join("\n") : content;
      const headNotice = lines.length > 150
        ? `[Showing last 150 lines; full raw log at: ${relPath}]\n\n`
        : `[Full raw log: ${relPath}]\n\n`;

      if (typeof pi.sendMessage === "function") {
        pi.sendMessage({
          customType: CUSTOM_MSG_TYPE,
          content: `### ⌬ Latest Dehydrated Raw Log (${relPath})\n\`\`\`text\n${headNotice}${displayLines}\n\`\`\``,
          display: true
        });
      } else if (ctx?.ui?.notify) {
        ctx.ui.notify(`Latest dehydrated log: ${relPath}`, "info");
      }
      return;
    }

    // 4. Pipeline status card: /toolflow status
    if (rawArg === "status" || rawArg === "pipeline" || rawArg === "sop") {
      const activeState = getSessionState();
      if (!activeState.currentBlueprint) {
        if (ctx?.ui?.notify) {
          ctx.ui.notify(t.statusNoBlueprint, "warning");
        }
        return;
      }
      const card = renderExecutionPipelineCard({
        blueprintId: activeState.currentBlueprint.blueprintId,
        task: activeState.currentBlueprint.task,
        currentStageIndex: activeState.currentStageIndex,
        stages: activeState.currentBlueprint.stages,
        verifiedArtifactCount: Object.keys(activeState.artifactLedger).length
      });
      if (typeof pi.sendMessage === "function") {
        pi.sendMessage({
          customType: CUSTOM_MSG_TYPE,
          content: card,
          display: true
        });
      }
      return;
    }

    // 5. Check for active blueprint across sessions
    const activeState = getSessionState();
    if (!rawArg && activeState.currentBlueprint && activeState.status === "in_progress") {
      const bp = activeState.currentBlueprint;
      const currentStage = bp.stages[activeState.currentStageIndex];
      const stageNum = `${activeState.currentStageIndex + 1}/${bp.stages.length}`;

      if (ctx?.ui?.select) {
        const choice = await ctx.ui.select(
          `📌 Active blueprint "${bp.task}" (Stage ${stageNum}: ${currentStage?.title}):`,
          [
            `▶ [Resume] Stage ${stageNum}: ${currentStage?.title}`,
            `↺ [Rollback] Revert to Stage ${stageNum} snapshot`,
            `✚ [New Task] Discard active blueprint & start fresh`
          ]
        );

        if (choice?.startsWith("▶")) {
          if (ctx?.ui?.notify) {
            ctx.ui.notify(t.resumedStage(stageNum, currentStage?.title || ""), "info");
          }
          return;
        } else if (choice?.startsWith("↺")) {
          const res = rollbackStage(undefined, cwd);
          if (ctx?.ui?.notify) {
            ctx.ui.notify(res.message, res.success ? "info" : "warning");
          }
          if (res.mentalResetPrompt && ctx) {
            (ctx as any).postSystemMessage?.(res.mentalResetPrompt);
          }
          return;
        } else if (choice?.startsWith("✚")) {
          resetState(cwd);
          blastGuard.clearAllowedScope();
          applyToolScoping(BASELINE_TOOLS, pi);
          if (ctx?.ui?.notify) {
            ctx.ui.notify(t.cleaningOldTask, "info");
          }
        }
      }
    }

    const registeredToolMetas = typeof pi.getAllTools === "function" ? pi.getAllTools() : [];
    const taxonomy = await loadOrRefreshTaxonomy(cwd, registeredToolMetas);

    // Bare `/toolflow`: open navigator or render compact overview
    if (!rawArg) {
      if (ctx?.ui && "custom" in ctx.ui && typeof (ctx.ui as any).custom === "function") {
        const res = await openArchitectNavigator(ctx.ui, taxonomy, "", undefined, undefined, ctx);
        if (res && res.kind === "task_input" && res.task) {
          await runTaskDecisionPipeline(res.task, taxonomy, ctx, (res as any).mode);
          return;
        } else if (res && res.kind === "prompt_invoke" && res.command) {
          if (ctx.ui && "setEditorText" in ctx.ui && typeof (ctx.ui as any).setEditorText === "function") {
            (ctx.ui as any).setEditorText(res.command + " ");
            ctx.ui.notify(t.prefilledPrompt(res.command), "info");
          } else if (typeof pi.sendMessage === "function") {
            pi.sendMessage({
              customType: CUSTOM_MSG_TYPE,
              content: `已为您调出提示词模板: **${res.command}**`,
              display: true
            });
          }
          return;
        }
      } else {
        const overviewMd = renderCompactEcosystemOverview(taxonomy);
        if (typeof pi.sendMessage === "function") {
          pi.sendMessage({
            customType: CUSTOM_MSG_TYPE,
            content: overviewMd,
            display: true
          });
        }
      }
      return;
    }

    await runTaskDecisionPipeline(rawArg, taxonomy, ctx);
  }

  // Register /toolflow main command
  pi.registerCommand("toolflow", {
    description: t.cmdMainDesc,
    getArgumentCompletions: (prefix: string) => {
      const subcommands = [
        { label: "rollback", value: "rollback", description: t.cmdRollbackArgDesc },
        { label: "reset", value: "reset", description: t.cmdResetArgDesc },
        { label: "status", value: "status", description: t.cmdStatusArgDesc },
        { label: "export", value: "export", description: t.cmdExportArgDesc },
        { label: "stats", value: "stats", description: t.cmdStatsArgDesc || "View token savings ledger and metrics" },
        { label: "logs", value: "logs", description: t.cmdLogsArgDesc || "View latest dehydrated raw log snippet" }
      ];
      return subcommands.filter(cmd => cmd.value.startsWith(prefix.trim().toLowerCase()));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await handleBlueprintFlow(args, ctx);
    }
  });

  // Consolidated Pi lifecycle and event listeners
  if (typeof (pi as any).on === "function") {
    // 1. Session start: zero-trace reset and read cache clearing
    (pi as any).on("session_start", async (event: any, ctx: any) => {
      if (ctx?.cwd) activeWorkspaceCwd = ctx.cwd;
      clearAllReadCaches();
      globalTurnCounter = 0;
      updateToolFlowStatusBar(ctx);

      if (event?.reason === "new" || event?.reason === "clear") {
        resetState(ctx?.cwd || activeWorkspaceCwd);
        reviewGuard.deactivate();
        blastGuard.clearAllowedScope();
        applyToolScoping(BASELINE_TOOLS, pi);
        ctx?.ui?.setStatus?.("toolflow", undefined);
      }
    });

    // 2. Compaction suppression: inject artifact directives to prevent code echoing in summaries
    (pi as any).on("session_before_compact", async (event: any) => {
      const state = getSessionState();
      if (!state.currentBlueprint) return;

      const currentStage = state.currentBlueprint.stages[state.currentStageIndex];
      const verifiedFiles = state.currentBlueprint.stages
        .slice(0, state.currentStageIndex + 1)
        .map(s => s.expectedArtifact)
        .filter(Boolean);

      const contractSuppressionPrompt = [
        `[TOOLFLOW STRICT COMPACTION DIRECTIVE]`,
        `Active Blueprint Task: "${state.currentBlueprint.task}" (Stage ${state.currentStageIndex + 1}/${state.currentBlueprint.stages.length}: ${currentStage?.title || "Execution"}).`,
        `Verified Physical Artifacts on Disk: ${verifiedFiles.length > 0 ? verifiedFiles.join(", ") : "None"}.`,
        `MANDATORY COMPRESSION RULE: Do NOT repeat or echo source code, file contents, terminal logs, or past exploratory chatter in the summary. ONLY preserve the current architecture topology, completed physical artifact paths, and active stage next-step objectives. Maximize dehydration ratio.`
      ].join("\n");

      if (event?.customInstructions && typeof event.customInstructions === "string") {
        return {
          customInstructions: `${event.customInstructions}\n\n${contractSuppressionPrompt}`
        };
      }
      return {
        customInstructions: contractSuppressionPrompt
      };
    });

    // 3. Provider request: zero-config auto-pruning of heavy tool schemas when idle
    (pi as any).on("before_provider_request", async (event: any) => {
      pruneHeavyProviderTools(event, () => activeWorkspaceCwd);
    });

    // 4. Agent start: zero idle prompt bloat; concise English directives when active
    (pi as any).on("before_agent_start", async (event: any, ctx: any) => {
      if (ctx?.cwd) activeWorkspaceCwd = ctx.cwd;
      const currentState = getSessionState();

      if (currentState.status !== "in_progress" || !currentState.currentBlueprint) {
        const latestLog = ContextDehydrator.getLatestLogPath(activeWorkspaceCwd);
        if (latestLog && fs.existsSync(latestLog)) {
          return {
            systemPrompt: (event?.systemPrompt || "") + "\n[ToolFlow]: Large tool outputs are archived in .pi/toolflow/runs/; use toolflow_inspect to search or slice full logs.\n"
          };
        }
        return undefined;
      }

      const toolflowGuideline = `\n<toolflow_execution_policy>
  [CORE PRINCIPLES]
  1. Mandatory Reuse: Prefer installed skills, extensions, and CLI tools over ad-hoc scripts.
  2. Production Standards: Deliver robust, modular, and fully tested code with clean interfaces.
  3. Artifact Verification: Ensure required stage artifacts are written and pass gates before advancing.
</toolflow_execution_policy>\n`;

      const currentStage = currentState.currentBlueprint.stages[currentState.currentStageIndex];
      if (currentStage?.skillContract) {
        const contractXml = [
          `\n<enforced_skill_contract skill="${currentStage.skillContract.skillName}">`,
          `  <sop_directives>${currentStage.skillContract.directives.join(" | ")}</sop_directives>`,
          `  <rules>`,
          ...currentStage.skillContract.rules.map((r: string) => `    - ${r}`),
          `  </rules>`,
          `  <checklist>`,
          ...(currentStage.skillContract.checkpoints || []).map((c: string) => `    [ ] ${c}`),
          `  </checklist>`,
          `</enforced_skill_contract>`
        ].join("\n");

        return {
          systemPrompt: (event?.systemPrompt || "") + toolflowGuideline + contractXml
        };
      }

      return {
        systemPrompt: (event?.systemPrompt || "") + toolflowGuideline
      };
    });

    // 5. Tool call: physical blast radius security guard (ALWAYS ACTIVE in ALL sessions)
    (pi as any).on("tool_call", async (event: any, ctx: any) => {
      if (ctx?.cwd) activeWorkspaceCwd = ctx.cwd;
      const cwd = ctx?.cwd || activeWorkspaceCwd;
      const state = getSessionState();

      // Review isolation check: only active during review stages of in-progress blueprints
      if (state.status === "in_progress" && state.currentBlueprint) {
        if (reviewGuard.isActive() && !reviewGuard.isToolAllowedInReview(event.toolName)) {
          return {
            block: true,
            reason: `[ToolFlow Review Isolation] Tool "${event.toolName}" is blocked during read-only review stage.`,
            terminate: false
          };
        }
      }

      // Critical sensitive files and blast radius guard (physically blocked in ALL sessions)
      const check = blastGuard.verifyToolCall(event, cwd);
      if (check.block) {
        new StatsManager(cwd).recordSavings(50, "blast");
        updateToolFlowStatusBar(ctx);
        return {
          block: true,
          reason: check.reason,
          terminate: false
        };
      }
    });

    // 6. Tool result: log dehydration, read cache check, and immediate status bar updates
    (pi as any).on("tool_result", async (event: any, ctx: any) => {
      if (ctx?.cwd) activeWorkspaceCwd = ctx.cwd;
      const cwd = ctx?.cwd || activeWorkspaceCwd;
      globalTurnCounter++;
      if (!event?.content || !Array.isArray(event.content)) return;
      const toolName = event.toolName || "tool";

      const readCache = getReadCache(cwd);
      const dehydrator = getDehydrator(cwd);

      // 1. Invalidate read cache on command execution
      if (toolName === "bash" || toolName === "powershell") {
        readCache.recordCommandExecution();
      }

      // 2. Track mutations and invalidate file read cache on write/edit
      if (toolName === "write" || toolName === "edit" || toolName === "patch" || toolName === "create_file") {
        dehydrator.recordWorkspaceMutation();
        const filePath = event.input?.path;
        const isFailed = event.isError || (Array.isArray(event.content) && event.content.some((b: any) =>
          typeof b?.text === "string" && (
            b.text.includes("Could not find") ||
            b.text.includes("The old text must match") ||
            b.text.includes("Error:") ||
            b.text.includes("failed")
          )
        ));

        if (filePath && isFailed) {
          readCache.recordEditFailure(filePath, globalTurnCounter);
        } else if (filePath) {
          readCache.invalidate(filePath);
        }
      }

      // 3. Read tool: check duplicate read cache with 6-level penetration gate
      if (toolName === "read") {
        const filePath = event.input?.path;
        for (const block of event.content) {
          if (block?.type === "text" && typeof block.text === "string") {
            const cacheResult = readCache.checkOrUpdate(filePath, block.text, globalTurnCounter, event.input);
            if (cacheResult.isDuplicate && cacheResult.notice) {
              const originalLen = block.text.length;
              block.text = cacheResult.notice;
              const approxTokens = Math.max(10, Math.round((originalLen - block.text.length) / 4));
              if (ctx?.ui?.notify) {
                const baseName = path.basename(filePath || "file");
                ctx.ui.notify(t.readCacheHitNotice(baseName, approxTokens), "info");
              }
              updateToolFlowStatusBar(ctx);
              return;
            }
          }
        }
        return;
      }

      // 4. Output dehydration pipeline
      const inputCmd = (event.input?.command || event.input?.cmd || "").toString();
      for (const block of event.content) {
        if (block?.type === "text" && typeof block.text === "string") {
          const originalLen = block.text.length;
          const originalLines = block.text.split("\n").length;
          const res = dehydrator.dehydrateToolOutput(toolName, block.text, inputCmd);
          if (res.dehydrated) {
            block.text = res.text;
            const approxTokens = Math.max(10, Math.round((originalLen - res.text.length) / 4));
            if (ctx?.ui?.notify) {
              ctx.ui.notify(t.toolOutputDehydrated(toolName, originalLines, approxTokens), "info");
            }
            updateToolFlowStatusBar(ctx);
          }
        }
      }
    });

    // 7. Context hook: non-destructive historical sliding window folding
    (pi as any).on("context", async (event: any, ctx?: any) => {
      slimHistoricalContextMessages(event, ctx?.cwd || activeWorkspaceCwd);
    });

    // 8. Turn end: physical artifact verification and self-healing advancement
    (pi as any).on("turn_end", async (_event: any, ctx: ExtensionContext) => {
      try {
        if (ctx?.cwd) activeWorkspaceCwd = ctx.cwd;
        const turnCwd = ctx?.cwd || activeWorkspaceCwd;
        loadPersistedSessionState();
        const state = getSessionState();
        if (state.status !== "in_progress" || !state.currentBlueprint) {
          return;
        }

        const currentStage = state.currentBlueprint.stages[state.currentStageIndex];
        if (!currentStage) return;

        const executedToolNames: string[] = [];
        if (Array.isArray(_event?.toolResults)) {
          for (const tr of _event.toolResults) {
            if (tr?.toolName) executedToolNames.push(tr.toolName);
          }
        }
        if (Array.isArray(_event?.message?.content)) {
          for (const block of _event.message.content) {
            if (block?.type === 'toolCall' && block.name) executedToolNames.push(block.name);
          }
        }
        if (Array.isArray(_event?.toolCalls)) {
          for (const tc of _event.toolCalls) {
            if (tc?.name) executedToolNames.push(tc.name);
          }
        }

        const hasActiveWriting = executedToolNames.some(name => ['write', 'edit'].includes(name));
        const isExploring = executedToolNames.length > 0 && !hasActiveWriting;

        // Deadlock defense: if retryCount >= 3 and artifact not created, suspend without spamming retries
        if ((state.retryCount || 0) >= 3) {
          const quickCheck = verifyStageArtifacts(currentStage, turnCwd, true, true);
          if (!quickCheck.valid) {
            return;
          }
        }

        const verificationResult = verifyStageArtifacts(currentStage, turnCwd, !hasActiveWriting, isExploring);
        if (!verificationResult.valid && (!hasActiveWriting || isExploring)) {
          return;
        }

        if (verificationResult.valid && verificationResult.record) {
          const { record } = verificationResult;
          if (ctx?.ui?.notify) {
            ctx.ui.notify(t.stageVerified(state.currentStageIndex + 1, currentStage.expectedArtifact, record.sha256.slice(0, 12)), "info");
          }

          try {
            const dehydrator = getDehydrator(turnCwd);
            dehydrator.dehydrateStageLog(
              currentStage.stageId,
              currentStage.title,
              `Stage ${state.currentStageIndex + 1} completed with verified artifact: ${currentStage.expectedArtifact}`,
              [record],
              currentStage.artifactContract
            );
            dehydrator.pruneOldRuns();
          } catch (_) {}

          if (ctx && typeof (ctx as any).compact === "function") {
            try {
              (ctx as any).compact({
                customInstructions: `Stage ${state.currentStageIndex + 1} ("${currentStage.title}") completed. Verified artifact: ${currentStage.expectedArtifact}. Dehydrate prior stage logs and preserve only essential architectural decisions and verified artifact fingerprint.`,
                onError: (err: any) => console.warn("[ToolFlow] Stage-wise compact non-fatal:", err?.message)
              });
            } catch (_) {}
          }

          const hasNext = advanceStage(turnCwd);
          updateToolFlowStatusBar(ctx);
          const updatedState = getSessionState();
          if (hasNext && updatedState.currentBlueprint) {
            const nextStage = updatedState.currentBlueprint.stages[updatedState.currentStageIndex];
            if (nextStage) {
              if (nextStage.isReviewStage && nextStage.reviewIsolation?.enabled) {
                reviewGuard.activate();
              } else {
                reviewGuard.deactivate();
              }
              blastGuard.updateAllowedScope(nextStage, turnCwd);
              const pruned = degradationMatrix.resolvePrunedToolsForStage(nextStage.stageId, nextStage.allowedTools);
              applyToolScoping(pruned.allowedTools, pi);

              let previewHint = "";
              if (nextStage.isInteractiveCoCreation) {
                const previewLink = nextStage.previewUrl ? ` | Preview: ${nextStage.previewUrl}` : "";
                const previewCmd = nextStage.previewCommand ? ` | Cmd: ${nextStage.previewCommand}` : "";
                previewHint = `${previewLink}${previewCmd}`;
              }

              const gateCmd = nextStage.verificationCommands && nextStage.verificationCommands.length > 0
                ? `\nGate: ${nextStage.verificationCommands.join(" && ")}`
                : "";

              const actionGuidance = generateStageActionPrompt(
                nextStage,
                updatedState.currentStageIndex,
                updatedState.currentBlueprint.stages.length
              );
              const promptMsg = `[Stage ${updatedState.currentStageIndex + 1}/${updatedState.currentBlueprint.stages.length}: ${nextStage.title}]\n` +
                `Target Artifact: ${nextStage.expectedArtifact}${previewHint}\n` +
                `Core Objective: ${nextStage.coreObjective}${gateCmd}\n` +
                `Action Guidance: ${actionGuidance} (Run /toolflow rollback anytime to revert stage changes)`;

              const pipelineCard = renderExecutionPipelineCard({
                blueprintId: updatedState.currentBlueprint.blueprintId,
                task: updatedState.currentBlueprint.task,
                currentStageIndex: updatedState.currentStageIndex,
                stages: updatedState.currentBlueprint.stages,
                verifiedArtifactCount: Object.keys(updatedState.artifactLedger).length
              });

              if (typeof pi.sendMessage === "function") {
                pi.sendMessage({
                  customType: CUSTOM_MSG_TYPE,
                  content: pipelineCard,
                  display: true
                });
              }

              if (typeof pi.sendUserMessage === "function") {
                pi.sendUserMessage(promptMsg, { deliverAs: "followUp" });
              }
            }
          } else {
            // All stages complete: render receipt, record memory, and compact
            const verifiedFiles = Object.keys(updatedState.artifactLedger);
            memoryManager.recordLesson(
              state.currentBlueprint.task,
              `蓝图 ${state.currentBlueprint.blueprintId} 竣工交付`,
              `交付产物 ${verifiedFiles.join(", ")} 物理校验通过`
            );

            const receiptRows = renderValueReceipt({
              task: state.currentBlueprint.task,
              blueprintId: state.currentBlueprint.blueprintId,
              stageCount: state.currentBlueprint.stages.length,
              verifiedFiles,
              totalDurationSec: Math.round((Date.now() - state.currentBlueprint.createdAt) / 1000),
              tokenSavingsRatio: "68%"
            });

            if (typeof pi.sendMessage === "function") {
              pi.sendMessage({
                customType: CUSTOM_MSG_TYPE,
                content: receiptRows.join("\n"),
                display: true
              });
            }

            restoreInitialActiveTools(pi);
            reviewGuard.deactivate();
            blastGuard.clearAllowedScope();
            if (ctx?.ui?.notify) {
              ctx.ui.notify(t.allCompleted(state.currentBlueprint.task), "info");
            }

            if (ctx && typeof (ctx as any).compact === "function") {
              try {
                (ctx as any).compact({
                  customInstructions: `Blueprint task "${state.currentBlueprint.task}" completed successfully across all stages with verified artifacts: ${verifiedFiles.join(", ")}. Retain this completion state and verified files ledger.`,
                  onComplete: () => {
                    if (ctx?.ui?.notify) {
                      ctx.ui.notify(t.contextDehydrated, "info");
                    }
                  }
                });
              } catch (compactErr: any) {
                console.warn("[ToolFlow] auto-compact triggered but failed safely:", compactErr.message);
              }
            }
          }
        } else {
          // Verification failed: trigger self-healing prompt or circuit breaker
          if (verificationResult.isCircuitBroken) {
            if (ctx?.ui?.notify) {
              ctx.ui.notify(t.circuitBroken(state.currentStageIndex + 1, currentStage.expectedArtifact), "warning");
            }
          } else if (verificationResult.remediationGuidance && typeof pi.sendUserMessage === "function") {
            const retryPrefix = `[SELF-HEALING ${verificationResult.retryCount || 1}/3] `;
            pi.sendUserMessage(`${retryPrefix}${verificationResult.remediationGuidance}`, { deliverAs: "followUp" });
          }
        }
      } catch (err: any) {
        console.error("[ToolFlow turn_end error]", err);
      }
    });
  }
}
