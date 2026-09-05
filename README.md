# ToolFlow ⌬

> Stage-based task runner and prompt template manager for Pi.

[English](README.md) | [简体中文](README_zh.md)

ToolFlow is a lightweight Pi extension focused on two things:
1. **Stage-based execution**: Breaks a task into clear implementation stages, verifies required files at each step, and supports instant git-based rollback if a stage fails.
2. **Prompt template manager**: Browse, prefill, and create local prompt templates (`prompts/*.md`) inside an interactive terminal UI.

---

## Installation

Install directly via git:

```bash
pi install git:github.com/3ZEROS12/toolflow
```

---

## What It Does

### 1. Stage-Based Execution
- **Realistic file targets**: Accurately determines target files based on your project (e.g. `src/index.ts`, `main.py`, or CLI scripts) instead of defaulting to `index.html`.
- **Deliverable checks**: Automatically verifies required artifacts before proceeding to the next stage.
- **Instant rollback**: Run `/toolflow rollback` anytime to revert changes made during the current stage.

### 2. Prompt Template Manager
Run `/toolflow` without arguments to open the prompt workbench:
- **Browse templates**: Lists all local and global `prompts/*.md` templates, sorted by recent activity.
- **Prefill to editor**: Press `[p]` to load a template directly into the input bar.
- **Create new templates**: Press `[c]` to create a new `.md` prompt template inline.

---

## Commands

| Command | Description |
| :--- | :--- |
| `/toolflow` | Open the prompt template browser and task input UI |
| `/toolflow <task>` | Create and run a stage plan for the task |
| `/toolflow status` | View current stage pipeline status (alias: `/sop`) |
| `/toolflow rollback` | Revert code changes back to the pre-stage snapshot |
| `/toolflow-rollback` | Shortcut for `/toolflow rollback` |
| `/toolflow reset` | Clear active task state and temporary files |
| `/toolflow export` | Export the current stage plan to `BLUEPRINT.md` |

---

## Keybindings

- `[Enter]`: Input task and generate stage plan
- `[p]`: Load highlighted prompt template into input
- `[c]`: Create new prompt template
- `[1-4]` / `[←/→]`: Select options in the configuration prompt
- `[Esc]`: Cancel / Exit

---

## License

MIT © [Jason](https://github.com/3ZEROS12)
