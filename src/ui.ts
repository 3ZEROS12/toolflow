import {
  Editor,
  type EditorTheme,
  Key,
  truncateToWidth,
  visibleWidth,
  sliceByColumn,
  matchesKey,
  parseKey,
  wrapTextWithAnsi,
  CURSOR_MARKER
} from "@earendil-works/pi-tui";
import { PromptsManager, PromptItemInfo } from "./prompts_manager.js";
import {
  EcosystemTaxonomy,
  Blueprint,
  DecisionSlot,
  BlueprintStage,
  ArchitectNavigatorResult,
  TaskRequirementChoice,
  TaskDiagnosis
} from "./types.js";
import { diagnoseTaskExecutionMode } from "./engine.js";

/**
 * Single-line CJK-safe input viewport helper (preserved for unit test compatibility)
 */
export function renderCJKSafeInputBox(
  prefix: string,
  text: string,
  windowWidth: number,
  theme: any,
  showCursor: boolean = true,
  emitHardwareCursor: boolean = false
): string {
  const prefixWidth = visibleWidth(prefix);
  const cursorWidth = showCursor ? 1 : 0;
  const availableWidth = Math.max(10, windowWidth - prefixWidth - cursorWidth);

  const cleanText = text.replace(/[\r\n\t]/g, " ");
  const totalTextWidth = visibleWidth(cleanText);

  let visibleSlice = cleanText;
  if (totalTextWidth > availableWidth) {
    const startCol = totalTextWidth - availableWidth;
    visibleSlice = sliceByColumn(cleanText, startCol, availableWidth, true);
  }

  const currentSliceWidth = visibleWidth(visibleSlice);
  const padCount = Math.max(0, availableWidth - currentSliceWidth);
  const marker = showCursor && emitHardwareCursor ? CURSOR_MARKER : "";
  const cursorChar = showCursor ? `${marker}\x1b[7m${theme.fg("accent", " ")}\x1b[27m` : "";

  return `${prefix}${visibleSlice}${cursorChar}${" ".repeat(padCount)}`;
}

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
  rows.push(`| ${padToVisibleWidth(`Task       : ${metrics.task}`, w - 2)} |`);
  rows.push(`| ${padToVisibleWidth(`Blueprint  : ${metrics.blueprintId}`, w - 2)} |`);
  rows.push(`| ${padToVisibleWidth(`Stages     : ${metrics.stageCount} stages verified`, w - 2)} |`);
  rows.push(`| ${padToVisibleWidth(`Duration   : ${dur}s`, w - 2)} |`);
  rows.push(`| ${padToVisibleWidth(`Efficiency : ~${saved} token overhead saved`, w - 2)} |`);
  rows.push(`+${line}+`);
  rows.push(`| ${padToVisibleWidth("Verified Physical Artifacts (SHA-256):", w - 2)} |`);
  for (const f of metrics.verifiedFiles.slice(0, 4)) {
    rows.push(`| ${padToVisibleWidth(`  [x] ${f}`, w - 2)} |`);
  }
  if (metrics.verifiedFiles.length > 4) {
    const remaining = metrics.verifiedFiles.length - 4;
    rows.push(`| ${padToVisibleWidth(`  ... and ${remaining} more verified artifacts`, w - 2)} |`);
  }
  rows.push(`+${line}+`);
  rows.push(`| ${padToVisibleWidth("Tip: Run [/toolflow export] to export blueprint report", w - 2)} |`);
  rows.push(`+${line}+`);

  return rows;
}

/**
 * Dynamic execution pipeline card
 */
