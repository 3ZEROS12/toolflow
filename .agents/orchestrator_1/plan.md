# Plan: ToolFlow Architectural Audit and Static/Runtime Risk Investigation

## Objective
Conduct an exhaustive, full-stack architectural audit and static/runtime risk investigation of the ToolFlow codebase, identify all non-compliant patterns, boundary vulnerabilities, and edge-case risks across all core modules, and compile a comprehensive, prioritized optimization report with concrete remediation recommendations into `AUDIT_AND_OPTIMIZATION_REPORT.md`.

## Target Modules
- `engine.ts`
- `taxonomy.ts`
- `dehydrator.ts`
- `blast_radius.ts`
- `degradation_matrix.ts`
- `memory.ts`
- `ui.ts`
- `state.ts`
- `types.ts`
- `index.ts`
- `worker_orchestrator.ts`

## Phases

### Phase 1: Exhaustive Deep Exploration & Risk Probing (3 Explorers in Parallel)
- **Explorer 1 (DAG Execution & Orchestration Core)**:
  - Focus: `engine.ts`, `state.ts`, `worker_orchestrator.ts`, `index.ts`, `types.ts`.
  - Probing: Kahn DAG cycle handling, promise lifecycle, async error propagation, worker timeout & backpressure, cancellation & unhandled rejections.
- **Explorer 2 (Safety, Storage & Resilience Subsystems)**:
  - Focus: `blast_radius.ts`, `dehydrator.ts`, `degradation_matrix.ts`, `memory.ts`.
  - Probing: Path normalization bypasses (`..`, symlinks, Windows case insensitivity), LRU disk quota eviction edge cases, SHA-256 fingerprint staleness, large payload serialization limits, 3-attempt degradation livelocks/infinite retries.
- **Explorer 3 (Taxonomy, Token Budgets, UI & Cross-Platform Compatibility)**:
  - Focus: `taxonomy.ts`, `ui.ts`, `types.ts`.
  - Probing: 0-Token / 0-Hardcode adherence, type soundness, ANSI escape sequence length vs display width (CJK / Emoji truncation), terminal resize artifacts, Windows vs POSIX path normalization.

### Phase 2: Report Drafting & Concrete Remediation Synthesis
- Worker writes `AUDIT_AND_OPTIMIZATION_REPORT.md` in workspace root.
- Includes:
  1. Executive Summary & Architectural Health Radar Score.
  2. Complete Module-by-Module Audit (100% of core TS files).
  3. Deep Edge-Case & Boundary Defense Vulnerability Matrix (Blast Radius, Dehydration, Degradation, UI/TUI).
  4. Prioritized Optimization Catalog (Critical / High / Medium / Low) with exact file/symbol links, reproduction hypotheses, and ready-to-apply refactoring code diffs.
  5. Sequenced Implementation & Refactoring Roadmap.

### Phase 3: Review, Challenge, and Forensic Integrity Audit
- 2 Reviewers independently verify the report against R1-R4 and code truth.
- 2 Challengers / Critics independently test the validity of finding hypotheses and recommendations.
- 1 Forensic Auditor verifies compliance and integrity.
- Gate check and parent handoff.
