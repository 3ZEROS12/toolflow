# ToolFlow ⌬

> Organize your installed tools into focused pipelines to hit complex goals.  
> Dynamic capability orchestration, log dehydration to disk, and built-in prompt workbench.

[English](README.md) | [简体中文](README_zh.md)

---

### Office Chats: Sam and Alex at the Coffee Bar

> **Scene**: 3:30 PM Friday. Break room. Sam is staring at their laptop, looking exhausted with an oversized coffee. Alex walks over after wrapping up a PR.

**Sam** 😫: "Alex, I'm losing my mind. To build this new feature, I loaded up every MCP I could find—browser automation, DB query tools, docs search, code reviewers. But now the model acts like a drunk intern: I ask for a pure function and it tries to spin up Chromium; I ask for an error trace and it queries the production database. Run one test suite, and 2,000 lines of console output flood the context. On top of that, I'm constantly hunting through notes to find my favorite prompt templates..."

**Alex** ☕: "Haha, you strapped an entire hardware store to your back and wondered why you can't run. Having tools installed is useless if they aren't **organized to achieve your goal**. Aren't you using ToolFlow?"

**Sam** 😯: "Wait, how does it organize them?"

**Alex** 🛠️: "Think of it as a pragmatic, lazy architect on your team:
1. **Orchestrates Tools by Stage**: It breaks your task into phases. During exploration, it gives the model search tools and locks write permissions. During implementation, it hides unrelated heavy MCPs so the model stays razor-sharp and never misfires. During review, it physically strips edit privileges so the model can't secretly mutate code.
2. **Dehydrates Verbose Logs in Milliseconds**: Test threw 500 lines of stack trace? ToolFlow archives the full dump to disk, leaving only the return code, key failure summary, and file path in context. That saves tens of thousands of tokens.
3. **Built-in Prompt Workbench**: Hit `[p]` on startup to pick your battle-tested prompts right away, or press `[+]` to draft one on the fly. You can even press `Ctrl+L` and let the LLM auto-tag and summarize it. No more copy-pasting from scratch."

**Sam** 🤩: "What happens when the mission is done? Does it mess up my environment?"

**Alex** 🚀: "Not a chance. Everything resets back to your original native toolset cleanly. Just run `/toolflow build a user auth system` and watch it deploy the right tools at each step."

---

> **Scope**: Designed for multi-tool, multi-MCP orchestration on complex tasks. For trivial single-file edits, stock Pi is sufficient. For multi-phase workflows, ToolFlow takes command.

---

## Installation

Install directly via git:

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

### 6. Interactive Prompt Workbench
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
