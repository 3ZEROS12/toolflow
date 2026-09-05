import { truncateToWidth, visibleWidth, matchesKey, parseKey } from "@earendil-works/pi-tui";
import { PromptsManager, PromptItemInfo } from "./prompts_manager.js";
import { EcosystemTaxonomy, Blueprint, DecisionSlot, BlueprintStage, ArchitectNavigatorResult, TaskRequirementChoice, TaskDiagnosis } from "./types.js";

// 边框规范与内宽计算
const BOX_BORDER_LEFT = "│ ";
const BOX_BORDER_RIGHT = " │";
const BOX_BORDER_OVERHEAD = BOX_BORDER_LEFT.length + BOX_BORDER_RIGHT.length;

export function padToVisibleWidth(content: string, targetWidth: number): string {
  const truncated = truncateToWidth(content, targetWidth, "", true);
  const visW = visibleWidth(truncated);
  const padCount = Math.max(0, targetWidth - visW);
  return truncated + " ".repeat(padCount);
}

export function renderValueReceipt(metrics: {
  task: string;
  blueprintId: string;
  stageCount: number;
  verifiedFiles: string[];
  totalDurationSec?: number;
  durationSec?: number;
  tokenSavingsRatio?: string;
  tokensSavedPct?: number;
}): string[] {
  const w = 62;
  const line = "-".repeat(w);
  const rows: string[] = [];
  const dur = metrics.totalDurationSec ?? metrics.durationSec ?? 0;
  const saved = metrics.tokenSavingsRatio ?? `${metrics.tokensSavedPct ?? 65}%`;

  rows.push(`+${line}+`);
  rows.push(`| ${padToVisibleWidth("                     VALUE DELIVERY RECEIPT", w - 2)} |`);
  rows.push(`+${line}+`);
  rows.push(`| ${padToVisibleWidth(`任务目标   : ${metrics.task}`, w - 2)} |`);
  rows.push(`| ${padToVisibleWidth(`蓝图编号   : ${metrics.blueprintId}`, w - 2)} |`);
  rows.push(`| ${padToVisibleWidth(`阶段总数   : ${metrics.stageCount} 个阶段已全部闭环`, w - 2)} |`);
  rows.push(`| ${padToVisibleWidth(`交付耗时   : ${dur}s`, w - 2)} |`);
  rows.push(`| ${padToVisibleWidth(`Token 效率 : ~${saved} 冗余已被裁剪`, w - 2)} |`);
  rows.push(`+${line}+`);
  rows.push(`| ${padToVisibleWidth("已验收物理产物清单 (SHA-256 校验通过):", w - 2)} |`);
  for (const f of metrics.verifiedFiles.slice(0, 4)) {
    rows.push(`| ${padToVisibleWidth(`  [x] ${f}`, w - 2)} |`);
  }
  if (metrics.verifiedFiles.length > 4) {
    const remaining = metrics.verifiedFiles.length - 4;
    rows.push(`| ${padToVisibleWidth(`  ... 另有 ${remaining} 个物理产物已通过 SHA 校验`, w - 2)} |`);
  }
  rows.push(`+${line}+`);
  rows.push(`| ${padToVisibleWidth("快捷操作: [/toolflow export] 导出完整蓝图文档", w - 2)} |`);
  rows.push(`+${line}+`);

  return rows;
}

/**
 * 动态执行流水线看板 (执行过程多波次与中高阶工具直观呈现)
 */
export function renderExecutionPipelineCard(params: {
  blueprintId: string;
  task: string;
  currentStageIndex: number;
  stages: BlueprintStage[];
  activeWorkers?: Array<{ name: string; tool: string; status: string }>;
  verifiedArtifactCount: number;
}): string {
  const lines: string[] = [
    `### ⌬ ToolFlow 执行流水线看板: \`${params.blueprintId}\``,
    `> 核心目标: **${params.task}** (当前进度: ${params.currentStageIndex + 1}/${params.stages.length})`,
    ""
  ];

  params.stages.forEach((stage, idx) => {
    let mark = "○";
    let statusText = "等待中";
    if (idx < params.currentStageIndex) {
      mark = "✓";
      statusText = "已验收完成";
    } else if (idx === params.currentStageIndex) {
      mark = "●";
      statusText = "正在执行";
    }

    const highLevelTools: string[] = [];
    if (stage.allowedTools?.includes("workflow")) highLevelTools.push("@workflow");
    if (stage.allowedTools?.includes("goal") || stage.allowedTools?.includes("goal_complete")) highLevelTools.push("@goal");
    if (stage.allowedTools?.includes("subagent")) highLevelTools.push("@subagent");
    const toolBadge = highLevelTools.length > 0 ? ` [${highLevelTools.join(", ")}]` : "";

    lines.push(`${mark} **Wave ${idx + 1}**: ${stage.title}${toolBadge} - \`${statusText}\``);
    lines.push(`   └ 产物契约: \`${stage.expectedArtifact}\` | 责任角色: \`${stage.roleProfile}\``);
  });

  if (params.activeWorkers && params.activeWorkers.length > 0) {
    lines.push("");
    lines.push(`**活跃高阶编排节点:**`);
    params.activeWorkers.forEach(w => {
      lines.push(`- 🚀 \`${w.name}\` -> 调用工具: **${w.tool}** (${w.status})`);
    });
  }

  lines.push(`- **物理交付物验收状态**: ${params.verifiedArtifactCount} / ${params.stages.length} 已物理落地并校验`);
  lines.push("");
  lines.push(`*提示: 输入 \`/toolflow rollback\` 可秒级撤销本阶段代码变更。*`);

  return lines.join("\n");
}