export function renderExecutionPipelineCard(params: {
  blueprintId: string;
  task: string;
  currentStageIndex: number;
  stages: BlueprintStage[];
  activeWorkers?: Array<{ name: string; tool: string; status: string }>;
  verifiedArtifactCount: number;
}): string {
  const completedCount = params.stages.filter((_, idx) => idx < params.currentStageIndex).length;
  const totalCount = params.stages.length;

  const lines: string[] = [
    `● **Pipeline Progress** (${completedCount}/${totalCount})  \`${params.blueprintId}\``,
    `> 🎯 Objective: **${params.task}**`,
    ""
  ];

  params.stages.forEach((stage, idx) => {
    const isLast = idx === params.stages.length - 1;
    const branch = isLast ? "└─" : "├─";

    let symbol = "○";
    let statusDesc = "Pending / 等待就绪";

    if (idx < params.currentStageIndex) {
      symbol = "✓";
      statusDesc = "Verified / 已验收完成";
    } else if (idx === params.currentStageIndex) {
      symbol = "◐";
      statusDesc = "Running / 正在执行推进中...";
    }

    const highLevelTools: string[] = [];
    if (stage.allowedTools?.includes("workflow")) highLevelTools.push("@workflow");
    if (stage.allowedTools?.includes("goal") || stage.allowedTools?.includes("goal_complete")) highLevelTools.push("@goal");
    if (stage.allowedTools?.includes("subagent")) highLevelTools.push("@subagent");
    const toolBadge = highLevelTools.length > 0 ? ` [${highLevelTools.join(", ")}]` : "";

    lines.push(`${branch} ${symbol} **Stage ${idx + 1}**: ${stage.title}${toolBadge} \`(${statusDesc})\``);
    lines.push(`   └ Artifact: \`${stage.expectedArtifact}\` | Role: \`${stage.roleProfile}\``);
  });

  if (params.activeWorkers && params.activeWorkers.length > 0) {
    lines.push("");
    lines.push(`**🚀 Active Workers:**`);
    params.activeWorkers.forEach(w => {
      lines.push(`- \`${w.name}\` -> Tool: **${w.tool}** (${w.status})`);
    });
  }

  lines.push("");
  lines.push(`- **Artifact Verification**: ${params.verifiedArtifactCount} / ${params.stages.length} 已物理落地并校验`);
  lines.push(`*Tip: Run \`/toolflow rollback\` to revert current stage changes.*`);

  return lines.join("\n");
}

/**
 * Render Unicode Stage Topology DAG
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

    const stageNum = `[Stage ${i + 1}]`;
    const headerTitle = `${stageNum} ${stage.title}`;
    const headerLine = isCurrent
      ? `${statusNode} ${theme.bold(theme.fg("accent", headerTitle))}`
      : `${statusNode} ${theme.bold(headerTitle)}`;

    lines.push(headerLine);

    const roleLine = `  ├─ [Role]     ${theme.fg("dim", stage.roleProfile)}`;
    const artifactLine = `  ├─ [Artifact] ${theme.fg("accent", stage.expectedArtifact)}`;

    let depLine: string | null = null;
    if (stage.dependsOn && stage.dependsOn.length > 0) {
      depLine = `  ├─ [Depends]  ${theme.fg("warning", stage.dependsOn.join(", "))}`;
    }

    const boundExts = stage.boundCapabilities?.extensions || [];
    const boundSkills = stage.boundCapabilities?.skills || [];
    const boundPrompts = stage.boundCapabilities?.prompts || [];

    const boundAll = [...boundExts, ...boundSkills, ...boundPrompts];
    const boundLine = boundAll.length > 0
      ? `  └─ [Ecosystem] ${theme.fg("success", boundAll.map(b => `@${b}`).join(" "))}`
      : `  └─ [Tools]     ${theme.fg("dim", (stage.allowedTools || []).join(", ") || "base tools")}`;

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
 * Render Compact Ecosystem Overview Markdown
 */
export function renderCompactEcosystemOverview(tax: EcosystemTaxonomy): string {
  const getItems = (items: any[]) =>
    items.length > 0 ? items.map((i) => `\`${i.name}\``).join(" ") : "none";

  const l1 = getItems(tax.extensions.filter((e) => e.layer === "L1_UTILITY"));
  const l2 = getItems(tax.extensions.filter((e) => e.layer === "L2_PERCEPTION"));
  const l3 = getItems(tax.extensions.filter((e) => e.layer === "L3_ORCHESTRATION"));
  const l4 = getItems(tax.extensions.filter((e) => e.layer === "L4_REVIEW_GUARD"));

  const skills = getItems(tax.skills);
  const prompts = getItems(tax.prompts);

  return [
    `### 🧩 Installed Ecosystem Capabilities (0-Token Memory Index)`,
    `- **Utility Tools**: ${l1}`,
    `- **Search & Perception**: ${l2}`,
    `- **Orchestration**: ${l3}`,
    `- **Quality & Review**: ${l4}`,
    `- **Skills**: ${skills}`,
    `- **Prompt Templates**: ${prompts}`,
    `> Tip: Run \`/toolflow <task>\` to generate a staged execution blueprint.`
  ].join("\n");
}

/**
 * Render Blueprint Summary Markdown
 */
