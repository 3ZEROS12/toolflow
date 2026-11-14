import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  parseKey,
  visibleWidth,
  wrapTextWithAnsi,
  type TUI,
} from "@earendil-works/pi-tui";
import type {
  ArchitectNavigatorResult,
  DecisionSlot,
  EcosystemTaxonomy,
  TaskDiagnosis,
  TaskRequirementChoice,
} from "../core/types.js";
import { diagnoseTaskExecutionMode } from "../planner/router.js";
import { PromptsManager, type PromptItemInfo } from "../planner/prompts-manager.js";
import type { LlmModelRuntime } from "../planner/taxonomy.js";

type NavigatorState =
  | "overview"
  | "input"
  | "deciding"
  | "refining"
  | "custom_option_input"
  | "outline_confirm"
  | "add_prompt_name"
  | "add_prompt_desc"
  | "add_prompt_content";

interface CustomUiTheme {
  fg: (color: string, text: string) => string;
  bg?: (color: string, text: string) => string;
  bold: (text: string) => string;
}

interface CustomUiTui {
  terminal?: { rows: number; columns: number };
  requestRender: () => void;
}

export interface CustomUiHost {
  custom: <T>(
    factory: (
      tui: CustomUiTui,
      theme: CustomUiTheme,
      keybindings: unknown,
      done: (result: T) => void
    ) => {
      focused: boolean;
      invalidate: () => void;
      render: (width: number) => string[];
      handleInput: (data: string) => void;
    }
  ) => Promise<T>;
}

function getOptionEcoItems(opt: TaskRequirementChoice): string[] {
  const rec = opt.recommendedEcosystem;
  if (!rec) return [];
  const rawList = [...(rec.extensions ?? []), ...(rec.skills ?? []), ...(rec.prompts ?? [])];
  return rawList.filter(name => {
    const trimmed = (name || "").trim();
    return trimmed !== "" && trimmed !== "ecosystem-plugin";
  });
}

function getInitialOptionIndex(slot?: DecisionSlot): number {
  if (!slot?.options) return 0;
  const recIdx = slot.options.findIndex(o => o.isRecommended);
  return recIdx >= 0 ? recIdx : 0;
}

/**
 * Interactive Prompt Workbench & Staged Blueprint Decision Navigator (`ctx.ui.custom`).
 */
