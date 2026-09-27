// Unified English dictionary for ToolFlow TUI & notifications

export const isZh = false;

export const t = {
  // Common notifications
  analyzingTask: (task: string) => `Analyzing "${task}" and generating stage plan...`,
  cancelled: "Task execution cancelled.",
  noDecision: "No option selected. Exited.",
  resetSuccess: "[OK] Cleared active task state and caches.",
  exportNoBlueprint: "No active plan to export. Run `/toolflow <task>` first.",
  exportSuccess: (path: string) => `[OK] Plan exported to: ${path}`,
  exportFailed: (msg: string) => `Export failed: ${msg}`,
  statusNoBlueprint: "No active task. Run `/toolflow <task>` to start.",
  prefillNotice: (cmd: string) => `Template "${cmd}" loaded into input.`,
  stageVerified: (stageIdx: number, file: string, sha: string) =>
    `[Stage ${stageIdx} Done] Created ${file} (SHA: ${sha}...)`,
  allCompleted: (task: string) => `⌬ Task "${task}" completed! All files verified.`,
  circuitBroken: (stageIdx: number, file: string) =>
    `[Paused] Stage ${stageIdx} stopped after 3 attempts without target file. Check ${file} or run /toolflow rollback.`,

  // Command descriptions
  cmdMainDesc: "Task staging runner & prompt template workbench (/toolflow <task>)",
  cmdRollbackArgDesc: "Rollback code changes to stage snapshot",
  cmdResetArgDesc: "Reset and clear active workflow state",
  cmdStatusArgDesc: "View current stage pipeline status",
  cmdExportArgDesc: "Export active stage plan to Markdown",
  cmdRollbackShortcutDesc: "Rollback changes and restore stage snapshot (shortcut)",
  cmdSopDesc: "View current stage execution status (/toolflow status alias)",

  // TUI Labels & Help
  workbenchTitle: "PROMPT WORKBENCH",
  workbenchSub: "[Enter] Input task  [p] Load template  [+] New template",
  decisionTitle: "OPTIONS",
  navHelp: "[←/→] Toggle  [1-4] Select  [e] Notes  [a] Quick run  [Esc] Cancel",

  resumedStage: (stage: number | string, title: string) => `Resumed: Stage ${stage} (${title})`,
  cleaningOldTask: "Resetting state for new task...",
  prefilledPrompt: (cmd: string) => `Template loaded: ${cmd}`,
  contextDehydrated: "⚡ Session context compacted.",
  toolOutputDehydrated: (tool: string, lines: number, tokens: number) =>
    `⚡ [ToolFlow] Archived ${tool} verbose output (${lines} lines), saved ~${tokens} tokens`,
  readCacheHitNotice: (file: string, tokens: number) =>
    `⚡ [ToolFlow Read Cache] ${file} unchanged, hit cache saved ~${tokens} tokens`,
  compactNotice: (tokensSaved?: number) => {
    if (tokensSaved) {
      return `⚡ [ToolFlow] Stage history compacted, ~${tokensSaved} tokens released`;
    }
    return "⚡ [ToolFlow] Stage history compacted";
  },
};