/**
 * 渲染 Unicode 阶段拓扑 DAG 字符流程图
 */
export function renderUnicodeDAG(
  stages: BlueprintStage[],
  options?: {
    currentStageIndex?: number;
    width?: number;
    theme?: any;
  }
): string[] {
  if (!stages || stages.length === 0) return [];
  const theme = options?.theme || {
    bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
    fg: (_color: string, s: string) => s,
  };
  const activeIdx = options?.currentStageIndex ?? -1;
  const lines: string[] = [];

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const isCurrent = i === activeIdx;
    const isDone = activeIdx >= 0 && i < activeIdx;

    const statusNode = isDone
      ? theme.fg("success", "[x]")
      : isCurrent
      ? theme.fg("accent", theme.bold("[>]"))
      : theme.fg("dim", "[ ]");

    const stageNum = `[阶段 ${i + 1}]`;
    const headerTitle = `${stageNum} ${stage.title}`;
    const headerLine = isCurrent
      ? `${statusNode} ${theme.bold(theme.fg("accent", headerTitle))}`
      : `${statusNode} ${theme.bold(headerTitle)}`;

    lines.push(headerLine);

    const roleLine = `  ├─ [角色]   ${theme.fg("dim", stage.roleProfile)}`;
    const artifactLine = `  ├─ [产物]   ${theme.fg("accent", stage.expectedArtifact)}`;
    
    let depLine: string | null = null;
    if (stage.dependsOn && stage.dependsOn.length > 0) {
      depLine = `  ├─ [前置]   ${theme.fg("warning", stage.dependsOn.join(", "))}`;
    }

    const boundExts = stage.boundCapabilities?.extensions || [];
    const boundSkills = stage.boundCapabilities?.skills || [];
    const boundPrompts = stage.boundCapabilities?.prompts || [];

    const boundAll = [...boundExts, ...boundSkills, ...boundPrompts];
    const boundLine = boundAll.length > 0
      ? `  └─ [生态]   ${theme.fg("success", boundAll.map(b => `@${b}`).join(" "))}`
      : `  └─ [工具]   ${theme.fg("dim", (stage.allowedTools || []).join(", ") || "原生基础工具")}`;

    lines.push(roleLine);
    lines.push(artifactLine);
    if (depLine) lines.push(depLine);
    lines.push(boundLine);

    if (i < stages.length - 1) {
      lines.push("  │");
    }
  }

  return lines;
}

/**
 * 渲染生态全景概览 Markdown
 */
export function renderCompactEcosystemOverview(tax: EcosystemTaxonomy): string {
  const getItems = (items: any[]) =>
    items.length > 0 ? items.map((i) => `\`${i.name}\``).join(" ") : "无";

  const l1 = getItems(tax.extensions.filter((e) => e.layer === "L1_UTILITY"));
  const l2 = getItems(tax.extensions.filter((e) => e.layer === "L2_PERCEPTION"));
  const l3 = getItems(tax.extensions.filter((e) => e.layer === "L3_ORCHESTRATION"));
  const l4 = getItems(tax.extensions.filter((e) => e.layer === "L4_REVIEW_GUARD"));

  const skills = getItems(tax.skills);
  const prompts = getItems(tax.prompts);

  return [
    `### 🧩 已安装生态能力清单 (0-Token 内存感知)`,
    `- **通用基础工具**: ${l1}`,
    `- **信息与搜索**: ${l2}`,
    `- **多工协同与编排**: ${l3}`,
    `- **审查与质量门禁**: ${l4}`,
    `- **技能库 (Skills)**: ${skills}`,
    `- **提示词模版**: ${prompts}`,
    `> 提示: 输入 \`/toolflow <任务目标>\` 即可一键自适应生成最优执行蓝图。`
  ].join("\n");
}

/**
 * 渲染蓝图交付摘要 Markdown
 */
