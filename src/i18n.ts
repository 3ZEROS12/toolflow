// i18n helper: System locale detection and dictionary for ToolFlow
// Follows minimal, zero-overhead runtime pattern:
// Default language is English. Automatically switches to Chinese only if system locale is Chinese.

export const isZh = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("zh");

export const t = {
  // Common notifications
  analyzingTask: (task: string) =>
    isZh ? `正在分析「${task}」工程结构与阶段计划...` : `Analyzing "${task}" and generating stage plan...`,
  cancelled: isZh ? "已取消任务执行。" : "Task execution cancelled.",
  noDecision: isZh ? "未选择方案，已退出。" : "No option selected. Exited.",
  resetSuccess: isZh
    ? "[OK] 已清除当前项目的工作状态与缓存记录。"
    : "[OK] Cleared active task state and caches.",
  exportNoBlueprint: isZh
    ? "当前没有正在执行的计划可供导出。可运行 /toolflow <任务>。"
    : "No active plan to export. Run `/toolflow <task>` first.",
  exportSuccess: (path: string) =>
    isZh ? `[OK] 计划已保存至: ${path}` : `[OK] Plan exported to: ${path}`,
  exportFailed: (msg: string) =>
    isZh ? `导出失败: ${msg}` : `Export failed: ${msg}`,
  statusNoBlueprint: isZh
    ? "当前无进行中的任务，可运行 /toolflow <任务> 启动。"
    : "No active task. Run `/toolflow <task>` to start.",
  prefillNotice: (cmd: string) =>
    isZh ? `已将模板 ${cmd} 填入输入框` : `Template "${cmd}" loaded into input.`,
  stageVerified: (stageIdx: number, file: string, sha: string) =>
    isZh
      ? `[阶段 ${stageIdx} 完成] 已生成 ${file} (SHA: ${sha}...)`
      : `[Stage ${stageIdx} Done] Created ${file} (SHA: ${sha}...)`,
  allCompleted: (task: string) =>
    isZh
      ? `⌬ 任务「${task}」全部阶段执行完毕，产物校验通过。`
      : `⌬ Task "${task}" completed! All files verified.`,
  circuitBroken: (stageIdx: number, file: string) =>
    isZh
      ? `[暂停] 阶段 ${stageIdx} 连续 3 次未检测到产物，请检查 ${file} 或运行 /toolflow rollback。`
      : `[Paused] Stage ${stageIdx} stopped after 3 attempts without target file. Check ${file} or run /toolflow rollback.`,

  // Command descriptions
  cmdMainDesc: isZh
    ? "任务阶段规划与 Prompt 模板工作台 (/toolflow <任务>, 支持 rollback/reset/export)"
    : "Task staging runner & prompt template workbench (/toolflow <task>)",
  cmdRollbackArgDesc: isZh ? "撤销当前阶段修改并回退快照" : "Rollback code changes to stage snapshot",
  cmdResetArgDesc: isZh ? "清除当前任务状态与临时缓存" : "Reset and clear active workflow state",
  cmdStatusArgDesc: isZh ? "查看当前阶段流水线看板" : "View current stage pipeline status",
  cmdExportArgDesc: isZh ? "导出阶段计划为 Markdown" : "Export active stage plan to Markdown",
  cmdRollbackShortcutDesc: isZh ? "撤销当前阶段修改并回退快照 (快捷方式)" : "Rollback changes and restore stage snapshot (shortcut)",
  cmdSopDesc: isZh ? "查看当前阶段执行状态 (/toolflow status 别名)" : "View current stage execution status (/toolflow status alias)",

  // TUI Labels & Help
  workbenchTitle: isZh ? "PROMPT 模板库" : "PROMPT WORKBENCH",
  workbenchSub: isZh
    ? "[Enter] 输入任务拆解阶段  [p] 填入选中模板  [c] 新建模板"
    : "[Enter] Input task  [p] Load template  [c] New template",
  decisionTitle: isZh ? "任务方案选择" : "OPTIONS",
  navHelp: isZh
    ? "[←/→] 切换  [1-4] 选择  [e] 补充要求  [a] 直接开始  [Esc] 取消"
    : "[←/→] Toggle  [1-4] Select  [e] Notes  [a] Quick run  [Esc] Cancel",
  resumedStage: (stage: number | string, title: string) =>
    isZh ? `恢复进度: 阶段 ${stage} (${title})` : `Resumed: Stage ${stage} (${title})`,
  cleaningOldTask: isZh
    ? "清理旧任务，准备初始化新任务..."
    : "Resetting state for new task...",
  prefilledPrompt: (cmd: string) =>
    isZh ? `已填入模板: ${cmd}` : `Template loaded: ${cmd}`,
  contextDehydrated: isZh
    ? "⚡ 会话上下文已精简压缩"
    : "⚡ Session context compacted.",
  toolOutputDehydrated: (tool: string, lines: number, tokens: number) =>
    isZh
      ? `⚡ [ToolFlow] 已归档 ${tool} 冗长输出 (${lines} 行)，节约 ~${tokens} Tokens`
      : `⚡ [ToolFlow] Archived ${tool} verbose output (${lines} lines), saved ~${tokens} tokens`,
  compactNotice: (tokensSaved?: number) => {
    if (tokensSaved) {
      return isZh
        ? `⚡ [ToolFlow] 阶段历史已脱水封存，已释放 ~${tokensSaved} Tokens`
        : `⚡ [ToolFlow] Stage history compacted, ~${tokensSaved} tokens released`;
    }
    return isZh
      ? "⚡ [ToolFlow] 阶段历史已脱水封存"
      : "⚡ [ToolFlow] Stage history compacted";
  },
};
