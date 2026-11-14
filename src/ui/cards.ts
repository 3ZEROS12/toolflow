import {
  CURSOR_MARKER,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type {
  Blueprint,
  BlueprintStage,
  CapabilityItem,
  EcosystemTaxonomy,
} from "../core/types.js";

export interface UiThemeLike {
  bold: (s: string) => string;
  fg: (color: string, s: string) => string;
  bg?: (color: string, s: string) => string;
}

const DEFAULT_THEME: UiThemeLike = {
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  fg: (_color: string, s: string) => s,
};

function formatCapabilityBadge(name: string): string {
  const trimmed = (name || "").trim();
  if (!trimmed) return "";
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

function formatCompactToolList(tools: string[] = [], maxCount = 6): string {
  const unique = Array.from(new Set(tools.filter(Boolean)));
  if (unique.length === 0) return "base tools";
  if (unique.length <= maxCount) return unique.join(", ");
  return `${unique.slice(0, maxCount).join(", ")} (+${unique.length - maxCount} more)`;
}

/**
 * Single-line CJK-safe input viewport helper using UAX #11 visible column width.
 */
export function renderCJKSafeInputBox(
  prefix: string,
  text: string,
  windowWidth: number,
  theme: Pick<UiThemeLike, "fg">,
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
  return truncated + " ".repeat(Math.max(0, targetWidth - visW));
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
  const saved = metrics.tokenSavingsRatio ?? `${metrics.tokensSavedPct ?? 0}%`;

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
    `> **${params.task}**`,
    "",
  ];

  params.stages.forEach((stage, idx) => {
    const isLast = idx === params.stages.length - 1;
    const branch = isLast ? "└─" : "├─";

    let symbol = "○";
    let statusDesc = "Pending";
    if (idx < params.currentStageIndex) {
      symbol = "✓";
      statusDesc = "Verified";
    } else if (idx === params.currentStageIndex) {
      symbol = "◐";
      statusDesc = "Running";
    }

    const modeBadge = stage.isReviewStage ? " [review]" : "";
    lines.push(`${branch} ${symbol} **Stage ${idx + 1}**: ${stage.title}${modeBadge} \`(${statusDesc})\``);
    lines.push(`   └ Artifact: \`${stage.expectedArtifact}\` | Tools: \`${formatCompactToolList(stage.allowedTools, 4)}\``);
  });

  if (params.activeWorkers && params.activeWorkers.length > 0) {
    lines.push("");
    lines.push("**Active Workers:**");
    for (const w of params.activeWorkers) {
      lines.push(`- \`${w.name}\` -> Tool: **${w.tool}** (${w.status})`);
    }
  }

  lines.push("");
  lines.push(`- **Artifacts Verified**: ${params.verifiedArtifactCount} / ${params.stages.length}`);
  lines.push("*Tip: Run `/toolflow rollback` to revert current stage changes.*");

  return lines.join("\n");
}

export function renderUnicodeDAG(
  stages: BlueprintStage[],
  options?: {
    currentStageIndex?: number;
    width?: number;
    theme?: UiThemeLike;
  }
): string[] {
  if (!stages || stages.length === 0) return [];
  const theme = options?.theme || DEFAULT_THEME;
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

    const headerTitle = `[Stage ${i + 1}] ${stage.title}`;
    const headerLine = isCurrent
      ? `${statusNode} ${theme.bold(theme.fg("accent", headerTitle))}`
      : `${statusNode} ${theme.bold(headerTitle)}`;

    lines.push(headerLine);
    lines.push(`  ├─ [Artifact]  ${theme.fg("accent", stage.expectedArtifact)}`);

    if (stage.dependsOn && stage.dependsOn.length > 0) {
      lines.push(`  ├─ [Depends]   ${theme.fg("warning", stage.dependsOn.join(", "))}`);
    }

    const boundAll = [
      ...(stage.boundCapabilities?.extensions ?? []),
      ...(stage.boundCapabilities?.skills ?? []),
      ...(stage.boundCapabilities?.prompts ?? []),
    ].filter(Boolean);

    const tailLine =
      boundAll.length > 0
        ? `  └─ [Ecosystem] ${theme.fg("success", boundAll.map(formatCapabilityBadge).join(" "))}`
        : `  └─ [Tools]     ${theme.fg("dim", formatCompactToolList(stage.allowedTools, 6))}`;

    lines.push(tailLine);

    if (i < stages.length - 1) {
      lines.push("  │");
    }
  }

  return lines;
}

export function renderCompactEcosystemOverview(tax: EcosystemTaxonomy): string {
  const formatItems = (items: CapabilityItem[]): string =>
    items.length > 0 ? items.map(i => `\`${i.name}\``).join(" ") : "none";

  const l1 = formatItems(tax.extensions.filter(e => e.layer === "L1_UTILITY"));
  const l2 = formatItems(tax.extensions.filter(e => e.layer === "L2_PERCEPTION"));
  const l3 = formatItems(tax.extensions.filter(e => e.layer === "L3_ORCHESTRATION"));
  const l4 = formatItems(tax.extensions.filter(e => e.layer === "L4_REVIEW_GUARD"));

  return [
    "### Installed Ecosystem Capabilities (0-Token Memory Index)",
    `- **Utility Tools**: ${l1}`,
    `- **Search & Perception**: ${l2}`,
    `- **Orchestration**: ${l3}`,
    `- **Quality & Review**: ${l4}`,
    `- **Skills**: ${formatItems(tax.skills)}`,
    `- **Prompt Templates**: ${formatItems(tax.prompts)}`,
    "> Tip: Run `/toolflow <task>` to generate a staged execution blueprint.",
  ].join("\n");
}

export function renderBlueprintSummary(bp: Blueprint): string {
  const lines: string[] = [];
  lines.push(`## [Execution Blueprint] ${bp.task}`);
  lines.push(`**Blueprint ID**: \`${bp.blueprintId}\``);
  lines.push("\n### Stage Topology & Physical Artifacts\n");

  const dagLines = renderUnicodeDAG(bp.stages, {
    theme: {
      bold: (s: string) => s,
      fg: (_color: string, s: string) => s,
    },
  });
  lines.push("```text");
  lines.push(...dagLines);
  lines.push("```");

  lines.push("\n### Stage Specifications");
  lines.push("| Stage | Capabilities | Expected Artifact | Allowed Tools |");
  lines.push("| :--- | :--- | :--- | :--- |");

  for (let i = 0; i < bp.stages.length; i++) {
    const stage = bp.stages[i];
    const bound = [
      ...(stage.boundCapabilities?.extensions ?? []),
      ...(stage.boundCapabilities?.skills ?? []),
      ...(stage.boundCapabilities?.prompts ?? []),
    ].filter(Boolean);
    const boundAll =
      bound.length > 0 ? bound.map(b => `\`${formatCapabilityBadge(b)}\``).join(" ") : "`@base`";
    const compactTools = formatCompactToolList(stage.allowedTools, 6);

    lines.push(
      `| **${i + 1}. ${stage.title}** | ${boundAll} | \`${stage.expectedArtifact}\` | \`${compactTools}\` |`
    );
  }

  if (bp.tokenEfficiencySummary && bp.tokenEfficiencySummary.trim()) {
    lines.push("\n### Selected Decisions");
    lines.push(bp.tokenEfficiencySummary);
  }

  return lines.join("\n");
}
