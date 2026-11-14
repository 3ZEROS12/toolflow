import * as fs from "node:fs";
import * as path from "node:path";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { t } from "../core/messages.js";
import { getWorkspaceStore, type ToolRegistryHost } from "../core/workspace-store.js";
import type { EcosystemTaxonomy, SessionPlanState } from "../core/types.js";
import { clearAllStatsManagers, getStatsManager } from "../optimizer/stats.js";
import { clearAllReadCaches } from "../optimizer/read-cache.js";
import { ContextDehydrator } from "../optimizer/dehydrator.js";
import { reflectEnvironmentContext, type LlmModelRuntime } from "../planner/taxonomy.js";
import { EcosystemRadar } from "../planner/deep-ecosystem.js";
import { diagnoseTaskExecutionMode, diagnoseTaskRequirements } from "../planner/router.js";
import {
  generateStageActionPrompt,
  synthesizeBlueprint,
  synthesizeBlueprintPlanWithLLM,
} from "../planner/synthesizer.js";
import { renderBlueprintSummary, renderCompactEcosystemOverview, renderSavingsLedger } from "../ui/cards.js";
import { openArchitectNavigator, type CustomUiHost } from "../ui/navigator.js";

const TOOL_HOST_KEYS = ["setActiveTools", "getAllTools", "getActiveTools"] as const;

function resolveToolHost(
  pi: ExtensionAPI,
  ctx: ExtensionContext | ExtensionCommandContext
): ToolRegistryHost {
  const candidate = ctx as unknown as Partial<ToolRegistryHost>;
  if (TOOL_HOST_KEYS.some(key => typeof candidate?.[key] === "function")) {
    return candidate as ToolRegistryHost;
  }
  return pi;
}

/** The command context doubles as the LLM host for blueprint synthesis calls. */
function asLlmHost(ctx: ExtensionContext | ExtensionCommandContext): LlmModelRuntime {
  return ctx as unknown as LlmModelRuntime;
}

function asCustomUiHost(ctx: ExtensionContext | ExtensionCommandContext): CustomUiHost | null {
  const ui = ctx.ui as unknown as Partial<CustomUiHost> | undefined;
  return ui && typeof ui.custom === "function" ? (ui as CustomUiHost) : null;
}

/**
 * Stage titles are user/LLM text and follow the user's language, so a CJK title of 30 code
 * points is ~60 columns and wrapped the footer. Clamp by display columns instead.
 */
function clampLabel(text: string, maxColumns = 30): string {
  return truncateToWidth(text, maxColumns, "…");
}

export function updateToolFlowStatusBar(
  ctx: Pick<ExtensionContext, "ui"> | undefined,
  state: Readonly<SessionPlanState>,
  cwd?: string
): void {
  const ui = ctx?.ui;
  if (!ui || typeof ui.setStatus !== "function") return;

  // Pi prefixes the badge with its own key (`toolflow: …`), so the value never repeats
  // the product name — that keeps the badge short enough to survive narrow panes.
  const savings = getStatsManager(cwd).getCompactBadge();

  if (state.status === "in_progress" && state.currentBlueprint) {
    const idx = state.currentStageIndex + 1;
    const total = state.currentBlueprint.stages.length;
    const stage = state.currentBlueprint.stages[state.currentStageIndex];
    const label = clampLabel(stage ? stage.title : "Running");
    ui.setStatus("toolflow", `[${idx}/${total}] ${label} · ${savings}`);
    return;
  }

  if (state.status === "completed" && state.currentBlueprint) {
    ui.setStatus("toolflow", `✓ Completed · ${savings}`);
    return;
  }

  if (state.status === "healing_failed_circuit_break") {
    ui.setStatus("toolflow", `▲ Paused · rollback · ${savings}`);
    return;
  }

  ui.setStatus("toolflow", savings);
}

/** Ledger card shared by `/toolflow stats` and `/toolflow dashboard`. */
export function renderStatsLedger(cwd?: string): string {
  const manager = getStatsManager(cwd);
  const summary = manager.getSavingsSummary();
  return renderSavingsLedger({
    stats: summary.stats,
    estimatedRatioPercent: summary.estimatedRatioPercent,
    ledgerPath: manager.getLedgerPath(),
  });
}

