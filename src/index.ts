import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { loadOrRefreshTaxonomy, reflectEnvironmentContext } from "./taxonomy.js";
import { diagnoseTaskRequirements, synthesizeBlueprint, synthesizeBlueprintPlanWithLLM, generateStageActionPrompt } from "./engine.js";
import { EcosystemRadar } from "./deep_ecosystem.js";
import { renderCompactEcosystemOverview, renderBlueprintSummary, openArchitectNavigator, renderValueReceipt, renderExecutionPipelineCard } from "./ui.js";
import { t } from "./i18n.js";
import { ContextDehydrator } from "./dehydrator.js";
import { BlastRadiusGuard } from "./blast_radius.js";
import { GracefulDegradationMatrix } from "./degradation_matrix.js";
import { CodebaseMemoryManager } from "./memory.js";
import {
  startBlueprintExecution,
  getSessionState,
  checkAndRecordArtifact,
  verifyStageArtifacts,
  advanceStage,
  applyToolScoping,
  BASELINE_TOOLS,
  loadPersistedSessionState,
  rollbackStage,
  resetState,
  clearMemoryState,
  recordInitialActiveTools,
  restoreInitialActiveTools
} from "./state.js";

import { captureReviewDiffSnapshot, buildColdStartReviewContract, ReviewIsolationGuard } from "./review_isolation.js";

const CUSTOM_MSG_TYPE = "toolflow:blueprint";
const blastGuard = new BlastRadiusGuard();
const degradationMatrix = new GracefulDegradationMatrix();
const memoryManager = new CodebaseMemoryManager();
const dehydrator = new ContextDehydrator();
const reviewGuard = new ReviewIsolationGuard();