export async function openArchitectNavigator(
  ui: CustomUiHost,
  _taxonomy: EcosystemTaxonomy,
  initialTask: string = "",
  slots?: DecisionSlot[],
  diagnosis?: TaskDiagnosis,
  ctx?: LlmModelRuntime & { cwd?: string }
): Promise<ArchitectNavigatorResult> {
  const activeCwd = ctx?.cwd || process.cwd();
  let factoryMounted = false;

  const result = await ui.custom<ArchitectNavigatorResult>((tui, theme, _keybindings, done) => {
    factoryMounted = true;
    let promptsList: PromptItemInfo[] = PromptsManager.scanAllPrompts(activeCwd);
    let promptTab: "recent" | "user" | "system" = "recent";
    let selectedPromptIdx = 0;
    let newPromptName = "";
    let newPromptDesc = "";
    let newPromptContent = "";

    let state: NavigatorState =
      slots && slots.length > 0 ? "deciding" : initialTask ? "input" : "overview";
    let inputTask = initialTask;
    let customRequirementsText = "";
    let newOptionTitle = "";
    let currentSlotIndex = 0;
    let cachedLines: string[] | undefined;

    const acceptedSparks = new Set<string>(
      (diagnosis?.architectSparks ?? [])
        .filter(s => s.isAcceptedByDefault)
        .map(s => s.id)
    );

    const safeSlots = Array.isArray(slots) ? slots : [];
    let selectedOptionIndex = getInitialOptionIndex(safeSlots[0]);
    const userDecisions: Record<string, string> = {};
    let selectedPlan: "A" | "B" = diagnosis?.tradeOff?.recommendedPlan ?? "B";

    const editorTheme: EditorTheme = {
      borderColor: (s: string) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (txt: string) => theme.fg("accent", txt),
        selectedText: (txt: string) => theme.fg("accent", txt),
        description: (txt: string) => theme.fg("muted", txt),
        scrollInfo: (txt: string) => theme.fg("dim", txt),
        noMatch: (txt: string) => theme.fg("warning", txt),
      },
    };

    // Pi's custom-UI host always supplies a full TUI; this shim only narrows the surface used here.
    const tuiForEditor = (tui.terminal
      ? tui
      : { ...tui, terminal: { rows: 24, columns: 80 }, requestRender: () => tui.requestRender() }
    ) as unknown as TUI;

    const editor = new Editor(tuiForEditor, editorTheme);
    editor.focused = true;
    if (initialTask) {
      editor.setText(initialTask);
    }

    function rerender(): void {
      cachedLines = undefined;
      tui.requestRender();
    }

    function enterEditorState(nextState: NavigatorState, initialVal: string = ""): void {
      state = nextState;
      editor.setText(initialVal);
      editor.focused = true;
      rerender();
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

    function getFilteredPrompts(): PromptItemInfo[] {
      if (promptTab === "recent") {
        return PromptsManager.getRecentPrompts(promptsList, 5);
      }
      if (promptTab === "user") {
        return promptsList.filter(p => p.category === "user");
      }
      return promptsList.filter(p => p.category === "system");
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
        if (trimmed) done({ kind: "task_input", task: trimmed });
      } else if (state === "add_prompt_content") {
        newPromptContent = trimmed;
        if (newPromptContent) enterEditorState("add_prompt_name", newPromptName);
      } else if (state === "add_prompt_name") {
        newPromptName = trimmed;
        if (newPromptName) enterEditorState("add_prompt_desc", newPromptDesc);
      } else if (state === "add_prompt_desc") {
        newPromptDesc = trimmed;
        if (newPromptName.trim() && newPromptContent.trim()) {
          PromptsManager.addUserPrompt(
            newPromptName.trim(),
            newPromptDesc || newPromptName.trim(),
            newPromptContent.trim()
          );
          promptsList = PromptsManager.scanAllPrompts(activeCwd);
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
              label: `[+] ${newOptionTitle}`,
              description: "",
              isRecommended: false,
              recommendedEcosystem: { extensions: [], reason: "Custom" },
            };
            currentSlot.options.push(newOpt);
            selectedOptionIndex = currentSlot.options.length - 1;
          }
        }
        state = "deciding";
        rerender();
      }
    };

    return {
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

        const addWrapped = (text: string): void => {
          lines.push(...wrapTextWithAnsi(text, renderWidth));
        };

        const addWrappedWithPrefix = (prefix: string, text: string): void => {
          const prefixWidth = visibleWidth(prefix);
          if (prefixWidth >= renderWidth) {
            addWrapped(prefix + text);
            return;
          }
          const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
          const contPrefix = " ".repeat(prefixWidth);
          for (let i = 0; i < wrapped.length; i++) {
            lines.push(`${i === 0 ? prefix : contPrefix}${wrapped[i]}`);
          }
        };

        const renderEditorBlock = (): void => {
          for (const line of editor.render(Math.max(10, renderWidth - 2))) {
            lines.push(` ${line}`);
          }
        };

        lines.push(theme.fg("accent", "─".repeat(renderWidth)));

        if (state === "overview") {
          addWrappedWithPrefix(" ", titleColor("ToolFlow Workbench"));
          addWrappedWithPrefix(
            " ",
            `${theme.fg("success", theme.bold("> [Enter / i] Start New Task"))}   ${theme.fg(
              "dim",
              "(or run /toolflow <task>)"
            )}`
          );
          lines.push("");

          const currentFiltered = getFilteredPrompts();
          const tabRecent =
            promptTab === "recent"
              ? theme.bg?.("selectedBg", theme.fg("text", " ● Recent ")) ?? theme.fg("text", " ● Recent ")
              : theme.fg("muted", " ○ Recent ");
          const tabUser =
            promptTab === "user"
              ? theme.bg?.("selectedBg", theme.fg("text", " ● Custom ")) ?? theme.fg("text", " ● Custom ")
              : theme.fg("muted", " ○ Custom ");
          const tabSystem =
            promptTab === "system"
              ? theme.bg?.("selectedBg", theme.fg("text", " ● Built-in ")) ?? theme.fg("text", " ● Built-in ")
              : theme.fg("muted", " ○ Built-in ");
          addWrappedWithPrefix(" ", `${tabRecent} ${tabUser} ${tabSystem} ${theme.fg("dim", "(Tab)")}`);
          lines.push("");

          if (currentFiltered.length === 0) {
            addWrappedWithPrefix("   ", theme.fg("dim", "(empty — press Tab or +)"));
          } else {
            const windowSize = 5;
            let startIdx = 0;
            if (currentFiltered.length > windowSize) {
              if (selectedPromptIdx < windowSize) {
                startIdx = 0;
              } else if (selectedPromptIdx >= currentFiltered.length - 1) {
                startIdx = currentFiltered.length - windowSize;
              } else {
                startIdx = Math.min(
                  currentFiltered.length - windowSize,
                  selectedPromptIdx - Math.floor(windowSize / 2)
                );
              }
            }
            const visiblePrompts = currentFiltered.slice(startIdx, startIdx + windowSize);
            if (startIdx > 0) addWrappedWithPrefix("   ", theme.fg("dim", `▲ +${startIdx} (↑)`));

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
                    ? theme.fg("warning", "[proj]")
                    : theme.fg("success", "[user]")
                  : theme.fg("dim", "[sys]");
              const descStr = p.description ? theme.fg("muted", p.description) : "";
              addWrappedWithPrefix(` ${cursor}`, `${cmdStr} ${tag} ${descStr}`);
            });

            if (startIdx + windowSize < currentFiltered.length) {
              addWrappedWithPrefix(
                "   ",
                theme.fg("dim", `▼ +${currentFiltered.length - (startIdx + windowSize)} (↓)`)
              );
            }

            const selectedItem = currentFiltered[selectedPromptIdx];
            if (selectedItem) {
              lines.push("");
              const previewLines = PromptsManager.getPromptPreviewLines(selectedItem.filePath, 3);
              for (const pl of previewLines) {
                addWrappedWithPrefix("     ", theme.fg("dim", pl));
              }
            }
          }

          lines.push("");
          addWrappedWithPrefix(
            " ",
            theme.fg("dim", "Enter/i new task • p load template • + new template • d delete • Esc exit")
          );
        } else if (state === "add_prompt_content") {
          addWrappedWithPrefix(" ", titleColor("New Template (1/3): Content"));
          lines.push("");
          renderEditorBlock();
          lines.push("");
          addWrappedWithPrefix(" ", theme.fg("dim", "Enter next • Ctrl+L AI auto-name • Esc back"));
        } else if (state === "add_prompt_name") {
          addWrappedWithPrefix(" ", titleColor("New Template (2/3): /command-name"));
          lines.push("");
          renderEditorBlock();
          lines.push("");
          addWrappedWithPrefix(" ", theme.fg("dim", "Enter next • Esc back"));
        } else if (state === "add_prompt_desc") {
          addWrappedWithPrefix(" ", titleColor(`New Template (3/3): /${newPromptName} Description`));
          lines.push("");
          renderEditorBlock();
          lines.push("");
          addWrappedWithPrefix(" ", theme.fg("dim", "Enter save • Esc back"));
        } else if (state === "input") {
          addWrappedWithPrefix(" ", titleColor("Task Objective"));
          lines.push("");
          renderEditorBlock();
          lines.push("");

          const taskRoute = diagnoseTaskExecutionMode(inputTask);
          const routeBadge =
            taskRoute.mode === "fast"
              ? theme.fg("success", "Fast-Track (1-step)")
              : theme.fg("accent", "Staged Blueprint");
          addWrappedWithPrefix(" ", `${theme.fg("dim", "Mode:")} ${routeBadge}`);
          addWrappedWithPrefix(" ", theme.fg("dim", "Enter start • Esc back"));
        } else if (state === "deciding") {
          const currentSlot = safeSlots[currentSlotIndex];
          if (!currentSlot) return [];

          const tabA =
            selectedPlan === "A"
              ? theme.bg?.("selectedBg", theme.fg("text", " [A: 2-Stage Agile] ")) ?? theme.fg("text", " [A: 2-Stage Agile] ")
              : theme.fg("dim", " A: 2-Stage Agile ");
          const tabB =
            selectedPlan === "B"
              ? theme.bg?.("selectedBg", theme.fg("text", " [B: 3-Stage Modular] ")) ?? theme.fg("text", " [B: 3-Stage Modular] ")
              : theme.fg("dim", " B: 3-Stage Modular ");

          addWrappedWithPrefix(
            " ",
            `${theme.fg("accent", theme.bold(inputTask || "Task"))}  ${tabA}${tabB} ${theme.fg("dim", "(Tab)")}`
          );
          lines.push("");

          const slotQuestion = currentSlot.question ? ` · ${currentSlot.question}` : "";
          addWrappedWithPrefix(
            " ",
            `[${currentSlotIndex + 1}/${safeSlots.length}] ${theme.bold(
              theme.fg("accent", currentSlot.title || "Option")
            )}${theme.fg("muted", slotQuestion)}`
          );
          lines.push("");

          currentSlot.options.forEach((opt, idx) => {
            const isSel = idx === selectedOptionIndex;
            const prefix = isSel ? theme.fg("accent", "> ") : "  ";
            const recMark = opt.isRecommended ? " ★" : "";
            addWrappedWithPrefix(` ${prefix}`, theme.fg(isSel ? "accent" : "text", `${idx + 1}. ${opt.label}${recMark}`));
            if (opt.description) {
              addWrappedWithPrefix("      ", theme.fg("muted", opt.description));
            }
            if (isSel) {
              const ecoItems = getOptionEcoItems(opt);
              if (ecoItems.length > 0) {
                addWrappedWithPrefix(
                  "      ",
                  ecoItems.map(n => theme.fg("accent", `[@${n}]`)).join(" ")
                );
              }
            }
          });

          const sparks = diagnosis?.architectSparks ?? [];
          if (sparks.length > 0) {
            lines.push("");
            for (const spark of sparks) {
              const tag = acceptedSparks.has(spark.id)
                ? theme.fg("success", "[x]")
                : theme.fg("dim", "[ ]");
              addWrappedWithPrefix(
                "   ",
                `${tag} ${theme.bold(spark.title)}: ${theme.fg("muted", spark.description)} ${theme.fg("dim", "(s)")}`
              );
            }
          }

          lines.push("");
          addWrappedWithPrefix(
            " ",
            theme.fg("dim", "↑↓/1-3 select • Enter next • a quick-run • e note • + custom • Esc back")
          );
        } else if (state === "outline_confirm") {
          addWrappedWithPrefix(
            " ",
            titleColor(`Blueprint Ready (${selectedPlan === "A" ? "2-Stage Agile" : "3-Stage Modular"})`)
          );
          lines.push("");
          addWrappedWithPrefix(" ", theme.fg("accent", inputTask || "Task"));
          if (customRequirementsText.trim()) {
            addWrappedWithPrefix(" ", theme.fg("warning", `+ ${customRequirementsText.trim()}`));
          }
          lines.push("");
          if (selectedPlan === "A") {
            addWrappedWithPrefix("   ", "1. Core Implementation");
            addWrappedWithPrefix("   ", "2. Test & Verification Gate");
          } else {
            addWrappedWithPrefix("   ", "1. Interface & Scope Design");
            addWrappedWithPrefix("   ", "2. Modular Implementation & Tests");
            addWrappedWithPrefix("   ", "3. Read-Only Diff Review & Gate");
          }
          lines.push("");
          addWrappedWithPrefix(" ", theme.fg("dim", "Enter launch • Esc back"));
        } else if (state === "refining") {
          addWrappedWithPrefix(" ", titleColor("Add Note / Constraint"));
          lines.push("");
          renderEditorBlock();
          lines.push("");
          addWrappedWithPrefix(" ", theme.fg("dim", "Enter save • Esc cancel"));
        } else if (state === "custom_option_input") {
          addWrappedWithPrefix(
            " ",
            titleColor(`Custom Option: ${safeSlots[currentSlotIndex]?.title || ""}`)
          );
          lines.push("");
          renderEditorBlock();
          lines.push("");
          addWrappedWithPrefix(" ", theme.fg("dim", "Enter add • Esc cancel"));
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
            PromptsManager.autoTagPromptWithLLM(newPromptContent, ctx).then(res => {
              newPromptName = res.name;
              newPromptDesc = res.description;
              enterEditorState("add_prompt_desc", newPromptDesc);
            });
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
            promptTab = promptTab === "recent" ? "user" : promptTab === "user" ? "system" : "recent";
            selectedPromptIdx = 0;
            rerender();
          } else if (isUp && selectedPromptIdx > 0) {
            selectedPromptIdx--;
            rerender();
          } else if (isDown && selectedPromptIdx < currentFiltered.length - 1) {
            selectedPromptIdx++;
            rerender();
          } else if (key === "d" || key === "delete") {
            const sel = currentFiltered[selectedPromptIdx];
            if (sel && sel.category === "user" && PromptsManager.deleteUserPrompt(sel.filePath)) {
              promptsList = PromptsManager.scanAllPrompts(activeCwd);
              const updated = getFilteredPrompts();
              selectedPromptIdx = Math.min(selectedPromptIdx, Math.max(0, updated.length - 1));
              rerender();
            }
          } else if (key === "p") {
            const sel = currentFiltered[selectedPromptIdx];
            if (sel) {
              PromptsManager.recordPromptUsage(sel.command);
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
          return;
        }

        if (state === "deciding") {
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
            const sparks = diagnosis?.architectSparks ?? [];
            if (sparks.length > 0) {
              const unaccepted = sparks.find(sp => !acceptedSparks.has(sp.id));
              if (unaccepted) acceptedSparks.add(unaccepted.id);
              else acceptedSparks.clear();
              rerender();
            }
          } else if (key === "e") {
            enterEditorState("refining", customRequirementsText);
          } else if (data === "+" || data === "=") {
            newOptionTitle = "";
            enterEditorState("custom_option_input", "");
          } else if (key === "a") {
            for (const s of safeSlots) {
              const recOpt = s.options.find(o => o.isRecommended) ?? s.options[0];
              if (recOpt) userDecisions[s.slotId] = recOpt.id || recOpt.label || "";
            }
            userDecisions.__plan = "A";
            selectedPlan = "A";
            state = "outline_confirm";
            rerender();
          } else if (key === "1" && options.length >= 1) {
            selectedOptionIndex = 0;
            rerender();
          } else if (key === "2" && options.length >= 2) {
            selectedOptionIndex = 1;
            rerender();
          } else if (key === "3" && options.length >= 3) {
            selectedOptionIndex = 2;
            rerender();
          } else if (isUp && selectedOptionIndex > 0) {
            selectedOptionIndex--;
            rerender();
          } else if (isDown && selectedOptionIndex < options.length - 1) {
            selectedOptionIndex++;
            rerender();
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
          return;
        }

        if (state === "outline_confirm") {
          if (isEscape) {
            state = "deciding";
            rerender();
          } else if (isEnter) {
            const allCustomReqs: string[] = [];
            if (customRequirementsText.trim()) allCustomReqs.push(customRequirementsText.trim());
            for (const sp of diagnosis?.architectSparks ?? []) {
              if (acceptedSparks.has(sp.id)) {
                allCustomReqs.push(`[Spark] ${sp.title}: ${sp.impact}`);
              }
            }
            done({
              kind: "decisions",
              decisions: userDecisions,
              task: inputTask,
              selectedPlan,
              customRequirements: allCustomReqs.length > 0 ? allCustomReqs : undefined,
              customEcosystem: {
                enabledExtensions: [],
                enabledSkills: [],
                enabledPrompts: [],
              },
            });
          }
        }
      },
    };
  });

  if (!result && !factoryMounted) {
    return { kind: "custom_ui_unavailable" };
  }
  return result;
}
