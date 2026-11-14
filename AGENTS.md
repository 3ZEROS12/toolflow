# TOOLFLOW AGENTS FIRMWARE

## 1. Package Metadata & Paths
- **Package**: `toolflow@5.1.0` | **Entry**: `src/index.ts` → `dist/index.js` (built by `tsup`)
- **Module layout**: `src/core/` (types, atomic IO, workspace store, messages), `src/optimizer/` (guard, read cache, dehydrator, slimmer, stats), `src/planner/` (taxonomy, router, DAG, synthesizer, verifier, prompts, memory), `src/ui/` (cards, navigator), `src/extension/` (commands, hooks, inspect tool).
- **Runtime storage** (all workspace-relative): `.pi/toolflow/runs/`, `.pi/toolflow/stats.jsonl`, `.pi/toolflow/memory/`, `.pi/blueprint_state.json`.
- **Shared cache**: `~/.pi/agent/toolflow-taxonomy.json` (runtime only; never written into the package tree).

## 2. Package Invariants
- **Workspace Isolation**: Every stateful component is keyed by normalized workspace root (`getWorkspaceStore`, `getReadCache`, `getDehydrator`, `getCodebaseMemory`). No module-level mutable singleton; `process.cwd()` is never captured at import time.
- **Zero Cold-Start Side Effects**: Importing the extension must not create `.pi/`, read persisted state, or spawn processes. Disk access happens only inside hooks/commands.
- **Persistent Core Tools**: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` stay mounted across all stages (`BASELINE_TOOLS`); never prune them.
- **Stage-Gated Capability Mounting**: Heavy MCP/browser/subagent tools mount only in stages that declare them, then the initial tool snapshot is restored.
- **Real-Time Log Dehydration**: Intercept outputs above 40 lines / 4 KB, archive to `.pi/toolflow/runs/<stage>/`, keep semantic error peaks plus head/tail; inspect via the `toolflow_inspect` tool.
- **Physical Blast Radius Guard**: Block writes outside the workspace root, protected files (`.env*`, `.git*`, lockfiles), destructive shell patterns, and out-of-scope edits during an active stage (escalation is operator-confirmed).
- **Read Cache Gates**: A duplicate full read is intercepted only when the file is ≥30 lines, unchanged by hash, unedited, not read through `offset`/`limit`, and no shell command mutated the workspace since the last read.
- **Universal English Source**: `src/**` must contain zero Han characters, including comments and regex literals. Script-aware heuristics use `isCjkText` from `src/core/text.ts`.
- **Verification Gate Honesty**: Stage completion requires expected artifacts on disk plus passing `verificationCommands`; three consecutive failures trip the circuit breaker.
- **Footer Badge Contract**: `setStatus("toolflow", …)` emits `[i/n] Stage · ~X saved · Y hits · Z guarded` (idle: `~X saved` only). The product name never repeats inside the value, zero counters are omitted, stage titles are clamped by code point with `…`, and every counter uses the plain `~1.4k saved` wording that `pi-tui-status-beautifier` parses.

## 3. Verification Commands
- `npm run check` — typecheck + full `node:test` suite.
- `npm run build` — tsup ESM/CJS/DTS bundle into `dist/`.
- `node ../.scripts/fleet.mjs test toolflow` — fleet pre-flight.
- `node ../.scripts/fleet.mjs docs toolflow` — docs style gate (badge count must equal passing tests).