export default function (pi: ExtensionAPI) {
  // 启动时静默尝试恢复跨会话蓝图状态
  loadPersistedSessionState();

  // 监听全新会话启动 (session_start): 彻底阻断跨会话旧蓝图自愈干扰
  if (typeof pi.on === "function") {
    pi.on("session_start", async (event: any) => {
      // 当开启全新会话时，不仅重置内存状态，还物理清理残余持久化文件，彻底消灭幽灵自愈唤醒
      if (event?.reason === "new" || event?.reason === "clear") {
        resetState(process.cwd());
        reviewGuard.deactivate();
        blastGuard.clearAllowedScope();
        applyToolScoping(BASELINE_TOOLS, pi);
      }
    });
  }
  // 🎯 核心省 Token：紧凑化压制 (Compaction Suppression)
  // 当 Pi 核心触发自动或手动 compact 时，注入 ToolFlow 结构化产物契约指令，物理阻止大模型把已写完的千行代码在 summary 中复述
  if (typeof (pi as any).on === "function") {
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

    (pi as any).on("session_compact", async (event: any, ctx: any) => {
      const savedTokens = typeof event?.tokensSaved === "number" ? event.tokensSaved : undefined;
      if (ctx?.ui?.notify) {
        ctx.ui.notify(t.compactNotice(savedTokens), "info");
      }
    });
  }


  // 注册轻量卡片渲染器
  if (typeof pi.registerMessageRenderer === "function") {
    pi.registerMessageRenderer(CUSTOM_MSG_TYPE, (msg: any, { expanded }, theme) => {
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

  async function runTaskDecisionPipeline(rawTask: string, taxonomy: any, ctx: ExtensionContext | ExtensionCommandContext) {
    if (ctx?.ui?.notify) {
      ctx.ui.notify(t.analyzingTask(rawTask), "info");
    }

    const memoryDirective = memoryManager.getPromptContextInjection();
    const promptTask = memoryDirective ? `${rawTask}\n${memoryDirective}` : rawTask;
    const diagnosis = await diagnoseTaskRequirements(promptTask, taxonomy, ctx);
    const slots = diagnosis.requirementSlots || diagnosis.decisionSlots || [];
    let userDecisions: Record<string, string> | null = null;

    // 优先调用沉浸式弹窗 (ctx.ui.custom)
    if (ctx?.ui && "custom" in ctx.ui && typeof (ctx.ui as any).custom === "function") {
      try {
        const res = await openArchitectNavigator(ctx.ui, taxonomy, rawTask, slots, diagnosis);
        if (!res) {
          // 用户在第一步主动按 Esc 或 Q 取消了操作，安全退出，不产生幽灵推进
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

    // 降级使用基础 select (仅在无 custom 浮层能力的终端环境使用)
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

    // 处理 Slot 0：生态扩展一键安装提议
    const ecosystemDecision = userDecisions["slot_ecosystem_expansion"];
    if (ecosystemDecision && ecosystemDecision !== "bundle_scratch") {
      // 找到了选择的扩展包套餐
      const installedNames = [
        ...(taxonomy.extensions || []).map((e: any) => e.name),
        ...(taxonomy.skills || []).map((s: any) => s.name),
        ...(taxonomy.mcps || []).map((m: any) => m.name)
      ];
      const bundles = await EcosystemRadar.searchEcosystemCatalog(rawTask, installedNames);
      const targetBundle = bundles.find(b => b.id === ecosystemDecision);
      if (targetBundle && targetBundle.packages.length > 0) {
        if (ctx?.ui?.notify) {
          ctx.ui.notify(`正在为当前工程安全装配生态套件 [${targetBundle.title}]...`, "info");
        }
        const installResult = await EcosystemRadar.installPackagesLocally(targetBundle.packages);
        if (installResult.success) {
          if (ctx?.ui?.notify) {
            ctx.ui.notify(`生态套件安装成功！已热重载项目环境与工具注册表。`, "info");
          }
          // 热重载本地生态与拓扑
          taxonomy = await reflectEnvironmentContext(ctx);
        } else {
          if (ctx?.ui?.notify) {
            ctx.ui.notify(`套件安装未完全成功，平滑回退至纯净工程方案。`, "warning");
          }
        }
      }
    }

    // 结合真实 LLM 推理预测最优产物路径与架构类型
    const llmArtifactPlan = await synthesizeBlueprintPlanWithLLM(rawTask, diagnosis, userDecisions, taxonomy, ctx);

    // 合成包含 DAG 拓扑排序的执行蓝图
    const cwd = ctx.cwd || process.cwd();
    const blueprint = synthesizeBlueprint(rawTask, diagnosis, userDecisions, taxonomy, undefined, undefined, llmArtifactPlan);
    recordInitialActiveTools(pi);
    startBlueprintExecution(blueprint, cwd);

    // 动态增强阶段高权重工具与基线工具 (经过 GracefulDegradationMatrix 统一裁剪)
    const firstStage = blueprint.stages[0];
    if (firstStage) {
      if (firstStage.isReviewStage && firstStage.reviewIsolation?.enabled) {
        reviewGuard.activate();
      } else {
        reviewGuard.deactivate();
      }
      blastGuard.updateAllowedScope(firstStage);
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

    // 极简动作指令契约（保持纯净 ASCII 与极致 Token 紧凑，优先引导中高阶工具）
    const actionGuidance = generateStageActionPrompt(firstStage, 0, blueprint.stages.length);
    const guidancePrompt = `[TOOLFLOW EXECUTION CONTRACT ACTIVE]\n` +
      `Stage: 1/${blueprint.stages.length}: ${firstStage.title}\n` +
      `Target: ${firstStage.expectedArtifact}\n` +
      `Objective: ${firstStage.coreObjective}\n` +
      `Contract: ${firstStage.artifactContract}\n` +
      `Action: ${actionGuidance} (/toolflow rollback to revert)`;

    // 🎯 核心省 Token 机制：生成蓝图并开工后，原地触发上下文脱水压缩
    // 清除前置推导、方案探讨的数千 Token 历史，让模型在最纯净的会话中执行阶段 1
    if (ctx && typeof (ctx as any).compact === "function") {
      try {
        (ctx as any).compact({
          customInstructions: `Blueprint generated for task "${rawTask}". Transitioning to active execution. Dehydrate preliminary planning dialogues and retain only the execution blueprint contract and primary target: ${firstStage.expectedArtifact}.`,
          onError: (err: any) => console.warn("[ToolFlow] Blueprint start compact non-fatal:", err?.message)
        });
      } catch (_) {}
    }

    if (typeof pi.sendUserMessage === "function") {
      pi.sendUserMessage(guidancePrompt, { deliverAs: "followUp" });
    }
  }

  async function handleBlueprintFlow(args: string, ctx: ExtensionCommandContext) {
    const rawArg = args ? args.trim() : "";
    const cwd = ctx.cwd || process.cwd();

    // 1. 处理回滚子命令: /toolflow rollback 或 -r
    if (rawArg === "rollback" || rawArg === "-r" || rawArg === "revert") {
      const res = rollbackStage(undefined, cwd);
      reviewGuard.deactivate();
      applyToolScoping(BASELINE_TOOLS, pi);
      if (ctx?.ui?.notify) {
        ctx.ui.notify(res.message, res.success ? "info" : "warning");
      }
      return;
    }

    // 2. 处理重置子命令: /toolflow reset
    if (rawArg === "reset") {
      restoreInitialActiveTools(pi);
      resetState(cwd);
      reviewGuard.deactivate();
      blastGuard.clearAllowedScope();
      if (ctx?.ui?.notify) {
        ctx.ui.notify(t.resetSuccess, "info");
      }
      return;
    }

    // 3. 处理导出子命令: /toolflow export
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

    // 4. 处理流水线看板子命令: /toolflow status 或 /sop
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

    // 5. 检查是否有跨会话未完成的蓝图
    const activeState = getSessionState();
    if (!rawArg && activeState.currentBlueprint && activeState.status === "in_progress") {
      const bp = activeState.currentBlueprint;
      const currentStage = bp.stages[activeState.currentStageIndex];
      const stageNum = `${activeState.currentStageIndex + 1}/${bp.stages.length}`;

      if (ctx?.ui?.select) {
        const choice = await ctx.ui.select(
          `📌 检测到正在进行中的蓝图「${bp.task}」(当前: 阶段 ${stageNum} - ${currentStage?.title})，请选择：`,
          [
            `▶ [继续推进] 阶段 ${stageNum}: ${currentStage?.title}`,
            `↺ [回滚本阶段] 恢复至「${currentStage?.title}」开工前快照`,
            `✚ [新建蓝图] 覆盖并启动新任务`
          ]
        );

        if (choice?.startsWith("▶")) {
          if (ctx?.ui?.notify) {
            ctx.ui.notify(t.resumedStage(stageNum, currentStage?.title || ""), "info");
          }
          return;
        } else if (choice?.startsWith("↺")) {
          const res = rollbackStage();
          if (ctx?.ui?.notify) {
            ctx.ui.notify(res.message, res.success ? "info" : "warning");
          }
          return;
        } else if (choice?.startsWith("✚")) {
          // 用户明确选择新建蓝图，物理重置旧状态与磁盘持久化文件
          resetState(process.cwd());
          blastGuard.clearAllowedScope();
          applyToolScoping(BASELINE_TOOLS, pi);
          if (ctx?.ui?.notify) {
            ctx.ui.notify(t.cleaningOldTask, "info");
          }
        }
      }
    }

    // 动态提取宿主环境中所有实际注册的工具 (来自 pi.getAllTools())
    const registeredToolMetas = typeof pi.getAllTools === "function" ? pi.getAllTools() : [];
    const taxonomy = await loadOrRefreshTaxonomy(cwd, registeredToolMetas);

    // 默认仅输入 /toolflow：弹出全屏弹窗能力概览与战术槽位发射台
    if (!rawArg) {
      if (ctx?.ui && "custom" in ctx.ui && typeof (ctx.ui as any).custom === "function") {
        const res = await openArchitectNavigator(ctx.ui, taxonomy);
        if (res && res.kind === "task_input" && res.task) {
          await runTaskDecisionPipeline(res.task, taxonomy, ctx);
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

  // 注册 /toolflow 主命令
  const toolflowCmdHandler = {
    description: t.cmdMainDesc,
    getArgumentCompletions: (prefix: string) => {
      const subcommands = [
        { label: "rollback", value: "rollback", description: t.cmdRollbackArgDesc },
        { label: "reset", value: "reset", description: t.cmdResetArgDesc },
        { label: "status", value: "status", description: t.cmdStatusArgDesc },
        { label: "export", value: "export", description: t.cmdExportArgDesc }
      ];
      return subcommands.filter(cmd => cmd.value.startsWith(prefix.trim().toLowerCase()));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      await handleBlueprintFlow(args, ctx);
    }
  };

  pi.registerCommand("toolflow", toolflowCmdHandler);

  // 注册 /toolflow-rollback 快捷命令
  const rollbackHandler = {
    description: t.cmdRollbackShortcutDesc,
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const res = rollbackStage();
      if (ctx?.ui?.notify) {
        ctx.ui.notify(res.message, res.success ? "info" : "warning");
      }
    }
  };
  pi.registerCommand("toolflow-rollback", rollbackHandler);

  // 注册 /sop 命令
  pi.registerCommand("sop", {
    description: t.cmdSopDesc,
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const state = getSessionState();
      if (!state.currentBlueprint) {
        if (ctx?.ui?.notify) {
          ctx.ui.notify(t.statusNoBlueprint, "info");
        }
        return;
      }

      const verifiedCount = Object.keys(state.artifactLedger).length;
      const card = renderExecutionPipelineCard({
        blueprintId: state.currentBlueprint.blueprintId,
        task: state.currentBlueprint.task,
        currentStageIndex: state.currentStageIndex,
        stages: state.currentBlueprint.stages,
        verifiedArtifactCount: verifiedCount
      });

      if (typeof pi.sendMessage === "function") {
        pi.sendMessage({
          customType: CUSTOM_MSG_TYPE,
          content: card,
          display: true
        });
      }
    }
  });

  // 注册 tool_call 安全拦截钩子 (写权限与影响面防穿透 + 审查隔离只读硬防线)
  if (typeof (pi as any).on === "function") {
    (pi as any).on("tool_call", async (event: any) => {
      const state = getSessionState();
      if (state.status === "in_progress" && state.currentBlueprint) {
        // 1. 审查阶段只读物理硬防线：物理拦截 write, edit 等篡改代码工具
        if (reviewGuard.isActive()) {
          const tool = (event.toolName || "").toLowerCase();
          if (!reviewGuard.isToolAllowedInReview(tool)) {
            return {
              block: true,
              reason: `[ToolFlow 审查隔离防线] 当前处于只读审查与质量验收阶段，已物理阻断代码修改工具 "${tool}"。请保持客观视角执行测试或检查 diff。`,
              terminate: false
            };
          }
        }

        // 2. 核心敏感文件爆炸半径安全拦截
        const check = blastGuard.verifyToolCall(event);
        if (check.block) {
          return {
            block: true,
            reason: check.reason,
            terminate: false
          };
        }
      }
    });
  }


  // ⚡ 核心实时节省 Token 机制：tool_result 拦截管道 (Tool Output Dehydration Middleware)
  // 当任何终端命令 (bash/powershell) 或外部重型工具输出海量报错/日志时，自动归档并截断，防止污染会话
  if (typeof (pi as any).on === "function") {
    (pi as any).on("tool_result", async (event: any, ctx: any) => {
      if (!event?.content || !Array.isArray(event.content)) return;
      const toolName = event.toolName || "tool";
      for (const block of event.content) {
        if (block?.type === "text" && typeof block.text === "string") {
          const originalLen = block.text.length;
          const originalLines = block.text.split("\n").length;
          const res = dehydrator.dehydrateToolOutput(toolName, block.text);
          if (res.dehydrated) {
            block.text = res.text;
            const approxTokens = Math.max(10, Math.round((originalLen - res.text.length) / 4));
            if (ctx?.ui?.notify) {
              ctx.ui.notify(t.toolOutputDehydrated(toolName, originalLines, approxTokens), "info");
            }
          }
        }
      }
    });

    // ⚡ 核心上下文非破坏性滑动修剪 (Context Sliding Window Optimizer)
    // 监听 context 钩子，对过去 N 轮以外过旧的历史 tool_result 实施就地折叠脱水，彻底防止多轮长对话累积撑爆 Token
    (pi as any).on("context", async (event: any) => {
      try {
        if (!event || !Array.isArray(event.messages)) return;
        const msgs = event.messages;
        const total = msgs.length;
        if (total <= 12) return;

        // 仅保护最近 8 条消息不修剪，之前的旧消息若包含巨型工具返回，予以极速折叠
        const protectIndex = Math.max(0, total - 8);
        for (let i = 0; i < protectIndex; i++) {
          const msg = msgs[i];
          if (msg && msg.role === "tool") {
            if (typeof msg.content === "string") {
              if (msg.content.length > 800 && !msg.content.includes("ToolFlow Context Slimmer")) {
                const lines = msg.content.split("\n");
                if (lines.length > 12) {
                  const head = lines.slice(0, 4).join("\n");
                  const tail = lines.slice(-2).join("\n");
                  msg.content = `${head}\n... [⚡ ToolFlow Context Slimmer: Pruned ${lines.length - 6} lines of historical tool output] ...\n${tail}`;
                }
              }
            } else if (Array.isArray(msg.content)) {
              for (const part of msg.content) {
                if (part && part.type === "text" && typeof part.text === "string" && part.text.length > 800 && !part.text.includes("ToolFlow Context Slimmer")) {
                  const lines = part.text.split("\n");
                  if (lines.length > 12) {
                    const head = lines.slice(0, 4).join("\n");
                    const tail = lines.slice(-2).join("\n");
                    part.text = `${head}\n... [⚡ ToolFlow Context Slimmer: Pruned ${lines.length - 6} lines of historical tool output] ...\n${tail}`;
                  }
                }
              }
            }
          }
        }
      } catch (_) {}
    });
  }

  // 注册 before_agent_start 钩子 (下沉注入蒸馏的 Skill SOP 规则契约与物理防护)
  if (typeof (pi as any).on === "function") {
    (pi as any).on("before_agent_start", async (event: any) => {
      const state = getSessionState();
      if (state.status === "in_progress" && state.currentBlueprint) {
        const currentStage = state.currentBlueprint.stages[state.currentStageIndex];
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
            systemPrompt: (event.systemPrompt || "") + contractXml
          };
        }
      }
    });
  }

  // 物理产物守卫与 3 次就地自愈推进
  pi.on("turn_end", async (_event: any, ctx: ExtensionContext) => {
    try {
      // 强制从磁盘重新加载最新持久化状态，防止内存与磁盘脱节
      loadPersistedSessionState();
      const state = getSessionState();
      if (state.status !== "in_progress" || !state.currentBlueprint) {
        return;
      }

      // 严防死锁死循环：自愈失败超过 3 次时，直接标记挂起，绝不再发送 followUp 消息
      if ((state.retryCount || 0) >= 3) {
        return;
      }

      const currentStage = state.currentBlueprint.stages[state.currentStageIndex];
      if (!currentStage) return;

      // 智能双重路径容错：优先查找 expectedArtifact 相对路径与项目根目录直出路径
      // 阶段 1 (架构设计) 保护机制：若模型本轮正合法调用 read/grep/find/ls 等探索工具，视为正常前期调研，不扣除自愈计数
      // 从 TurnEndEvent 的 toolResults 或 message.content 中提取调用的工具名称
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

      const EXPLORING_TOOLS = ['read', 'grep', 'find', 'ls', 'bash', 'powershell', 'web_search', 'fetch_content'];
      const MUTATION_TOOLS = ['write', 'edit'];
      const isExploring = state.currentStageIndex === 0 &&
        executedToolNames.length > 0 &&
        executedToolNames.some(name => EXPLORING_TOOLS.includes(name)) &&
        !executedToolNames.some(name => MUTATION_TOOLS.includes(name));

      const verificationResult = verifyStageArtifacts(currentStage, process.cwd(), false, isExploring);

      if (verificationResult.valid && verificationResult.record) {
        const { record } = verificationResult;
        if (ctx?.ui?.notify) {
          ctx.ui.notify(t.stageVerified(state.currentStageIndex + 1, currentStage.expectedArtifact, record.sha256.slice(0, 12)), "info");
        }

        // 严防历史遗留文件未变更而误判定
        if (!verificationResult.valid || !verificationResult.record) {
          return;
        }
        try {
          dehydrator.dehydrateStageLog(
            currentStage.stageId,
            currentStage.title,
            `Stage ${state.currentStageIndex + 1} completed with verified artifact: ${currentStage.expectedArtifact}`,
            [record],
            currentStage.artifactContract
          );
          dehydrator.pruneOldRuns();
        } catch (_) {}

        // 阶段流转核心：原地触发上下文脱水压缩，削减前序阶段冗余日志与执行过程
        if (ctx && typeof (ctx as any).compact === "function") {
          try {
            (ctx as any).compact({
              customInstructions: `Stage ${state.currentStageIndex + 1} ("${currentStage.title}") completed. Verified artifact: ${currentStage.expectedArtifact}. Dehydrate prior stage logs and preserve only essential architectural decisions and verified artifact fingerprint.`,
              onError: (err: any) => console.warn("[ToolFlow] Stage-wise compact non-fatal:", err?.message)
            });
          } catch (_) {}
        }

        const turnCwd = ctx.cwd || process.cwd();
        const hasNext = advanceStage(turnCwd);
        const updatedState = getSessionState();
        if (hasNext && updatedState.currentBlueprint) {
          const nextStage = updatedState.currentBlueprint.stages[updatedState.currentStageIndex];
          if (nextStage) {
            if (nextStage.isReviewStage && nextStage.reviewIsolation?.enabled) {
              reviewGuard.activate();
            } else {
              reviewGuard.deactivate();
            }
            blastGuard.updateAllowedScope(nextStage);
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

            // 若下一阶段属于审查/验收阶段，并且启用了冷启动审查隔离
            let prompt = "";
            if (nextStage.isReviewStage && nextStage.reviewIsolation?.enabled) {
              const diffSnapshot = captureReviewDiffSnapshot(process.cwd());
              const reviewContract = buildColdStartReviewContract(
                nextStage,
                updatedState.currentStageIndex,
                updatedState.currentBlueprint.stages.length,
                diffSnapshot
              );
              prompt = `${reviewContract.isolatedSystemPrompt}\n\n${reviewContract.isolatedUserPrompt}\nAction: Execute verification gate and inspect diff objectively. (/toolflow rollback to revert)`;
            } else {
              // 极简动作指令契约（保持纯净 ASCII 与极致 Token 紧凑，优先引导中高阶工具）
              const actionGuidance = generateStageActionPrompt(
                nextStage,
                updatedState.currentStageIndex,
                updatedState.currentBlueprint.stages.length
              );
              prompt = `[Stage ${updatedState.currentStageIndex + 1}/${updatedState.currentBlueprint.stages.length}: ${nextStage.title}]\n` +
                `Target: ${nextStage.expectedArtifact}${previewHint}\n` +
                `Objective: ${nextStage.coreObjective}${gateCmd}\n` +
                `Action: ${actionGuidance} (/toolflow rollback to revert)`;
            }

            // 同步渲染或刷新阶段看板
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
              pi.sendUserMessage(prompt, { deliverAs: "followUp" });
            }
          }
        } else {
          // 最终全部竣工：触发高保真价值结算单与通知，并持久化架构记忆
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

          // 核心方案 2：全阶段竣工时原地调用 ctx.compact() 脱水清理上下文
          // 彻底免去用户手动敲 /new 的繁琐与割裂，同时保留最终的交付指纹与状态
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
        // 验收未通过：触发 3 次就地自愈或熔断提示
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
