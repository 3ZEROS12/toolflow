# ToolFlow ⌬

> Organize your installed tools into focused pipelines to hit complex goals.  
> Dynamic capability orchestration, log dehydration to disk, and built-in prompt workbench.

[English](README.md) | [简体中文](README_zh.md)

---

## Why ToolFlow?

When developing software with AI coding agents equipped with dozens of tools, plugins, and MCP servers, three systemic frictions emerge:

1. **Tool Overload & Misdirection**: Exposing 40+ tool definitions simultaneously overwhelms the LLM. Asking for a simple utility function prompts the model to spin up a browser or query a database because its tool selection entropy is too high.
2. **Context Blowout from Verbose Logs**: Running test suites or builds often outputs hundreds or thousands of lines. Flooding the context window with raw stack traces burns tokens, dilutes attention, and rapidly triggers premature context compaction.
3. **Template Scramble**: Developers constantly copy-paste prompt templates from notes, web browsers, or chat history, interrupting the terminal development flow.

**ToolFlow brings discipline to the agent's toolbox**:
- **Stage-Gated Capability Mounting**: Native core tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) remain accessible at all times; heavy external MCPs, browser controllers, and subagents mount only in phases where they are strictly needed.
- **Real-Time Log Dehydration (-95% Overhead)**: Long tool outputs (>40 lines) are automatically archived to disk (`.pi/toolflow/runs/...`), passing only the exit code, root failure summary, and on-disk file path to the model.
- **Built-in Prompt Workbench**: Summon an instant terminal teleprompter with `/toolflow` to insert battle-tested prompts directly into your editor with zero planning ceremony.
- **Guaranteed Cleanup**: Upon task completion or `/toolflow reset`, tool definitions are restored to their original clean state.

---

> **Scope**: Designed for multi-tool, multi-MCP orchestration on complex tasks. For trivial single-file edits, stock Pi is sufficient. For multi-phase workflows, ToolFlow takes command.

---

## Installation

Install directly via the Pi package manager:

```bash
pi install npm:toolflow
```

Or install from git:
```bash
pi install git:github.com/3ZEROS12/toolflow
```

---

## Core Capabilities

### 1. Dynamic Ecosystem Mounting (Persistent Core, Stage-Gated Advanced Tools)
Instead of exposing your entire heavyweight tool catalog at all times, ToolFlow keeps the developer workflow smooth and focused:
- **Persistent Core Tools**: Standard development tools (`read`, `edit`, `write`, `bash`, `grep`, `find`, `ls`) remain accessible at all times to prevent workflow lockups.
- **Stage-Gated Advanced Capabilities**: Heavy external MCPs, browser controllers, dynamic workflows, and subagents are dynamically mounted only in relevant phases, keeping prompts focused and eliminating token bloat.

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

### 5. Production Craftsmanship & Aesthetics Guard
Prevents the LLM from outputting "toy-grade, functionally running but visually hideous" deliverables:
- **Hard Guardrails on UI & Visuals**: Explicitly bans bare unstyled elements, crude monochrome placeholder rectangles, and naive sketch lines. Mandates professional color palettes (primary, secondary, accent, layered dark/light backgrounds), 8px grid spacing, and typographic hierarchy.
- **Polished Vector Assets**: Requires clean vector SVG artwork or standard icon systems (e.g. Lucide/Tailwind-style icons) instead of simplistic squares or primitives acting as mock UI assets.
- **Smooth Micro-Interactions**: Enforces transition states, hover/focus elevation, subtle shadows, and interactive feedback across all interactive components.
- **Decoupled Architecture & Real Unit Tests**: Pure business/game logic remains strictly decoupled from rendering, backed by executable unit tests for reliable, production-ready deliverables.

### 6. Lightweight Companion: Instant Prompt Teleprompter (Zero-Planning Required)
Don't need a heavy multi-stage workflow for a small task? ToolFlow doubles as your everyday **instant prompt teleprompter and template workbench**:
- **Zero-Friction Teleprompter Mode**: Simply hit `/toolflow` without arguments to summon the teleprompter overlay. Browse your collection with arrow keys and hit `[p]` to immediately insert the highlighted prompt directly into your terminal input. **Instant pick-and-go—no complex planning phase triggered**.
- **Global & Local Auto-Discovery**: Automatically indexes all local and global `prompts/*.md` templates, sorted by recent activity, freeing you from digging through notes or clipboard history.
- **On-the-Fly Template Capture**: Hit `[c]` to author new markdown templates right inside the terminal, complete with optional LLM-assisted command tags and summaries.

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
