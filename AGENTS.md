# SYSTEM CONTEXT & OPERATIONAL PROFILE: TOOLFLOW

## 1. Domain & Runtime Environment (RFC 2119)
- **Package / Target**: `toolflow` (v3.3.0)
- **Primary Domain**: Dynamic tool sandboxing, stage-gated capability orchestration, and 95% log dehydration to disk for Pi.
- **Runtime & Toolchain**: Node.js v20+ / TypeScript Strict / tsx / native Node test suite.
- **Extension Entry**: `src/index.ts` (configured via package manifest `"pi": { "extensions": ["src/index.ts"] }`).
- **Dehydrated Storage**: `.pi/toolflow/runs/` for archived tool outputs; `src/ecosystem_taxonomy.json` for ecosystem component classification.

---

## 2. Core Operational Invariants (RFC 2119)

### Invariant 1: Persistent Core Tools
- Native core development tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) MUST remain permanently accessible across all workflow stages.
- Pruning core filesystem and execution tools is STRICTLY FORBIDDEN to prevent workflow deadlocks.

### Invariant 2: Stage-Gated Capability Mounting
- Heavy external MCP tools, browser automation drivers, dynamic subagents, and long-running workflows MUST mount strictly in phases where their capabilities are required.
- Outside of active stages, heavy tools MUST be masked from the LLM prompt to eliminate token bloat and prevent tool selection entropy.

### Invariant 3: Real-Time Log Dehydration (-95% Overhead)
- Terminal command outputs (`bash`, `powershell`) or fetch outputs exceeding 40 lines MUST be intercepted and archived directly to disk (`.pi/toolflow/runs/...`).
- The LLM context window MUST receive only the exit status code, root failure summary, and the on-disk log file path.
- In-memory inspection tools (`toolflow_inspect`) MUST allow slicing and searching archived logs without reloading raw dumps into context.

### Invariant 4: Tool Lifecycle Snapshot & Zero-Orphan Restoration
- ToolFlow MUST snapshot all registered tools upon initial session startup (`session_start`).
- Upon stage completion, abrupt task failure, or explicit `/toolflow reset`, the environment MUST be 100% restored to its original snapshot state. Leaving orphaned tool definitions is FORBIDDEN.

### Invariant 5: Physical Blast Radius Guard
- The execution engine MUST intercept write tools and shell commands targeting sensitive system and repository files (`.env*`, `.git*`, package lockfiles). Destructive modifications or deletions targeting these assets MUST be physically blocked at the engine level.

---

## 3. Physical Verification & Build Commands

- **Run Regression Test Suite**:
  ```bash
  npm test
  # or from workspace root: node .scripts/fleet.mjs test toolflow
  ```
  *Executes 80+ fine-grained end-to-end assertions covering Kahn DAG scheduling, 3-strike self-healing, log dehydration, read cache, and lifecycle snapshots.*

- **Run TypeScript Type Check**:
  ```bash
  npx tsc --noEmit
  ```

---

## 4. Architectural Boundaries & Quality Gates

- **Prompt Workbench**: The interactive teleprompter (`/toolflow`) MUST allow selecting and inserting prompt templates directly into the terminal editor with zero planning ceremony (`[p]` key).
- **Documentation Linting**: Documentation MUST pass `node .scripts/fleet.mjs docs toolflow` with 0 corporate buzzwords and 0 pseudo-contrast phrasing.
