# ToolFlow ⌬

> Dynamic Tool Sandbox & Context Dehydrator for Pi.  
> Keep your LLM focused, slash context bloat by 95%, and enforce physical security barriers across complex toolchains.

[English](README.md) | [简体中文](README_zh.md)

When you install multiple MCPs, plugins, and CLI tools in Pi, the agent faces three critical bottlenecks that prompt engineering cannot solve:
1. **Tool Schema Bloat & Attention Dispersion**: Flooding the prompt with dozens of unused tool schemas wastes thousands of tokens per turn and causes the model to hallucinate or misuse tools.
2. **Context Contamination**: Raw exploratory logs and search output from early turns pollute subsequent coding sessions.
3. **Absence of Physical Guardrails**: Prompt rules cannot reliably prevent LLMs from accidentally modifying production `.env` files or tampering with code during what should be an objective "read-only audit".

**ToolFlow acts as an out-of-band execution governor for Pi.** It dynamically restricts the agent's tool surface to what is strictly needed at each phase, compresses cross-stage memory, and enforces hard runtime access controls.

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

### 2. Context Dehydration (-95% Token Overhead)
Large search outputs, file listings, and verbose compiler diagnostics are automatically archived to disk at stage boundaries. Downstream stages receive only structured topology summaries and verified artifact states, eliminating context baggage.

### 3. Physical Blast Radius Guard
A runtime safety interceptor monitoring both native write tools and terminal commands (`bash`, `powershell`). Destructive overwrites, file removals, or shell redirections targeting sensitive assets (`.env*`, `.git*`, core locks) are physically blocked at the engine level.

### 4. Interactive Prompt Workbench
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