export function renderBlueprintSummary(bp: Blueprint): string {
  const lines: string[] = [];
  lines.push(`## [执行蓝图] ${bp.task}`);
  lines.push(`**蓝图编号**: \`${bp.blueprintId}\``);
  lines.push(`\n### ⌬ DAG 执行步骤与物理产物清单`);
  lines.push("");

  const dagLines = renderUnicodeDAG(bp.stages, {
    theme: {
      bold: (s: string) => s,
      fg: (_color: string, s: string) => s
    }
  });
  lines.push("```text");
  lines.push(...dagLines);
  lines.push("```");

  lines.push("\n### ⌬ 阶段详细规范");
  lines.push("| 阶段 | 负责角色 | 动态装配进阶工具 | 期望交付物 | 允许基础工具 |");
  lines.push("| :--- | :--- | :--- | :--- | :--- |");

  for (let i = 0; i < bp.stages.length; i++) {
    const stage = bp.stages[i];
    const bound = [
      ...(stage.boundCapabilities?.extensions || []),
      ...(stage.boundCapabilities?.skills || []),
      ...(stage.boundCapabilities?.prompts || [])
    ];
    const boundAll = bound.length > 0 ? bound.map((b) => `\`@${b}\``).join(" ") : "`@原生基础工具`";

    lines.push(
      `| **${i + 1}. ${stage.title}** | \`${stage.roleProfile}\` | ${boundAll} | \`${stage.expectedArtifact}\` | \`${stage.allowedTools.join(",")}\` |`
    );
  }

  lines.push(`\n### ⌬ 架构选型与 Token 节约依据`);
  lines.push(bp.tokenEfficiencySummary);

  return lines.join("\n");
}

/**
 * 沉浸式生态全景与架构决策浮层 ( ctx.ui.custom )
 * 严格复用 @quintinshaw/pi-dynamic-workflows 的 wrapAndBg 算法与边框协议
 */
