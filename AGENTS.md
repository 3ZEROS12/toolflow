# TOOLFLOW AGENTS FIRMWARE

## 1. Package Metadata & Paths
- **Package**: `toolflow` | **Entry**: `src/index.ts`
- **Storage**: Dehydrated logs in `.pi/toolflow/runs/`; classification in `src/ecosystem_taxonomy.json`.

## 2. Package Invariants
- **Persistent Core Tools**: Core filesystem/execution tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) must remain permanently accessible across all stages; never prune them.
- **Stage-Gated Capability Mounting**: Mount heavy external MCP tools, browser automation, and dynamic subagents strictly in phases where needed; mask them outside active stages to eliminate prompt bloat.
- **Real-Time Log Dehydration**: Intercept command/fetch outputs >40 lines, archive directly to `.pi/toolflow/runs/`, and surface only exit code, summary, and path; inspect via `toolflow_inspect`.
- **Tool Lifecycle Snapshot & Zero-Orphan Restoration**: Snapshot registered tools on `session_start`; restore 100% to initial state on stage completion, failure, or `/toolflow reset`.
- **Physical Blast Radius Guard**: Intercept and physically block write tools or commands targeting sensitive files (`.env*`, `.git*`, package lockfiles).
- **Prompt Workbench**: Teleprompter (`/toolflow`) allows inserting prompt templates directly into the terminal editor via `[p]` key with zero planning ceremony.

## 3. Verification Commands
- `npm test` (or `node ../.scripts/fleet.mjs test toolflow`)
- `npx tsc --noEmit`
