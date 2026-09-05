# ToolFlow ⌬

> Dynamic Tool Sandbox & Context Dehydrator for Pi.  
> Stage-gated tool scoping, log dehydration to disk, and physical write guards.

[English](README.md) | [简体中文](README_zh.md)

---

### In 30 Seconds

**Q**: "I installed a dozen MCPs and plugins. Now the model picks the wrong tools, terminal commands dump hundreds of log lines, and my context window fills up fast."  
**A**: "Don't carry the whole workshop at once. Search tools for research, edit tools for coding, read-only tools for review. If a tool isn't needed right now, its schema stays out of the prompt."

**Q**: "What happens to verbose terminal output?"  
**A**: "Outputs over 40 lines save to disk. The model gets a short summary and a file path, saving thousands of tokens."

**Q**: "What happens when the task finishes?"  
**A**: "All original tools are restored without leftover state."

**Q**: "How do I run it?"  
**A**: "Run `/toolflow build feature X`. It handles the stages from there."

---

> **Scope**: Built for medium-to-large projects with multiple MCPs/plugins. For simple single-file fixes, stock Pi is fine. For multi-step, multi-tool work, ToolFlow manages tools and context.

---

## Installation

Install directly via git:

```bash
pi install git:github.com/3ZEROS12/toolflow
```

---

## Core Capabilities

### 1. Dynamic Tool Sandboxing (Stage-Gated Pruning)
Instead of exposing your entire tool catalog at all times, ToolFlow physically mounts only the relevant tool tier for each phase:
- **Research Phase**: Mounts perception & search tools (`read`, `grep`, `web_search`); unmounts mutation tools so the model cannot prematurely alter code.
- **Implementation Phase**: Mounts scoped editing tools (`write`, `edit`), unmounting distracting external tools to preserve attention and token budget.
- **Audit & Verification Phase**: The `ReviewIsolationGuard` actively blocks `write`, `edit`, and mutating commands, guaranteeing genuine read-only objective inspection.

### 2. 4-Tier Token Governance (-95% Context Overhead)
ToolFlow enforces four runtime barriers against context bloating:
- **Real-Time Tool Result Dehydration**: Whenever terminal outputs (`bash`/`powershell`) or fetch tools emit verbose logs (>40 lines or deep stacks), ToolFlow intercepts and archives them to disk in real-time (`.pi/toolflow/runs/...`). The context only retains concise physical head/tail summaries and the local file path.
- **Heavy Tool JIT Allocation**: Powered by deep LLM intent reasoning, heavy MCP tools are loaded just-in-time for stages that strictly require them, completely masking their hefty JSON schemas during unrelated phases.
- **Stage Boundary Compaction Contract**: Hooks into `session_before_compact` at stage transitions, stripping exploratory trials and reasoning chaff while handing off only verified on-disk artifact paths to downstream stages.
- **Transparent Feedback**: Listens for `session_compact` events to surface minimal, reassuring token reduction notices in your status line—eliminating monotonically growing context anxiety.

### 3. Strict Tool Lifecycle Snapshot & Restoration
ToolFlow snapshots active tools at startup. Upon stage completion, abrupt error, or manual `/toolflow reset`, the environment is 100% restored to its original catalog, preventing orphaned states.

### 4. Physical Blast Radius Guard
A runtime safety interceptor monitoring both native write tools and terminal commands (`bash`, `powershell`). Destructive overwrites, file removals, or shell redirections targeting sensitive assets (`.env*`, `.git*`, core locks) are physically blocked at the engine level.

### 5. Interactive Prompt Workbench
Run `/toolflow` without arguments to access an in-terminal template manager:
- **Instant Discovery**: Automatically discovers global and project-level `prompts/*.md`, sorted by recent use.
- **Zero-Friction Insertion**: Press `[p]` to prefill highlighted templates directly into your prompt bar.
- **On-the-Fly Authoring**: Press `[c]` to author new markdown templates inline without leaving your terminal.

---

## Commands

| Command | Description |
| :--- | :--- |
| `/toolflow` | Open the prompt workbench & task initialization cockpit |
| `/toolflow <task>` | Launch a sandboxed task with phase-gated toolchains |
| `/toolflow status` | Display active stage pipeline & mounted tool state (alias: `/sop`) |
| `/toolflow rollback` | Revert changes to the snapshot captured at the start of current stage |
| `/toolflow-rollback` | Direct shortcut for `/toolflow rollback` |
| `/toolflow reset` | Clear active execution state and flush dehydrated temp caches |
| `/toolflow export` | Export phase breakdown and architecture decisions to `BLUEPRINT.md` |

---

## Keybindings

- `[Enter]`: Input task and generate phase-governed plan
- `[p]`: Prefill highlighted prompt template into editor
- `[c]`: Create new prompt template inline
- `[1-4]` / `[←/→]`: Toggle architecture and toolchain options
- `[Esc]`: Exit / Close overlay

---

## License

MIT © [Jason](https://github.com/3ZEROS12)