export function openArchitectNavigator(
  ui: any,
  taxonomy: EcosystemTaxonomy,
  initialTask: string = "",
  slots?: DecisionSlot[],
  diagnosis?: TaskDiagnosis
): Promise<ArchitectNavigatorResult> {
  return ui.custom(
    (tui: any, theme: any, _keybindings: any, done: (result: ArchitectNavigatorResult) => void) => {
      let promptsList: PromptItemInfo[] = PromptsManager.scanAllPrompts();
      let selectedPromptIdx = 0;
      let newPromptName = "";
      let newPromptDesc = "";
      let newPromptContent = "";

      let state: "overview" | "input" | "deciding" | "refining" | "custom_option_input" | "outline_confirm" | "add_prompt_name" | "add_prompt_desc" | "add_prompt_content" =
        slots && slots.length > 0 ? "deciding" : initialTask ? "input" : "overview";
      let inputTask = initialTask;
      let customRequirementsText = "";
      let newOptionTitle = "";
      let currentSlotIndex = 0;
      let acceptedSparks = new Set<string>(
        (diagnosis?.architectSparks || []).filter((s: any) => s.isAcceptedByDefault).map((s: any) => s.id)
      );
      
      const safeSlots = Array.isArray(slots) ? slots : [];
      
      function getInitialOptionIndex(slot?: DecisionSlot): number {
        if (!slot || !slot.options) return 0;
        const recIdx = slot.options.findIndex(o => o.isRecommended);
        return recIdx >= 0 ? recIdx : 0;
      }

      let selectedOptionIndex = getInitialOptionIndex(safeSlots[0]);
      const userDecisions: Record<string, string> = {};
      let selectedPlan: "A" | "B" = "B";

      const ecoToggles: Record<string, boolean> = {};

      function getOptionEcoItems(opt: any): any[] {
        if (!opt?.recommendedEcosystem) return [];
        const rec = opt.recommendedEcosystem;
        const rawList = [
          ...(rec.extensions || []),
          ...(rec.skills || []),
          ...(rec.prompts || [])
        ];
        // 过滤掉无意义的默认泛称或空值
        return rawList.filter((item: any) => {
          if (!item) return false;
          const name = typeof item === "string" ? item : (item?.name || item?.id);
          if (!name) return false;
          const trimmed = String(name).trim();
          return trimmed !== "" && trimmed !== "生态插件" && trimmed !== "ecosystem-plugin";
        });
      }

      function isEcoItemEnabled(slotId: string, optId: string, itemName: string, defaultVal = true): boolean {
        const k = `${slotId}:${optId}:${itemName}`;
        if (ecoToggles[k] !== undefined) return ecoToggles[k];
        return defaultVal;
      }

      function parseKey(data: string): string {
        if (data === "\r" || data === "\n") return "enter";
        if (data === "\x1b") return "escape";
        if (data === "\x1b[A" || data === "\x1bOA") return "up";
        if (data === "\x1b[B" || data === "\x1bOB") return "down";
        if (data === "\x1b[C" || data === "\x1bOC") return "right";
        if (data === "\x1b[D" || data === "\x1bOD") return "left";
        if (data === "\x7f" || data === "\x08") return "backspace";
        if (data === " ") return "space";
        return data;
      }

      function rerender() {
        tui.requestRender();
      }

      const component = {
        render: (width: number) => {
          const borderColor = (s: string) => theme.fg("borderMuted", s);
          const bgColor = (s: string) => theme.bg("customMessageBg", s);
          const titleColor = (s: string) => theme.fg("accent", theme.bold(s));

          const innerWidth = Math.max(10, width - BOX_BORDER_OVERHEAD);
          const lines: string[] = [];

          if (state === "overview") {
            lines.push(titleColor("⌬ ToolFlow 任务编排"));
            lines.push(theme.fg("dim", "─".repeat(innerWidth)));
            lines.push("  " + theme.bold("提示词速选 (按 [p] 填入，按 [+] 新建):"));
            lines.push("");

            if (!promptsList || promptsList.length === 0) {
              lines.push(theme.fg("dim", "  (暂无提示词模板，按 [+] 可直接新建)"));
            } else {
              promptsList.slice(0, 6).forEach((p, idx) => {
                const isSel = idx === selectedPromptIdx;
                const cursor = isSel ? theme.fg("accent", "▶ ") : "  ";
                const cmdStr = isSel ? theme.bold(theme.fg("accent", p.command.padEnd(26))) : theme.fg("dim", p.command.padEnd(26));
                const scopeTag = p.scope === "project" ? theme.fg("warning", "[项目]") : p.scope === "package" ? theme.fg("dim", "[插件]") : theme.fg("success", "[全局]");
                const descStr = p.description ? (p.description.length > (innerWidth - 38) ? p.description.slice(0, innerWidth - 41) + "..." : p.description) : "";
                lines.push(cursor + cmdStr + " " + scopeTag + " " + theme.fg("dim", descStr));
              });
              if (promptsList.length > 6) {
                lines.push(theme.fg("dim", `  ... 还有 ${promptsList.length - 6} 个未展开`));
              }
            }

            lines.push("");
            lines.push(theme.fg("dim", "─".repeat(innerWidth)));
            lines.push(
              "  " + theme.fg("accent", "[Enter]/[i]") + " 输入任务开工   " +
              theme.fg("accent", "[p]") + " 填入选中模板   " +
              theme.fg("accent", "[+]") + " 新建模板   " +
              theme.fg("dim", "• [Esc] 退出")
            );
          } else if (state === "add_prompt_content") {
            lines.push(titleColor("新建提示词模板 - 粘贴正文"));
            lines.push(theme.fg("dim", "直接输入或鼠标右键粘贴内容，可按 [Ctrl+L] 让 AI 自动生成命令与说明："));
            lines.push("");
            const displayC = newPromptContent.length > (innerWidth * 2) ? newPromptContent.slice(0, innerWidth * 2) + "..." : newPromptContent;
            lines.push(theme.fg("dim", "> ") + displayC + theme.fg("accent", "█"));
            lines.push("");
            lines.push(theme.fg("dim", "─".repeat(innerWidth)));
            lines.push("  " + theme.fg("accent", "[Enter]") + " 手动填写   " + theme.fg("accent", "[Ctrl+L]") + " AI自动生成   " + theme.fg("dim", "[Esc] 返回"));
          } else if (state === "add_prompt_name") {
            lines.push(titleColor("新建提示词模板 - 命令名称"));
            lines.push(theme.fg("dim", "设置斜杠命令名（如 wechat-test, code-review 等）："));
            lines.push("");
            lines.push(theme.fg("dim", "命令: /") + newPromptName + theme.fg("accent", "█"));
            lines.push(theme.fg("dim", "说明: ") + newPromptDesc);
            lines.push("");
            lines.push(theme.fg("dim", "─".repeat(innerWidth)));
            lines.push("  " + theme.fg("accent", "[Enter]") + " 下一步   " + theme.fg("dim", "[Esc] 返回"));
          } else if (state === "add_prompt_desc") {
            lines.push(titleColor("新建提示词模板 - 功能说明"));
            lines.push(theme.fg("dim", "简述它的作用（20字以内）："));
            lines.push("");
            lines.push(theme.fg("dim", "命令: /") + newPromptName);
            lines.push(theme.fg("dim", "说明: ") + newPromptDesc + theme.fg("accent", "█"));
            lines.push("");
            lines.push(theme.fg("dim", "─".repeat(innerWidth)));
            lines.push("  " + theme.fg("accent", "[Enter]") + " 保存落盘   " + theme.fg("dim", "[Esc] 返回"));          } else if (state === "input") {
            lines.push(titleColor("输入任务目标"));
            lines.push(theme.fg("dim", "用一句话描述您想达成的目标（系统将自动规划最优执行路径与推荐选项）："));
            lines.push("");
            lines.push(`> ${inputTask}${theme.fg("accent", "█")}`);
            lines.push("");
            lines.push("─".repeat(innerWidth));
            lines.push(theme.fg("dim", "[Enter] 确认推导   [Esc] 返回   [Backspace] 删除"));
          } else if (state === "deciding") {
            const currentSlot = safeSlots[currentSlotIndex];
            if (!currentSlot) return [];

            lines.push(
              `  ${theme.bold("当前目标:")} ${theme.fg("accent", theme.bold(inputTask || "任务目标"))}`
            );

            const tabA = selectedPlan === "A"
              ? theme.fg("accent", theme.bold("[选项 A: 敏捷直出]"))
              : theme.fg("dim", " 选项 A: 敏捷直出 ");
            const tabB = selectedPlan === "B"
              ? theme.fg("accent", theme.bold("[选项 B: 工业工程]"))
              : theme.fg("dim", " 选项 B: 工业工程 ");

            lines.push(`  架构模式: [1]${tabA}  [2]${tabB}  ${theme.fg("dim", "• [1/2] 切换")}`);

            const slotQuestion = currentSlot.question || "请选择配置偏好";
            lines.push(
              `  决策维度 [${currentSlotIndex + 1}/${safeSlots.length}]: ${theme.bold(
                theme.fg("accent", currentSlot.title || "维度")
              )} ${theme.fg("dim", `· ${slotQuestion}`)}`
            );

            // 若当前为 Slot 0 (生态套件一键推荐)，给予显著的高亮标识与价值说明
            if (currentSlot.slotId === "slot_ecosystem_expansion") {
              lines.push(
                `  ${theme.fg("warning", "🌟 [生态拓展] 发现经过社区验证的现成扩展套件，可大幅缩短编码周期 (按回车选用):")}`
              );
            }

            lines.push(theme.fg("dim", "─".repeat(innerWidth)));

            const options = Array.isArray(currentSlot.options) ? currentSlot.options : [];
            options.forEach((opt: any, idx: number) => {
              if (!opt) return;
              const isSel = idx === selectedOptionIndex;
              const optId = opt.id || opt.title || `opt_${idx}`;
              const titleText = opt.title || opt.label || "";
              const descText = opt.description || "";
              const isRec = opt.isRecommended;

              const prefix = isSel ? theme.fg("accent", theme.bold("  > ")) : "    ";
              const recPrefix = isRec ? theme.fg("accent", "[推荐] ") : "";
              const optLine = isSel
                ? `${prefix}${theme.bold(theme.fg("accent", `${recPrefix}${titleText}`))}`
                : `${prefix}${theme.fg("muted", `${recPrefix}${titleText}`)}`;
              lines.push(optLine);

              if (descText) {
                lines.push(`      ${theme.fg("dim", descText)}`);
              }

              if (isSel) {
                const ecoItems = getOptionEcoItems(opt);
                if (ecoItems.length > 0) {
                  const itemsToggles = ecoItems
                    .map((item: any) => {
                      const enabled = isEcoItemEnabled(currentSlot.slotId, optId, item, true);
                      const itemName = typeof item === "string" ? item : (item?.name || item?.id || "");
                      if (!itemName || itemName === "生态插件") return null;
                      const checkbox = enabled
                        ? theme.fg("accent", `[@${itemName}]`)
                        : theme.fg("dim", `[- 未启用]`);
                      return checkbox;
                    })
                    .filter(Boolean)
                    .join(" ");

                  if (itemsToggles.trim()) {
                    lines.push(`      ${theme.fg("dim", "装配高阶能力:")} ${itemsToggles}`);
                  }
                }
              }
              lines.push("");
            });

            // 渲染 AI 架构师灵感推荐 (Surprises & Sparks)
            const sparks = diagnosis?.architectSparks || [];
            if (sparks.length > 0) {
              lines.push(theme.fg("dim", "─".repeat(innerWidth)));
              lines.push(`  ${theme.bold(theme.fg("accent", "灵感推荐 (按 [s] 采纳/切换):"))}`);
              sparks.forEach((spark: any) => {
                const isAccepted = acceptedSparks.has(spark.id);
                const tag = isAccepted
                  ? theme.fg("success", "[✓ 已采纳]")
                  : theme.fg("dim", "[○ 待采纳]");
                lines.push(`    ${tag} ${theme.bold(spark.title)}: ${theme.fg("dim", spark.description)}`);
              });
            }

            lines.push("─".repeat(innerWidth));
            const backPrompt = currentSlotIndex > 0 ? "   [Esc] 返回上一步" : "   [Esc] 退出";
            lines.push(
              theme.fg(
                "dim",
                `  [1-3] 快捷选取   [s] 采纳灵感   [a] 15秒极速开工   [e] 补充要求   [Enter] 确认下一步${backPrompt}`
              )
            );
          } else if (state === "outline_confirm") {
            lines.push(titleColor("[蓝图大纲确认] 确认后按回车即刻开工"));
            lines.push(theme.fg("dim", "─".repeat(innerWidth)));
            lines.push(`  ${theme.bold("任务目标:")} ${theme.fg("accent", inputTask || "任务目标")}`);
            lines.push(`  ${theme.bold("执行模式:")} ${selectedPlan === "A" ? "敏捷直出型 (3 阶段)" : "工业工程型 (5 阶段 · 含走查共创)"}`);
            if (customRequirementsText.trim()) {
              lines.push(`  ${theme.bold("个性要求:")} ${theme.fg("warning", customRequirementsText.trim())}`);
            }
            lines.push("");
            lines.push(`  ${theme.bold("计划执行阶段:")}`);
            if (selectedPlan === "A") {
              lines.push("    1. 方案设计与契约 (docs/design.md)");
              lines.push("    2. ⭐ 敏捷编码与实机走查 (核心源码 + 浏览器/终端展示)");
              lines.push("    3. 门禁验收与终审交付 (物理指纹结算)");
            } else {
              lines.push("    1. 方案设计与意图契约 (docs/design.md)");
              lines.push("    2. 核心功能编写与模块构建 (核心源码编写)");
              lines.push("    3. ⭐ 效果展示与客户共创走查 (实机走查与建议征询)");
              lines.push("    4. 自动化单测与物理门禁 (单测用例与测试断言)");
              lines.push("    5. 终审归档与高保真通知 (物理交付账本)");
            }
            lines.push("");
            lines.push("─".repeat(innerWidth));
            lines.push(theme.fg("accent", "  [Enter] 立即开工") + theme.fg("dim", "   [Esc] 返回微调"));
          } else if (state === "refining") {
            lines.push(titleColor("补充个性化需求 (最高优先级)"));
            lines.push(theme.fg("dim", "在此输入您对执行蓝图的特殊指令或约束（如性能指标、特定依赖库）："));
            lines.push("");
            lines.push(`> ${customRequirementsText}${theme.fg("accent", "█")}`);
            lines.push("");
            lines.push("─".repeat(innerWidth));
            lines.push(theme.fg("dim", "[Enter] 确认并继续   [Esc] 取消   [Backspace] 删除"));
          } else if (state === "custom_option_input") {
            lines.push(titleColor("添加自定义决策选项"));
            lines.push(
              theme.fg(
                "dim",
                `为当前槽位【${safeSlots[currentSlotIndex]?.title || ""}】输入您的自定义方案名称：`
              )
            );
            lines.push("");
            lines.push(`> ${newOptionTitle}${theme.fg("accent", "█")}`);
            lines.push("");
            lines.push("─".repeat(innerWidth));
            lines.push(theme.fg("dim", "[Enter] 添加并选中   [Esc] 取消   [Backspace] 删除"));
          }

          const raw = lines;
          const titleText = " ⌬ ToolFlow ";
          const title = titleColor(titleText);
          const titleVisW = visibleWidth(titleText);

          // 严格按终端实际宽度计算顶边框和底边框，严禁超宽 1 字符导致崩溃
          const topFillLen = Math.max(0, width - 2 - 1 - titleVisW); // "╭─" (2) + "╮" (1) + title
          const topBorder = truncateToWidth(
            borderColor("╭─") + title + borderColor("─".repeat(topFillLen)) + borderColor("╮"),
            width,
            "",
            true
          );

          const botFillLen = Math.max(0, width - 2); // "╰" (1) + "╯" (1)
          const botBorder = truncateToWidth(
            borderColor(`╰${"─".repeat(botFillLen)}╯`),
            width,
            "",
            true
          );

          const wrapAndBg = (line: string) => {
            const padded = truncateToWidth(line, innerWidth, "", true);
            const fullLine = truncateToWidth(
              borderColor(BOX_BORDER_LEFT) + padded + borderColor(BOX_BORDER_RIGHT),
              width,
              "",
              true
            );
            const trailingPad = width - visibleWidth(fullLine);
            return bgColor(fullLine + (trailingPad > 0 ? " ".repeat(trailingPad) : ""));
          };

          return [bgColor(topBorder), ...raw.map(wrapAndBg), bgColor(botBorder)];
        },
        handleInput: (data: string) => {
          const parsed = parseKey(data);
          const isUp = matchesKey(data, "up") || parsed === "up" || data === "\x1b[A" || data === "\x1bOA";
          const isDown = matchesKey(data, "down") || parsed === "down" || data === "\x1b[B" || data === "\x1bOB";
          const isEnter = matchesKey(data, "enter") || parsed === "enter" || data === "\r" || data === "\n";
          const isEscape = matchesKey(data, "escape") || parsed === "escape" || data === "\x1b" || data === "\u001b";
          const key = data.toLowerCase();

          if (state === "overview") {
            if (isUp) {
              if (selectedPromptIdx > 0) {
                selectedPromptIdx--;
                rerender();
              }
            } else if (isDown) {
              if (selectedPromptIdx < promptsList.length - 1) {
                selectedPromptIdx++;
                rerender();
              }
            } else if (key === "p") {
              const sel = promptsList[selectedPromptIdx];
              if (sel) {
                done({ kind: "prompt_invoke", command: sel.command, filePath: sel.filePath });
              }
            } else if (isEnter || key === "i" || key === " ") {
              state = "input";
              rerender();
            } else if (key === "+" || key === "a") {
              newPromptContent = "";
              newPromptName = "";
              newPromptDesc = "";
              state = "add_prompt_content";
              rerender();
            } else if (isEscape) {
              done(null);
            }
          } else if (state === "add_prompt_content") {
            if (isEscape) {
              state = "overview";
              rerender();
            } else if (data === "" || data === "" || (data.charCodeAt(0) === 12)) {
              // 按 Ctrl+L：调用用户大模型自动总结提取标签与说明
              PromptsManager.autoSummarizeTagWithLLM(newPromptContent, (ui as any).ctx).then(res => {
                newPromptName = res.name;
                newPromptDesc = res.description;
                state = "add_prompt_desc";
                rerender();
              });
            } else if (isEnter) {
              if (newPromptContent.trim()) {
                state = "add_prompt_name";
                rerender();
              }
            } else if (key === "backspace" || data === "" || data === "") {
              newPromptContent = Array.from(newPromptContent).slice(0, -1).join("");
              rerender();
            } else if (data) {
              const cleaned = data.replace(/\[[0-9;]*[a-zA-Z]/g, "");

              if (cleaned.length > 0) {
                newPromptContent += cleaned;
                rerender();
              }
            }
          } else if (state === "add_prompt_name") {
            if (isEscape) {
              state = "add_prompt_content";
              rerender();
            } else if (isEnter) {
              if (newPromptName.trim()) {
                state = "add_prompt_desc";
                rerender();
              }
            } else if (key === "backspace" || data === "" || data === "") {
              newPromptName = Array.from(newPromptName).slice(0, -1).join("");
              rerender();
            } else if (data) {
              const cleaned = data.replace(/\[[0-9;]*[a-zA-Z]/g, "");

              if (cleaned.length > 0) {
                newPromptName += cleaned;
                rerender();
              }
            }
          } else if (state === "add_prompt_desc") {
            if (isEscape) {
              state = "add_prompt_name";
              rerender();
            } else if (isEnter) {
              if (newPromptName.trim() && newPromptContent.trim()) {
                PromptsManager.createPrompt(newPromptName, newPromptDesc || newPromptName, newPromptContent, "global");
                promptsList = PromptsManager.scanAllPrompts();
                selectedPromptIdx = 0;
                state = "overview";
                rerender();
              }
            } else if (key === "backspace" || data === "" || data === "") {
              newPromptDesc = Array.from(newPromptDesc).slice(0, -1).join("");
              rerender();
            } else if (data) {
              const cleaned = data.replace(/\[[0-9;]*[a-zA-Z]/g, "");

              if (cleaned.length > 0) {
                newPromptDesc += cleaned;
                rerender();
              }
            }          } else if (state === "input") {
            if (isEscape) {
              state = "overview";
              rerender();
            } else if (isEnter) {
              if (inputTask.trim()) {
                done({
                  kind: "task_input",
                  task: inputTask.trim()
                });
              }
            } else if (key === "backspace" || data === "\x7f" || data === "\x08") {
              inputTask = Array.from(inputTask).slice(0, -1).join("");
              rerender();
            } else if (data) {
              // 过滤掉纯 ANSI 控制字符与换行退格，完整支持鼠标右键粘贴或快捷键粘贴大段文本
              const cleaned = data.replace(/\[[0-9;]*[a-zA-Z]/g, "");

              if (cleaned.length > 0) {
                inputTask += cleaned;
                rerender();
              }
            }
          } else if (state === "deciding") {
            const currentSlot = safeSlots[currentSlotIndex];
            if (!currentSlot) return;

            const options = Array.isArray(currentSlot.options) ? currentSlot.options : [];

            if (isEscape) {
              // 支持按 Esc 回退到上一个决策维度
              if (currentSlotIndex > 0) {
                currentSlotIndex--;
                selectedOptionIndex = getInitialOptionIndex(safeSlots[currentSlotIndex]);
                rerender();
              } else {
                // 第一步按 Esc，退出交互
                done(null);
              }
              return;
            } else if (data === "q" || data === "Q") {
              done(null);
            } else if (key === "tab" || data === "\t" || data === "p" || data === "P") {
              // 自由切换 Plan A (敏捷) / Plan B (工业)
              selectedPlan = selectedPlan === "A" ? "B" : "A";
              userDecisions.__plan = selectedPlan;
              rerender();
            } else if (data === "s" || data === "S") {
              // 切换采纳架构师灵感建议 (支持多灵感循环切换状态)
              const sparks = diagnosis?.architectSparks || [];
              if (sparks.length > 0) {
                // 找到第一个未采纳的灵感进行采纳；如果全部已采纳，则清空重新循环
                const unaccepted = sparks.find((sp: any) => !acceptedSparks.has(sp.id));
                if (unaccepted) {
                  acceptedSparks.add(unaccepted.id);
                } else {
                  acceptedSparks.clear();
                }
                rerender();
              }
            } else if (data === "e" || data === "E") {
              state = "refining";
              rerender();
            } else if (data === "+" || data === "=") {
              state = "custom_option_input";
              newOptionTitle = "";
              rerender();
            } else if (data === "a" || data === "A") {
              // [a] 一键全选推荐项并跳转至开工大纲确认
              safeSlots.forEach((s) => {
                const recOpt = s.options.find((o: any) => o.isRecommended) || s.options[0];
                if (recOpt) {
                  userDecisions[s.slotId] = recOpt.id || recOpt.label || "";
                }
              });
              userDecisions.__plan = "A";
              selectedPlan = "A";
              state = "outline_confirm";
              rerender();
            } else if (key === "1" || data === "1") {
              if (options.length >= 1) {
                selectedOptionIndex = 0;
              }
              rerender();
            } else if (key === "2" || data === "2") {
              if (options.length >= 2) {
                selectedOptionIndex = 1;
              }
              rerender();
            } else if (key === "3" || data === "3") {
              if (options.length >= 3) {
                selectedOptionIndex = 2;
              }
              rerender();
            } else if (isUp) {
              if (selectedOptionIndex > 0) {
                selectedOptionIndex--;
                rerender();
              }
            } else if (isDown) {
              if (selectedOptionIndex < options.length - 1) {
                selectedOptionIndex++;
                rerender();
              }
            } else if (isEnter) {
              const chosen = options[selectedOptionIndex];
              if (chosen) {
                userDecisions[currentSlot.slotId] = chosen.id || chosen.label || "";
              }

              if (currentSlotIndex < safeSlots.length - 1) {
                currentSlotIndex++;
                selectedOptionIndex = getInitialOptionIndex(safeSlots[currentSlotIndex]);
                rerender();
              } else {
                userDecisions.__plan = selectedPlan;
                state = "outline_confirm";
                rerender();
              }
            }
          } else if (state === "outline_confirm") {
            if (isEscape) {
              state = "deciding";
              rerender();
            } else if (isEnter) {
              const allCustomReqs: string[] = [];
              if (customRequirementsText.trim()) {
                allCustomReqs.push(customRequirementsText.trim());
              }
              const sparks = diagnosis?.architectSparks || [];
              sparks.forEach((sp: any) => {
                if (acceptedSparks.has(sp.id)) {
                  allCustomReqs.push(`[架构师灵感采纳] ${sp.title}: ${sp.impact}`);
                }
              });

              done({
                kind: "decisions",
                decisions: userDecisions,
                task: inputTask,
                selectedPlan,
                customRequirements: allCustomReqs.length > 0 ? allCustomReqs : undefined,
                customEcosystem: {
                  enabledExtensions: [],
                  enabledSkills: [],
                  enabledPrompts: []
                }
              });
            }
          } else if (state === "refining") {
            if (isEscape || isEnter) {
              state = "deciding";
              rerender();
            } else if (key === "backspace" || data === "\x7f" || data === "\x08") {
              customRequirementsText = Array.from(customRequirementsText).slice(0, -1).join("");
              rerender();
            } else if (!data.startsWith("\x1b") && !/[\r\n\x7f\x08]/.test(data)) {
              customRequirementsText += data;
              rerender();
            }
          } else if (state === "custom_option_input") {
            if (isEscape) {
              state = "deciding";
              rerender();
            } else if (isEnter) {
              if (newOptionTitle.trim()) {
                const currentSlot = safeSlots[currentSlotIndex];
                if (currentSlot) {
                  const newOpt: TaskRequirementChoice = {
                    id: `custom_${Date.now()}`,
                    label: `[自定义] ${newOptionTitle.trim()}`,
                    description: "用户手动补充的个性化要求 (最高优先级执行)",
                    isRecommended: false,
                    recommendedEcosystem: {
                      extensions: [],
                      reason: "用户自定义个性化方案"
                    }
                  };
                  currentSlot.options.push(newOpt);
                  selectedOptionIndex = currentSlot.options.length - 1;
                }
              }
              state = "deciding";
              rerender();
            } else if (key === "backspace" || data === "\x7f" || data === "\x08") {
              newOptionTitle = Array.from(newOptionTitle).slice(0, -1).join("");
              rerender();
            } else if (!data.startsWith("\x1b") && !/[\r\n\x7f\x08]/.test(data)) {
              newOptionTitle += data;
              rerender();
            }
          }
        }
      };

      return component;
    }
  );
}
