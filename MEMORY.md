# Memory Bank - ToolFlow Codebase Audit

## 📌 Project Context
- **Project**: ToolFlow Extension
- **Tech Stack**: TypeScript, Node.js, Pi Agent Extension SDK
- **Objective**: Full-stack architectural audit, in-place remediation & adversarial verification.

## 📌 Active Sprint / Tasks
- [x] Prosecutorial-grade inspection, dead code sweep & in-place flaw remediation (R1-R3)
- [x] Adversarial stress challenge & empirical verification (APPROVE - 69/69 asserts passed)

## 🛡️ Hard-Learned Lessons & Guardrails
- 【Windows Path Traversal -> Ensure strict cross-platform path normalization (path.resolve + trailing dot/space strip + DOS device checks) across blast radius】
- 【Windows Atomic Write -> Use retry loop (5 retries) on rename with backoff, copy fallback, and mandatory .tmp cleanup in inally】
- 【Subsystem Linkage -> Connect uninvoked standalone modules (degradation_matrix.ts, memory.ts, dehydrator.ts) to main engine runtime lifecycle】
- 【LRU Quota Eviction -> Sort directories ascending by mtime (.mtimeMs - b.mtimeMs) and exclude active run before quota check】
- 【State Persistence Across Turns -> Always persist retryCount and circuit breaker status to disk upon verification failures to prevent multi-turn livelocks】
- 【TUI Monospace & Surrogate Deletion -> Use padToVisibleWidth for multi-column separators and Array.from(s).slice(0, -1).join("") for Unicode/surrogate-safe backspace】
