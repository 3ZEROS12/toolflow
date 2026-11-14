import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFileSync, normalizeWorkspaceKey } from "../core/atomic-fs.js";

export interface ToolFlowStats {
  totalTokensSaved: number;
  dehydratedLogsCount: number;
  readCacheHitsCount: number;
  blastRadiusBlocksCount: number;
  lastUpdated: number;
}

export function emptyStats(): ToolFlowStats {
  return {
    totalTokensSaved: 0,
    dehydratedLogsCount: 0,
    readCacheHitsCount: 0,
    blastRadiusBlocksCount: 0,
    lastUpdated: Date.now(),
  };
}

/** Compact the ledger back into a single snapshot once it grows past this. */
export const STATS_COMPACT_BYTES = 256 * 1024;

interface StatsDelta {
  tokensSaved?: number;
  dehydratedLogs?: number;
  readCacheHits?: number;
  blastRadiusBlocks?: number;
}

/**
 * Append-only JSONL token-savings ledger with mtime+size memoization and
 * automatic atomic compaction.
 */
export class StatsManager {
  private readonly statsFilePath: string;
  private cached: { size: number; mtimeMs: number; stats: ToolFlowStats } | null = null;

  constructor(cwd: string = process.cwd()) {
    this.statsFilePath = path.join(cwd, ".pi", "toolflow", "stats.jsonl");
  }

  public getStats(): ToolFlowStats {
    try {
      const st = fs.statSync(this.statsFilePath);
      if (this.cached && this.cached.size === st.size && this.cached.mtimeMs === st.mtimeMs) {
        return { ...this.cached.stats };
      }
      const raw = fs.readFileSync(this.statsFilePath, "utf-8");
      const stats = this.aggregate(raw);
      this.cached = { size: st.size, mtimeMs: st.mtimeMs, stats };
      return { ...stats };
    } catch {
      return emptyStats();
    }
  }

  public recordSavings(delta: StatsDelta): ToolFlowStats {
    const entry = {
      t: delta.tokensSaved ?? 0,
      d: delta.dehydratedLogs ?? 0,
      r: delta.readCacheHits ?? 0,
      b: delta.blastRadiusBlocks ?? 0,
      ts: Date.now(),
    };
    try {
      fs.mkdirSync(path.dirname(this.statsFilePath), { recursive: true });
      fs.appendFileSync(this.statsFilePath, JSON.stringify(entry) + "\n", "utf-8");
      this.cached = null;
      this.compactIfNeeded();
    } catch {
      // Best-effort ledger write
    }
    return this.getStats();
  }

  public getFormattedSavings(): string {
    const s = this.getStats();
    if (s.totalTokensSaved === 0 && s.dehydratedLogsCount === 0 && s.readCacheHitsCount === 0) {
      return "ToolFlow: 0 tokens saved yet";
    }
    const kSaved =
      s.totalTokensSaved >= 1000
        ? `${(s.totalTokensSaved / 1000).toFixed(1)}k`
        : `${s.totalTokensSaved}`;
    return `ToolFlow Saved: ~${kSaved} tokens (${s.dehydratedLogsCount} dehydrated, ${s.readCacheHitsCount} cache hits)`;
  }

  public getSavingsSummary(baselineTokens: number = 25000): {
    stats: ToolFlowStats;
    estimatedRatioPercent: number;
  } {
    const stats = this.getStats();
    const denom = Math.max(1, baselineTokens + stats.totalTokensSaved);
    const ratio = Math.min(98, Math.round((stats.totalTokensSaved / denom) * 100));
    return { stats, estimatedRatioPercent: ratio };
  }

  private aggregate(raw: string): ToolFlowStats {
    const stats = emptyStats();
    stats.lastUpdated = 0;

    for (const line of raw.split("\n")) {
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;

      if ("snap" in parsed && typeof parsed.snap === "number") {
        const snap = parsed as {
          snap: number;
          d?: unknown;
          r?: unknown;
          b?: unknown;
          ts?: unknown;
        };
        stats.totalTokensSaved = snap.snap;
        stats.dehydratedLogsCount = typeof snap.d === "number" ? snap.d : 0;
        stats.readCacheHitsCount = typeof snap.r === "number" ? snap.r : 0;
        stats.blastRadiusBlocksCount = typeof snap.b === "number" ? snap.b : 0;
        stats.lastUpdated = typeof snap.ts === "number" ? snap.ts : 0;
        continue;
      }

      const row = parsed as {
        t?: unknown;
        d?: unknown;
        r?: unknown;
        b?: unknown;
        ts?: unknown;
      };
      if (typeof row.t === "number") stats.totalTokensSaved += row.t;
      if (typeof row.d === "number") stats.dehydratedLogsCount += row.d;
      if (typeof row.r === "number") stats.readCacheHitsCount += row.r;
      if (typeof row.b === "number") stats.blastRadiusBlocksCount += row.b;
      if (typeof row.ts === "number" && row.ts > stats.lastUpdated) {
        stats.lastUpdated = row.ts;
      }
    }
    return stats;
  }

  private compactIfNeeded(): void {
    try {
      const st = fs.statSync(this.statsFilePath);
      if (st.size <= STATS_COMPACT_BYTES) return;
      const stats = this.getStats();
      const snapshot = {
        snap: stats.totalTokensSaved,
        d: stats.dehydratedLogsCount,
        r: stats.readCacheHitsCount,
        b: stats.blastRadiusBlocksCount,
        ts: stats.lastUpdated,
      };
      atomicWriteFileSync(this.statsFilePath, JSON.stringify(snapshot) + "\n");
      this.cached = null;
    } catch {
      // Ignore compaction errors
    }
  }
}

const statsPool = new Map<string, StatsManager>();

export function getStatsManager(cwd: string = process.cwd()): StatsManager {
  const key = normalizeWorkspaceKey(cwd);
  let instance = statsPool.get(key);
  if (!instance) {
    instance = new StatsManager(cwd);
    statsPool.set(key, instance);
  }
  return instance;
}

export function clearAllStatsManagers(): void {
  statsPool.clear();
}