export function registerToolFlowCommand(
  pi: ExtensionAPI,
  getActiveCwd: () => string,
  setActiveCwd: (cwd: string) => void
): void {
  if (typeof pi.registerCommand !== "function") return;

  async function runTaskDecisionPipeline(
    rawTask: string,
    taxonomy: EcosystemTaxonomy,
    ctx: ExtensionContext | ExtensionCommandContext,
    userExplicitMode?: "fast" | "blueprint"
  ): Promise<void> {
    const cwd = ctx.cwd || getActiveCwd();
    setActiveCwd(cwd);
    const store = getWorkspaceStore(cwd);
    const toolHost = resolveToolHost(pi, ctx);

    ctx.ui?.notify?.(t.analyzingTask(rawTask), "info");

    const routeDecision = diagnoseTaskExecutionMode(
      rawTask,
      taxonomy.projectFingerprint,
      userExplicitMode
    );

    if (routeDecision.mode === "fast") {
      const llmPlan = await synthesizeBlueprintPlanWithLLM(rawTask, taxonomy, asLlmHost(ctx), cwd);
      const fastDiagnosis = await diagnoseTaskRequirements(rawTask, taxonomy, asLlmHost(ctx), undefined, cwd);
      const blueprint = synthesizeBlueprint(
        rawTask,
        fastDiagnosis,
        { route: "fast" },
        taxonomy,
        "A",
        undefined,
        llmPlan,
        cwd
      );

      store.startBlueprintExecution(blueprint);
      const firstStage = blueprint.stages[0];
      if (!firstStage) return;

      store.applyToolScoping(firstStage.allowedTools, toolHost);
      updateToolFlowStatusBar(ctx, store.getState(), cwd);
      ctx.ui?.notify?.(t.fastStart(firstStage.title), "info");
      pi.sendUserMessage(generateStageActionPrompt(firstStage, blueprint, 0));
      return;
    }

    const diagnosis = await diagnoseTaskRequirements(rawTask, taxonomy, asLlmHost(ctx), undefined, cwd);
    let userDecisions: Record<string, string> | null = null;
    let selectedPlan: "A" | "B" = diagnosis.tradeOff?.recommendedPlan ?? "B";
    let customRequirements: string[] | undefined;

    let usedCustomUi = false;
    const customUi = asCustomUiHost(ctx);
    if (customUi) {
      const navResult = await openArchitectNavigator(
        customUi,
        taxonomy,
        rawTask,
        diagnosis.requirementSlots,
        diagnosis,
        asLlmHost(ctx)
      );
      if (navResult?.kind === "decisions") {
        usedCustomUi = true;
        userDecisions = navResult.decisions;
        selectedPlan = navResult.selectedPlan ?? selectedPlan;
        customRequirements = navResult.customRequirements;
      } else if (navResult?.kind !== "custom_ui_unavailable") {
        ctx.ui?.notify?.(t.cancelled, "info");
        return;
      }
    }

    if (!usedCustomUi) {
      if (typeof ctx.ui?.select === "function") {
        const collected: Record<string, string> = {};
        for (const slot of diagnosis.requirementSlots) {
          const picked = await ctx.ui.select(
            slot.question,
            slot.options.map(option => option.label)
          );
          if (!picked) {
            ctx.ui?.notify?.(t.cancelled, "info");
            return;
          }
          const matched = slot.options.find(option => option.label === picked) ?? slot.options[0];
          if (matched) collected[slot.slotId] = matched.id;
        }
        userDecisions = collected;
      } else {
        const collected: Record<string, string> = {};
        for (const slot of diagnosis.requirementSlots) {
          const recommended = slot.options.find(option => option.isRecommended) ?? slot.options[0];
          if (recommended) collected[slot.slotId] = recommended.id;
        }
        userDecisions = collected;
      }
    }
    if (!userDecisions) {
      ctx.ui?.notify?.(t.noDecision, "info");
      return;
    }

    const ecosystemDecision = userDecisions["slot_ecosystem_expansion"];
    if (ecosystemDecision && ecosystemDecision.startsWith("bundle_") && ecosystemDecision !== "bundle_vanilla") {
      const bundles = EcosystemRadar.scanCatalog(
        rawTask,
        taxonomy.extensions.map(ext => ext.name)
      );
      const chosen = bundles.find(bundle => bundle.id === ecosystemDecision);
      if (chosen && chosen.packages.length > 0) {
        ctx.ui?.notify?.(
          `[ToolFlow] Installing extension(s): ${chosen.packages.map(pkg => pkg.name).join(", ")}`,
          "info"
        );
        await EcosystemRadar.installEcosystemPackages(chosen.packages);
      }
    }

    const llmPlan = await synthesizeBlueprintPlanWithLLM(rawTask, taxonomy, asLlmHost(ctx), cwd);
    const blueprint = synthesizeBlueprint(
      rawTask,
      diagnosis,
      userDecisions,
      taxonomy,
      selectedPlan,
      customRequirements,
      llmPlan,
      cwd
    );

    store.startBlueprintExecution(blueprint);
    const firstStage = blueprint.stages[0];
    if (!firstStage) return;

    store.applyToolScoping(firstStage.allowedTools, toolHost);
    updateToolFlowStatusBar(ctx, store.getState(), cwd);
    ctx.ui?.notify?.(t.blueprintStart(blueprint.stages.length, firstStage.title), "info");

    pi.sendUserMessage(
      `${renderBlueprintSummary(blueprint)}\n\n---\n\n${generateStageActionPrompt(firstStage, blueprint, 0)}`
    );
  }

  pi.registerCommand("toolflow", {
    description: "ToolFlow Context Optimizer & Staged Blueprint Workbench",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const cwd = ctx.cwd || getActiveCwd();
      setActiveCwd(cwd);
      const store = getWorkspaceStore(cwd);
      const toolHost = resolveToolHost(pi, ctx);
      const trimmedArgs = (args || "").trim();

      if (trimmedArgs === "help" || trimmedArgs === "--help" || trimmedArgs === "-h") {
        ctx.ui?.notify?.(t.helpBanner, "info");
        return;
      }

      if (trimmedArgs === "reset") {
        store.reset();
        store.restoreInitialActiveTools(toolHost);
        clearAllReadCaches();
        getStatsManager(cwd).resetLedger();
        clearAllStatsManagers();
        ContextDehydrator.clearLatestLogPaths();
        updateToolFlowStatusBar(ctx, store.getState(), cwd);
        ctx.ui?.notify?.(t.resetSuccess, "info");
        return;
      }

      if (trimmedArgs === "stats") {
        ctx.ui?.notify?.(renderStatsLedger(cwd), "info");
        return;
      }

      const taxonomy = reflectEnvironmentContext(toolHost, cwd);

      if (trimmedArgs === "dashboard") {
        const current = store.getState();
        const stageView = current.currentBlueprint
          ? renderBlueprintSummary(current.currentBlueprint)
          : renderCompactEcosystemOverview(taxonomy);
        ctx.ui?.notify?.(`${stageView}\n\n---\n\n${renderStatsLedger(cwd)}`, "info");
        return;
      }

      if (trimmedArgs === "status") {
        const current = store.getState();
        const view = current.currentBlueprint
          ? renderBlueprintSummary(current.currentBlueprint)
          : renderCompactEcosystemOverview(taxonomy);
        ctx.ui?.notify?.(view, "info");
        return;
      }

      if (trimmedArgs === "export") {
        const current = store.getState();
        if (!current.currentBlueprint) {
          ctx.ui?.notify?.(t.exportNoBlueprint, "warning");
          return;
        }
        const outPath = path.join(cwd, "TOOLFLOW_BLUEPRINT.md");
        fs.writeFileSync(outPath, renderBlueprintSummary(current.currentBlueprint), "utf-8");
        ctx.ui?.notify?.(t.exportSuccess("TOOLFLOW_BLUEPRINT.md"), "info");
        return;
      }

      if (trimmedArgs === "rollback" || trimmedArgs.startsWith("rollback ")) {
        const targetArg = trimmedArgs.split(/\s+/)[1];
        const parsedTarget = targetArg ? Number.parseInt(targetArg, 10) : undefined;
        const targetIdx =
          parsedTarget !== undefined && !Number.isNaN(parsedTarget)
            ? Math.max(0, parsedTarget - 1)
            : undefined;

        const rollback = store.rollbackStage(targetIdx);
        if (!rollback.success) {
          ctx.ui?.notify?.(t.rollbackNothing, "warning");
          return;
        }

        const updated = store.getState();
        const stage = updated.currentBlueprint?.stages[updated.currentStageIndex];
        if (stage) store.applyToolScoping(stage.allowedTools, toolHost);
        updateToolFlowStatusBar(ctx, updated, cwd);
        ctx.ui?.notify?.(
          t.rollbackSuccess(
            rollback.rolledBackToStage + 1,
            rollback.restoredFiles.length,
            rollback.deletedFiles.length
          ),
          "info"
        );
        return;
      }

      if (trimmedArgs.startsWith("fast ")) {
        const fastTask = trimmedArgs.slice(5).trim();
        if (fastTask) {
          await runTaskDecisionPipeline(fastTask, taxonomy, ctx, "fast");
          return;
        }
      }

      if (trimmedArgs.length > 0) {
        await runTaskDecisionPipeline(trimmedArgs, taxonomy, ctx);
        return;
      }

      const customUi = asCustomUiHost(ctx);
      if (customUi) {
        const navResult = await openArchitectNavigator(
          customUi,
          taxonomy,
          "",
          undefined,
          undefined,
          asLlmHost(ctx)
        );
        if (navResult?.kind === "prompt_invoke") {
          ctx.ui?.setEditorText?.(`${navResult.command} `);
          ctx.ui?.notify?.(t.promptInserted(navResult.command), "info");
          return;
        }
        if (navResult?.kind === "task_input" && navResult.task.trim()) {
          await runTaskDecisionPipeline(navResult.task.trim(), taxonomy, ctx);
          return;
        }
        if (navResult?.kind !== "custom_ui_unavailable") {
          return;
        }
      }

      if (typeof ctx.ui?.input === "function") {
        const taskInput = await ctx.ui.input("ToolFlow Task", "Describe the engineering task...");
        if (taskInput && taskInput.trim()) {
          await runTaskDecisionPipeline(taskInput.trim(), taxonomy, ctx);
        }
        return;
      }

      ctx.ui?.notify?.(t.noInteractiveUi, "warning");
    },
  });
}