export function renderBlueprintSummary(bp: Blueprint): string {
  const lines: string[] = [];
  lines.push(`## [Execution Blueprint] ${bp.task}`);
  lines.push(`**Blueprint ID**: \`${bp.blueprintId}\``);
  lines.push(`\n### ⌬ Stage Topology & Physical Artifacts`);
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

  lines.push("\n### ⌬ Stage Specifications");
  lines.push("| Stage | Role Profile | Bound Capabilities | Expected Artifact | Allowed Base Tools |");
  lines.push("| :--- | :--- | :--- | :--- | :--- |");

  for (let i = 0; i < bp.stages.length; i++) {
    const stage = bp.stages[i];
    const bound = [
      ...(stage.boundCapabilities?.extensions || []),
      ...(stage.boundCapabilities?.skills || []),
      ...(stage.boundCapabilities?.prompts || [])
    ];
    const boundAll = bound.length > 0 ? bound.map((b) => `\`@${b}\``).join(" ") : "`@base`";

    lines.push(
      `| **${i + 1}. ${stage.title}** | \`${stage.roleProfile}\` | ${boundAll} | \`${stage.expectedArtifact}\` | \`${stage.allowedTools.join(",")}\` |`
    );
  }

  lines.push(`\n### ⚡ Architecture & Token Efficiency Rationale`);
  lines.push(bp.tokenEfficiencySummary);

  return lines.join("\n");
}

/**
 * Interactive Workbench & Architecture Decision TUI (ctx.ui.custom)
 * Built on Pi's official questionnaire.ts pattern: native Editor component + borderless wrapped layout
 */
