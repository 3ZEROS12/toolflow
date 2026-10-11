# ToolFlow ⌬

Dynamic tool sandboxing & context dehydrator for Pi Coding Agent.

Stop tool overload and context bloat. Stage-gated capability mounting, automatic log dehydration to disk (-95% token overhead), protected-file write guard, and built-in prompt workbench.

[![npm version](https://img.shields.io/npm/v/toolflow?color=blue)](https://www.npmjs.com/package/toolflow)
[![npm downloads](https://img.shields.io/npm/dm/toolflow?color=22c55e&label=downloads)](https://www.npmjs.com/package/toolflow)
[![GitHub stars](https://img.shields.io/github/stars/3ZEROS12/toolflow?style=flat&color=f59e0b)](https://github.com/3ZEROS12/toolflow/stargazers)
[![Built for Pi](https://img.shields.io/badge/Built%20for-Pi%20Coding%20Agent-orange)](https://github.com/earendil-works/pi-coding-agent)
[![Tests: 26 Suites Pass](https://img.shields.io/badge/Tests-26%20Suites%20Pass%20(100%25)-brightgreen)](tests/test_suite.ts)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**English** | [日本語](./README_ja.md) | [简体中文](./README_zh.md)

<p align="center">
  <img src="assets/hero-en.svg" alt="ToolFlow Context Dehydrator &amp; Tool Sandboxing" width="820">
</p>

```text
  ┌─ Tool Overload (40+ tools & MCPs exposed simultaneously in System Prompt) ───────────┐
  │  read write edit bash browser_click mcp_query subagent_run git_reset ...             │
  │  [Result: Schema noise. Asking for a helper function prompts a browser launch]       │
  └──────────────────────────────────────────────────────────────────────────────────────┘
                                             │
                                             ▼
  ┌─ ToolFlow ⌬ Stage-Gated Sandboxing (-95% Context Overhead) ──────────────────────────┐
  │  Phase 1: Research  ❯ [read, grep, find, web_search]                                 │
  │  Phase 2: Implement ❯ [read, edit, write, bash] (Dehydrates verbose logs >40 lines)  │
  │  Phase 3: Review    ❯ [read, grep, bash (test-only)] (Write tools physically stripped)│
  └──────────────────────────────────────────────────────────────────────────────────────┘
```

## Quick Start

Install directly inside Pi:

```bash
pi install npm:toolflow
```

Works out of the box. Type `/toolflow` anytime to summon the interactive prompt teleprompter.

---

## Core Value: Why Do Developers Need ToolFlow?

When developing with AI coding agents equipped with dozens of tools, plugins, and MCP servers, three systemic frictions emerge:

### 1. Tool Overload & Schema Noise
Exposing 40+ tool definitions simultaneously overwhelms the LLM. Asking for a straightforward utility function prompts the model to spin up a browser or query a database because unrelated schemas crowd the system prompt.
`toolflow` enforces **stage-gated capability mounting**: core tools (`read`, `write`, `edit`, `bash`) remain accessible at all times; heavy external MCPs, browsers, and subagents mount only in phases where they are strictly needed.

### 2. Context Blowout from Verbose Logs
Running builds or end-to-end test suites often dumps 500+ lines of raw stack traces. Flooding the context window burns token budgets, dilutes attention, and rapidly triggers premature conversation compaction—wiping out working memory.
`toolflow` enforces **real-time log dehydration**: outputs exceeding 40 lines are automatically archived to disk (`.pi/toolflow/runs/...`). The model receives only the exit code, root failure summary, and on-disk file path, **reducing token overhead by 95%**.

### 3. Template Scramble & Context Switching
Developers constantly copy-paste prompt templates from notes, web browsers, or chat history, interrupting the terminal development flow.
`toolflow` doubles as an **instant prompt teleprompter**: hit `/toolflow` without arguments to summon the teleprompter overlay, browse templates, and hit `[p]` to insert battle-tested prompts directly into your editor with zero planning ceremony.

---

## How It Works: The Action Matrix

```text
  /toolflow <task> (Launch sandboxed workflow)   /toolflow (Summon prompt teleprompter)
```

| Mode / Scenario | What You Do | What ToolFlow Does Behind the Scenes | What the AI Gets | When to Use |
| :--- | :--- | :--- | :--- | :--- |
| **Stage-Gated Mounting** | Launch `/toolflow <task>` | Core tools stay persistent; heavy MCPs mount per stage | Focused, minimal tool catalog for active phase | Multi-phase complex engineering tasks |
| **Real-Time Log Dehydration** | Run verbose tests or builds | Intercepts logs >40 lines, archives full output to disk | Exit code, root error summary, on-disk file path (-95% tokens) | Compiler errors, test stack dumps |
| **Review Isolation** | Enter code review or verification | Physically strips write permissions from runtime | Read-only inspection tools, preventing accidental edits | Verification and code review phases |
| **Instant Teleprompter** | Type `/toolflow` without arguments | Auto-indexes local & global `prompts/*.md` templates | Hit `[p]` to insert highlighted prompt in 1 second | Routine prompt reuse without planning |
| **Zero-Residue Restoration** | Task completes or `/toolflow reset` | Restores original tool snapshot captured at startup | 100% clean, original tool catalog restored | Finishing tasks or exiting |

---

## Engineering Highlights

- 🛡️ **Persistent Core, Stage-Gated Advanced Capabilities**: Standard development tools (`read`, `edit`, `write`, `bash`, `grep`, `find`, `ls`) remain accessible at all times to prevent workflow lockups. Heavy MCPs mount dynamically only in relevant phases.
- ⚡ **4-Tier Token Governance (-95% Overhead)**:
  * Verbose outputs (>40 lines) are automatically archived to disk (`.pi/toolflow/runs/...`);
  * Heavy MCP schemas are masked during unrelated stages;
  * Intercepts `session_before_compact` at stage transitions to strip reasoning chaff while passing on-disk artifact paths downstream.
- 🔒 **Protected-File Write Guard**: Engine-level safety interceptor monitoring both native write tools and terminal commands (`bash`, `powershell`). Destructive operations targeting sensitive assets (`.env*`, `.git*`, package locks) are physically blocked.
- 🎨 **Production Craftsmanship Guard**: Bans unstyled placeholders, crude monochrome rectangles, and naive sketch lines. Mandates professional color palettes, 8px grid spacing, vector SVG artwork, and executable unit tests.
- 🔄 **Strict Tool Lifecycle Snapshot**: Snapshots active tools at startup. Upon stage completion, error, or manual `/toolflow reset`, the environment is 100% restored to its original catalog.

---

## Commands & Keybindings

### Primary Commands
| Command | Description |
| :--- | :--- |
| `/toolflow` | Open prompt workbench & task initialization cockpit |
| `/toolflow <task>` | Launch a sandboxed task with phase-gated toolchains |
| `/toolflow status` | Display active stage pipeline & mounted tool state (alias: `/sop`) |
| `/toolflow stats` | Display cumulative token savings ledger (dehydrated logs & cache hits) |
| `/toolflow logs` | Inspect the full raw content of the most recently dehydrated log |
| `/toolflow rollback` | Revert changes to the snapshot captured at the start of current stage |
| `/toolflow reset` | Clear active execution state and flush dehydrated temp caches |
| `/toolflow export` | Export phase breakdown and architecture decisions to `BLUEPRINT.md` |

### Keybindings
- `[Enter]`: Input task and generate phase-governed plan
- `[p]`: Prefill highlighted prompt template into editor
- `[c]`: Create new prompt template inline
- `[1-4]` / `[←/→]`: Toggle architecture and toolchain options
- `[Esc]`: Exit / Close overlay

---

## Author's Note

The idea for ToolFlow came from a recurring moment of frustration: watching an agent lose its mind because its toolbox was too crowded.

When terminal coding agents added support for arbitrary MCP servers and subagent extensions, I installed everything: browser controllers, database connectors, search engines, and multi-agent harnesses. Within days, a subtle degradation emerged: asking the model for a straightforward TypeScript helper function prompted it to spin up Chrome or run a heavy subagent workflow because 40+ tool schemas were competing in the prompt.

Then came the second pain point: verbose compiler outputs and test logs. Running a build or an end-to-end test suite often dumped 500+ lines of raw stack traces straight into the context window. Within three turns, the session's context window was completely saturated, triggering premature conversation compaction and wiping out working memory.

ToolFlow is the physical defense against this tool and token bloat:
1. **Stage-gated capability mounting**: core tools (`read`, `write`, `edit`, `bash`) remain available at all times, while heavy external tools mount only when strictly required;
2. **Real-time log dehydration**: verbose outputs (>40 lines) are automatically archived to disk, leaving only the exit code, root failure summary, and on-disk file path in context.

It brings discipline to the agent's toolbox, leaving context windows focused on the code that matters.

---

## Quality Assurance & Verification

```bash
npm test            # Physical panoramic regression test suite (26 suites passing)
```

---

## Ecosystem: Pi Terminal Suite

Each extension occupies a distinct terminal slot (`aboveEditor`, `belowEditor`, `status-only` footer, and runtime tool hooks) so all four run together with zero widget overlap:

| Package | Terminal Slot & Mechanism | Install |
| :--- | :--- | :--- |
| **[`pi-lingual`](https://github.com/3ZEROS12/pi-lingual)** | `二 ⇄ two` `aboveEditor` HUD (≤9 lines, UAX #11 tree layout) & prompt-to-English transformer (0 chat history tokens) | `pi install npm:pi-lingual` |
| **[`toolflow`](https://github.com/3ZEROS12/toolflow)** *(Current)* | `⌬` Runtime tool hooks — stage-gated MCP mounting & >40-line log dehydration to disk (-95% log tokens) | `pi install npm:toolflow` |
| **[`pi-tui-status-beautifier`](https://github.com/3ZEROS12/pi-tui-status-beautifier)** | `status-only` footer hook — 6 badge presets, `<80`-col idle folding `(+N idle)`, 0 render-loop disk reads | `pi install npm:pi-tui-status-beautifier` |
| **[`pi-anchor`](https://github.com/3ZEROS12/anchor)** | `⌖` `belowEditor` 1-line sticky strip, 0ms `pin:` intercept, `[■■□□]` step bar & `↪` session jump | `pi install npm:pi-anchor` |

---

## License

MIT © [Jason](https://github.com/3ZEROS12)