export function openArchitectNavigator(
  ui: any,
  taxonomy: EcosystemTaxonomy,
  initialTask: string = "",
  slots?: DecisionSlot[],
  diagnosis?: TaskDiagnosis,
  ctx?: any
): Promise<ArchitectNavigatorResult> {
  return ui.custom(
    (tui: any, theme: any, _keybindings: any, done: (result: ArchitectNavigatorResult) => void) => {
      let promptsList: PromptItemInfo[] = PromptsManager.scanAllPrompts();
      let promptTab: "recent" | "user" | "system" = "recent";
      let selectedPromptIdx = 0;
      let newPromptName = "";
      let newPromptDesc = "";
      let newPromptContent = "";

      let state:
        | "overview"
        | "input"
        | "deciding"
        | "refining"
        | "custom_option_input"
        | "outline_confirm"
        | "add_prompt_name"
        | "add_prompt_desc"
        | "add_prompt_content" =
        slots && slots.length > 0 ? "deciding" : initialTask ? "input" : "overview";
      let inputTask = initialTask;
      let customRequirementsText = "";
      let newOptionTitle = "";
      let currentSlotIndex = 0;
      let cachedLines: string[] | undefined;
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

      const editorTheme: EditorTheme = {
        borderColor: (s: string) => theme.fg("accent", s),
        selectList: {
          selectedPrefix: (t: string) => theme.fg("accent", t),
          selectedText: (t: string) => theme.fg("accent", t),
          description: (t: string) => theme.fg("muted", t),
          scrollInfo: (t: string) => theme.fg("dim", t),
          noMatch: (t: string) => theme.fg("warning", t),
        },
      };
      const safeTui = tui?.terminal ? tui : { ...tui, terminal: { rows: 24, columns: 80 }, requestRender: () => tui?.requestRender?.() };
      const editor = new Editor(safeTui, editorTheme);
      editor.focused = true;
      if (initialTask) {
        editor.setText(initialTask);
      }

      function rerender() {
        cachedLines = undefined;
        tui.requestRender();
      }

      function enterEditorState(nextState: typeof state, initialVal: string = "") {
        state = nextState;
        editor.setText(initialVal);
        editor.focused = true;
        rerender();
      }

      editor.onChange = (val: string) => {
        if (state === "input") inputTask = val;
        else if (state === "add_prompt_content") newPromptContent = val;
        else if (state === "add_prompt_name") newPromptName = val;
        else if (state === "add_prompt_desc") newPromptDesc = val;
        else if (state === "refining") customRequirementsText = val;
        else if (state === "custom_option_input") newOptionTitle = val;
      };

      editor.onSubmit = (val: string) => {
        const trimmed = val.trim();
        if (state === "input") {
          if (trimmed) {
            done({ kind: "task_input", task: trimmed });
          }
        } else if (state === "add_prompt_content") {
          newPromptContent = trimmed;
          if (newPromptContent) {
            enterEditorState("add_prompt_name", newPromptName);
          }
        } else if (state === "add_prompt_name") {
          newPromptName = trimmed;
          if (newPromptName) {
            enterEditorState("add_prompt_desc", newPromptDesc);
          }
        } else if (state === "add_prompt_desc") {
          newPromptDesc = trimmed;
          if (newPromptName.trim() && newPromptContent.trim()) {
            PromptsManager.createPrompt(
              newPromptName.trim(),
              newPromptDesc || newPromptName.trim(),
              newPromptContent.trim(),
              "global"
            );
            promptsList = PromptsManager.scanAllPrompts();
            selectedPromptIdx = 0;
            state = "overview";
            rerender();
          }
        } else if (state === "refining") {
          customRequirementsText = trimmed;
          state = "deciding";
          rerender();
        } else if (state === "custom_option_input") {
          newOptionTitle = trimmed;
          if (newOptionTitle) {
            const currentSlot = safeSlots[currentSlotIndex];
            if (currentSlot) {
              const newOpt: TaskRequirementChoice = {
                id: `custom_${Date.now()}`,
                label: `[Custom] ${newOptionTitle}`,
                description: "User-defined custom requirement (highest priority)",
                isRecommended: false,
                recommendedEcosystem: {
                  extensions: [],
                  reason: "User custom option"
                }
              };
              currentSlot.options.push(newOpt);
              selectedOptionIndex = currentSlot.options.length - 1;
            }
          }
          state = "deciding";
          rerender();
        }
      };

      function getFilteredPrompts(): PromptItemInfo[] {
        try {
          if (promptTab === "recent") {
            if (typeof (PromptsManager as any).getRecentPrompts === "function") {
              return PromptsManager.getRecentPrompts(promptsList, 5);
            }
            return [...promptsList].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
          } else if (promptTab === "user") {
            return promptsList.filter(p => p.category === "user");
          } else {
            return promptsList.filter(p => p.category === "system");
          }
        } catch (_) {
          return promptsList.slice(0, 5);
        }
      }

      function getOptionEcoItems(opt: any): any[] {
        if (!opt?.recommendedEcosystem) return [];
        const rec = opt.recommendedEcosystem;
        const rawList = [
          ...(rec.extensions || []),
          ...(rec.skills || []),
          ...(rec.prompts || [])
        ];
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

      function isEditorActiveState(): boolean {
        return (
          state === "input" ||
          state === "add_prompt_content" ||
          state === "add_prompt_name" ||
          state === "add_prompt_desc" ||
          state === "refining" ||
          state === "custom_option_input"
        );
      }

      const component = {
        focused: true,
        invalidate: () => {
          cachedLines = undefined;
          editor.invalidate();
        },
        render: (width: number): string[] => {
          if (cachedLines) return cachedLines;

          const lines: string[] = [];
          const renderWidth = Math.max(20, width);
          const titleColor = (s: string) => theme.fg("accent", theme.bold(s));

          function addWrapped(text: string) {
            lines.push(...wrapTextWithAnsi(text, renderWidth));
          }

          function addWrappedWithPrefix(prefix: string, text: string) {
            const prefixWidth = visibleWidth(prefix);
            if (prefixWidth >= renderWidth) {
              addWrapped(prefix + text);
              return;
            }
            const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
            const continuationPrefix = " ".repeat(prefixWidth);
            for (let i = 0; i < wrapped.length; i++) {
              lines.push(`${i === 0 ? prefix : continuationPrefix}${wrapped[i]}`);
            }
          }

          function renderEditorBlock() {
            for (const line of editor.render(Math.max(10, renderWidth - 2))) {
              lines.push(` ${line}`);
            }
          }

          lines.push(theme.fg("accent", "─".repeat(renderWidth)));

          if (state === "overview") {
            addWrappedWithPrefix(" ", titleColor("⌬ ToolFlow Workbench"));
            lines.push("");

            const currentFiltered = getFilteredPrompts();
            const tabRecent =
              promptTab === "recent"
                ? theme.bg("selectedBg", theme.fg("text", " ● Recent (Top 5) "))
                : theme.fg("muted", " ○ Recent ");
            const tabUser =
              promptTab === "user"
                ? theme.bg("selectedBg", theme.fg("text", " ● User Custom "))
                : theme.fg("muted", " ○ User Custom ");
            const tabSystem =
              promptTab === "system"
                ? theme.bg("selectedBg", theme.fg("text", " ● Built-in "))
                : theme.fg("muted", " ○ Built-in ");
            addWrappedWithPrefix(
              " ",
              `${theme.bold("Templates:")} ${tabRecent} ${tabUser} ${tabSystem} ${theme.fg("dim", "(Tab to switch)")}`
            );
            lines.push("");

            if (!currentFiltered || currentFiltered.length === 0) {
              const emptyTip =
                promptTab === "recent"
                  ? "(No recent templates. Press Tab to browse all or [+] to create one.)"
                  : "(No templates in this tab. Press [+] to create a new template.)";
              addWrappedWithPrefix("   ", theme.fg("dim", emptyTip));
            } else {
              const windowSize = 5;
              let startIdx = 0;
              if (currentFiltered.length > windowSize) {
                if (selectedPromptIdx < windowSize) {
                  startIdx = 0;
                } else if (selectedPromptIdx >= currentFiltered.length - 1) {
                  startIdx = currentFiltered.length - windowSize;
                } else {
                  startIdx = selectedPromptIdx - Math.floor(windowSize / 2);
                  if (startIdx + windowSize > currentFiltered.length) {
                    startIdx = currentFiltered.length - windowSize;
                  }
                }
              }
              const visiblePrompts = currentFiltered.slice(startIdx, startIdx + windowSize);

              if (startIdx > 0) {
                addWrappedWithPrefix("   ", theme.fg("dim", `▲ ${startIdx} more above (↑)`));
              }

              visiblePrompts.forEach((p, vIdx) => {
                const actualIdx = startIdx + vIdx;
                const isSel = actualIdx === selectedPromptIdx;
                const cursor = isSel ? theme.fg("accent", "> ") : "  ";
                const cmdPadded =
                  p.command.length < 20 ? p.command + " ".repeat(20 - p.command.length) : p.command;
                const cmdStr = isSel
                  ? theme.bold(theme.fg("accent", cmdPadded))
                  : theme.fg("text", cmdPadded);
                const tag =
                  p.category === "user"
                    ? p.scope === "project"
                      ? theme.fg("warning", "[project]")
                      : theme.fg("success", "[global]")
                    : theme.fg("dim", "[system]");
                const descStr = p.description ? theme.fg("muted", p.description) : "";
                addWrappedWithPrefix(` ${cursor}`, `${cmdStr} ${tag} ${descStr}`);
              });

              if (startIdx + windowSize < currentFiltered.length) {
                addWrappedWithPrefix(
                  "   ",
                  theme.fg("dim", `▼ ${currentFiltered.length - (startIdx + windowSize)} more below (↓)`)
                );
              }

              const selectedItem = currentFiltered[selectedPromptIdx];
              if (selectedItem) {
                lines.push("");
                addWrappedWithPrefix(
                  "   ",
                  theme.fg("dim", "Preview ([p] load into input / [d] delete):")
                );
                const previewLines = PromptsManager.getPromptPreviewLines(selectedItem, 3);
                if (previewLines.length === 0) {
                  addWrappedWithPrefix("     ", theme.fg("dim", "(empty template)"));
                } else {
                  previewLines.forEach((pl: string) => {
                    addWrappedWithPrefix("     ", theme.fg("muted", pl));
                  });
                }
              }
            }

            lines.push("");
            addWrappedWithPrefix(
              " ",
              theme.fg("dim", "Enter/i input task • p load template • + new template • d delete • Esc cancel")
            );
          } else if (state === "add_prompt_content") {
            addWrappedWithPrefix(" ", titleColor("New Prompt Template - Step 1/3: Content"));
            addWrappedWithPrefix(
              " ",
              theme.fg("muted", "Type or paste prompt body (Ctrl+L to auto-generate name & description with AI):")
            );
            lines.push("");
            renderEditorBlock();
            lines.push("");
            addWrappedWithPrefix(" ", theme.fg("dim", "Enter next step • Ctrl+L AI auto-summarize • Esc back"));
          } else if (state === "add_prompt_name") {
            addWrappedWithPrefix(" ", titleColor("New Prompt Template - Step 2/3: Command Name"));
            addWrappedWithPrefix(
              " ",
              theme.fg("muted", "Enter slash command name (e.g. code-review, deploy-check):")
            );
            lines.push("");
            renderEditorBlock();
            lines.push("");
            addWrappedWithPrefix(" ", theme.fg("dim", "Enter next step • Esc back"));
          } else if (state === "add_prompt_desc") {
            addWrappedWithPrefix(" ", titleColor("New Prompt Template - Step 3/3: Description"));
            addWrappedWithPrefix(
              " ",
              theme.fg("muted", `Command: /${newPromptName} - Enter short description:`)
            );
            lines.push("");
            renderEditorBlock();
            lines.push("");
            addWrappedWithPrefix(" ", theme.fg("dim", "Enter save template • Esc back"));
          } else if (state === "input") {
            addWrappedWithPrefix(" ", titleColor("Enter Task Objective"));
            addWrappedWithPrefix(
              " ",
              theme.fg("muted", "Describe your goal (ToolFlow automatically routes Fast-Track vs Staged Blueprint):")
            );
            lines.push("");
            renderEditorBlock();
            lines.push("");

            const taskRoute = diagnoseTaskExecutionMode(inputTask);
            const isFast = taskRoute.mode === "FAST_TRACK";
            const routeBadge = isFast
              ? theme.fg("success", "[⚡ Fast-Track]") +
                theme.fg("dim", " (Direct execution, 0 stage overhead)")
              : theme.fg("accent", "[⌬ Staged Blueprint]") +
                theme.fg("dim", " (Multi-stage verified pipeline)");

            addWrappedWithPrefix(" ", `Route: ${routeBadge}`);
            addWrappedWithPrefix(" ", theme.fg("dim", "Enter confirm & start • Esc back to workbench"));
          } else if (state === "deciding") {
            const currentSlot = safeSlots[currentSlotIndex];
            if (!currentSlot) return [];

            addWrappedWithPrefix(
              " ",
              `${theme.bold("Task:")} ${theme.fg("accent", theme.bold(inputTask || "Task Objective"))}`
            );

            const tabA =
              selectedPlan === "A"
                ? theme.bg("selectedBg", theme.fg("text", " [Plan A: Agile 3-Stage] "))
                : theme.fg("dim", " Plan A: Agile 3-Stage ");
            const tabB =
              selectedPlan === "B"
                ? theme.bg("selectedBg", theme.fg("text", " [Plan B: Industrial 5-Stage] "))
                : theme.fg("dim", " Plan B: Industrial 5-Stage ");

            addWrappedWithPrefix(
              " ",
              `${theme.bold("Mode:")} ${tabA} ${tabB} ${theme.fg("dim", "(Tab/p to toggle)")}`
            );
            lines.push("");

            const slotQuestion = currentSlot.question || "Select your preferred approach:";
            addWrappedWithPrefix(
              " ",
              `Decision [${currentSlotIndex + 1}/${safeSlots.length}]: ${theme.bold(
                theme.fg("accent", currentSlot.title || "Dimension")
              )} ${theme.fg("muted", `· ${slotQuestion}`)}`
            );
            lines.push("");

            const options = Array.isArray(currentSlot.options) ? currentSlot.options : [];
            options.forEach((opt: any, idx: number) => {
              if (!opt) return;
              const isSel = idx === selectedOptionIndex;
              const optId = opt.id || opt.title || `opt_${idx}`;
              const titleText = opt.title || opt.label || "";
              const descText = opt.description || "";
              const isRec = opt.isRecommended;

              const prefix = isSel ? theme.fg("accent", "> ") : "  ";
              const recPrefix = isRec ? "(Recommended) " : "";
              const label = `${idx + 1}. ${titleText} ${recPrefix}`;
              const color = isSel ? "accent" : "text";

              addWrappedWithPrefix(` ${prefix}`, theme.fg(color, label));
              if (descText) {
                addWrappedWithPrefix("      ", theme.fg("muted", descText));
              }

              if (isSel) {
                const ecoItems = getOptionEcoItems(opt);
                if (ecoItems.length > 0) {
                  const itemsToggles = ecoItems
                    .map((item: any) => {
                      const enabled = isEcoItemEnabled(currentSlot.slotId, optId, item, true);
                      const itemName =
                        typeof item === "string" ? item : item?.name || item?.id || "";
                      if (!itemName) return null;
                      return enabled
                        ? theme.fg("accent", `[@${itemName}]`)
                        : theme.fg("dim", `[- disabled]`);
                    })
                    .filter(Boolean)
                    .join(" ");

                  if (itemsToggles.trim()) {
                    addWrappedWithPrefix(
                      "      ",
                      `${theme.fg("dim", "Capabilities:")} ${itemsToggles}`
                    );
                  }
                }
              }
            });

            const sparks = diagnosis?.architectSparks || [];
            if (sparks.length > 0) {
              lines.push("");
              addWrappedWithPrefix(" ", theme.bold(theme.fg("accent", "Architect Sparks ([s] toggle):")));
              sparks.forEach((spark: any) => {
                const isAccepted = acceptedSparks.has(spark.id);
                const tag = isAccepted ? theme.fg("success", "[✓]") : theme.fg("dim", "[ ]");
                addWrappedWithPrefix(
                  "   ",
                  `${tag} ${theme.bold(spark.title)}: ${theme.fg("muted", spark.description)}`
                );
              });
            }

            lines.push("");
            addWrappedWithPrefix(
              " ",
              theme.fg(
                "dim",
                "↑↓/1-3 select • Enter next • a quick start • e add note • + custom option • Esc back"
              )
            );
          } else if (state === "outline_confirm") {
            addWrappedWithPrefix(" ", titleColor("Blueprint Outline Confirmation"));
            lines.push("");
            addWrappedWithPrefix(
              " ",
              `${theme.bold("Task:")} ${theme.fg("accent", inputTask || "Task Objective")}`
            );
            addWrappedWithPrefix(
              " ",
              `${theme.bold("Mode:")} ${
                selectedPlan === "A" ? "Plan A: Agile (3 Stages)" : "Plan B: Industrial (5 Stages)"
              }`
            );
            if (customRequirementsText.trim()) {
              addWrappedWithPrefix(
                " ",
                `${theme.bold("Notes:")} ${theme.fg("warning", customRequirementsText.trim())}`
              );
            }
            lines.push("");
            addWrappedWithPrefix(" ", theme.bold("Planned Stages:"));
            if (selectedPlan === "A") {
              addWrappedWithPrefix("   ", "1. Architecture & Design Contract (docs/design.md)");
              addWrappedWithPrefix("   ", "2. Core Implementation & Live Walkthrough");
              addWrappedWithPrefix("   ", "3. Verification & Delivery Receipt");
            } else {
              addWrappedWithPrefix("   ", "1. Architecture & Design Contract (docs/design.md)");
              addWrappedWithPrefix("   ", "2. Core Module Implementation");
              addWrappedWithPrefix("   ", "3. Live Walkthrough & Preview");
              addWrappedWithPrefix("   ", "4. Automated Test Suite & Quality Gate");
              addWrappedWithPrefix("   ", "5. Final Settlement & Delivery Receipt");
            }
            lines.push("");
            addWrappedWithPrefix(" ", theme.fg("dim", "Enter launch blueprint • Esc back to decisions"));
          } else if (state === "refining") {
            addWrappedWithPrefix(" ", titleColor("Add Custom Constraints / Notes"));
            addWrappedWithPrefix(
              " ",
              theme.fg("muted", "Specify custom instructions or constraints for this blueprint:")
            );
            lines.push("");
            renderEditorBlock();
            lines.push("");
            addWrappedWithPrefix(" ", theme.fg("dim", "Enter save note • Esc cancel"));
          } else if (state === "custom_option_input") {
            addWrappedWithPrefix(" ", titleColor("Add Custom Option"));
            addWrappedWithPrefix(
              " ",
              theme.fg(
                "muted",
                `Enter custom option for [${safeSlots[currentSlotIndex]?.title || "Slot"}]:`
              )
            );
            lines.push("");
            renderEditorBlock();
            lines.push("");
            addWrappedWithPrefix(" ", theme.fg("dim", "Enter add & select • Esc cancel"));
          }

          lines.push(theme.fg("accent", "─".repeat(renderWidth)));
          cachedLines = lines;
          return lines;
        },
        handleInput: (data: string) => {
          if (isEditorActiveState()) {
            if (matchesKey(data, Key.escape)) {
              if (state === "input" || state === "add_prompt_content") {
                state = "overview";
              } else if (state === "add_prompt_name") {
                enterEditorState("add_prompt_content", newPromptContent);
                return;
              } else if (state === "add_prompt_desc") {
                enterEditorState("add_prompt_name", newPromptName);
                return;
              } else {
                state = "deciding";
              }
              rerender();
              return;
            }
            if (state === "add_prompt_content" && (data === "\x0c" || data.charCodeAt(0) === 12)) {
              PromptsManager.autoSummarizeTagWithLLM(newPromptContent, ctx || (ui as any)?.ctx).then(
                res => {
                  newPromptName = res.name;
                  newPromptDesc = res.description;
                  enterEditorState("add_prompt_desc", newPromptDesc);
                }
              );
              return;
            }
            editor.handleInput(data);
            rerender();
            return;
          }

          const parsed = parseKey(data);
          const isUp = matchesKey(data, Key.up) || parsed === "up";
          const isDown = matchesKey(data, Key.down) || parsed === "down";
          const isEnter =
            matchesKey(data, Key.enter) || parsed === "enter" || data === "\r" || data === "\n";
          const isEscape = matchesKey(data, Key.escape) || parsed === "escape";
          const isTab = matchesKey(data, Key.tab) || parsed === "tab" || data === "\t";
          const key = data.toLowerCase();

          if (state === "overview") {
            const currentFiltered = getFilteredPrompts();
            if (isTab) {
              if (promptTab === "recent") promptTab = "user";
              else if (promptTab === "user") promptTab = "system";
              else promptTab = "recent";
              selectedPromptIdx = 0;
              rerender();
            } else if (isUp) {
              if (selectedPromptIdx > 0) {
                selectedPromptIdx--;
                rerender();
              }
            } else if (isDown) {
              if (selectedPromptIdx < currentFiltered.length - 1) {
                selectedPromptIdx++;
                rerender();
              }
            } else if (key === "d" || key === "delete") {
              const sel = currentFiltered[selectedPromptIdx];
              if (sel && sel.category === "user") {
                const deleted = PromptsManager.deletePrompt(sel);
                if (deleted) {
                  promptsList = PromptsManager.scanAllPrompts();
                  const updatedFiltered = getFilteredPrompts();
                  if (selectedPromptIdx >= updatedFiltered.length) {
                    selectedPromptIdx = Math.max(0, updatedFiltered.length - 1);
                  }
                  rerender();
                }
              }
            } else if (key === "p") {
              const sel = currentFiltered[selectedPromptIdx];
              if (sel) {
                if (typeof (PromptsManager as any).recordPromptUsage === "function") {
                  PromptsManager.recordPromptUsage(sel.command);
                }
                done({ kind: "prompt_invoke", command: sel.command, filePath: sel.filePath });
              }
            } else if (isEnter || key === "i" || key === " ") {
              enterEditorState("input", inputTask);
            } else if (key === "+" || key === "a") {
              newPromptContent = "";
              newPromptName = "";
              newPromptDesc = "";
              enterEditorState("add_prompt_content", "");
            } else if (isEscape) {
              done(null);
            }
          } else if (state === "deciding") {
            const currentSlot = safeSlots[currentSlotIndex];
            const options = currentSlot ? currentSlot.options : [];

            if (isEscape) {
              if (currentSlotIndex > 0) {
                currentSlotIndex--;
                selectedOptionIndex = getInitialOptionIndex(safeSlots[currentSlotIndex]);
                rerender();
              } else {
                done(null);
              }
            } else if (isTab || key === "p") {
              selectedPlan = selectedPlan === "A" ? "B" : "A";
              userDecisions.__plan = selectedPlan;
              rerender();
            } else if (key === "s") {
              const sparks = diagnosis?.architectSparks || [];
              if (sparks.length > 0) {
                const unaccepted = sparks.find((sp: any) => !acceptedSparks.has(sp.id));
                if (unaccepted) {
                  acceptedSparks.add(unaccepted.id);
                } else {
                  acceptedSparks.clear();
                }
                rerender();
              }
            } else if (key === "e") {
              enterEditorState("refining", customRequirementsText);
            } else if (data === "+" || data === "=") {
              newOptionTitle = "";
              enterEditorState("custom_option_input", "");
            } else if (key === "a") {
              safeSlots.forEach(s => {
                const recOpt = s.options.find((o: any) => o.isRecommended) || s.options[0];
                if (recOpt) {
                  userDecisions[s.slotId] = recOpt.id || recOpt.label || "";
                }
              });
              userDecisions.__plan = "A";
              selectedPlan = "A";
              state = "outline_confirm";
              rerender();
            } else if (key === "1") {
              if (options.length >= 1) selectedOptionIndex = 0;
              rerender();
            } else if (key === "2") {
              if (options.length >= 2) selectedOptionIndex = 1;
              rerender();
            } else if (key === "3") {
              if (options.length >= 3) selectedOptionIndex = 2;
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
              if (chosen && currentSlot) {
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
                  allCustomReqs.push(`[Architect Spark] ${sp.title}: ${sp.impact}`);
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
          }
        }
      };

      return component;
    }
  );
}
