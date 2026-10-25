import * as fs from "node:fs";
import * as path from "node:path";

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
    lastUpdated: Date.now()
  };
}

/** Compact the ledger back into a single snapshot once it grows past this. */
export const STATS_COMPACT_BYTES = 256 * 1024;

/**
 * Token-savings ledger.
 *
 * Writes are append-only JSONL. The previous implementation did a
 * read-modify-write on a single JSON file, so two concurrent Pi sessions in the
 * same workspace silently lost each other's updates. Appending a short line is
 * atomic; the totals are derived on read and memoised on (mtime, size).
 */
export class StatsManager {
  private statsLedger: string;
  private legacyStatsFile: string;
  private cache: { mtimeMs: number; size: number; stats: ToolFlowStats } | null = null;
  private appendCount = 0;

  constructor(cwd: string = process.cwd()) {
    const baseDir = path.join(cwd, ".pi", "toolflow");
    try {
      fs.mkdirSync(baseDir, { recursive: true });
    } catch (_) {}
    this.statsLedger = path.join(baseDir, "stats.jsonl");
    this.legacyStatsFile = path.join(baseDir, "stats.json");
  }

  public getStats(): ToolFlowStats {
    try {
      if (!fs.existsSync(this.statsLedger)) {
        return this.readLegacyStats();
      }
      const stat = fs.statSync(this.statsLedger);
      if (this.cache && this.cache.mtimeMs === stat.mtimeMs && this.cache.size === stat.size) {
        return { ...this.cache.stats };
      }
      const stats = this.aggregate(fs.readFileSync(this.statsLedger, "utf-8"));
      this.cache = { mtimeMs: stat.mtimeMs, size: stat.size, stats };
      return { ...stats };
    } catch (_) {
      return emptyStats();
    }
  }

  public recordSavings(tokens: number, type: "log" | "read_cache" | "blast"): void {
    const safeTokens = Math.max(0, tokens);
    try {
      // Seed the ledger from a pre-1.0 stats.json so counters survive the upgrade.
      if (!fs.existsSync(this.statsLedger) && fs.existsSync(this.legacyStatsFile)) {
        this.appendSnapshot(this.readLegacyStats());
        try {
          fs.unlinkSync(this.legacyStatsFile);
        } catch (_) {}
      }
      const line = JSON.stringify({ ts: Date.now(), tokens: safeTokens, type });
      fs.appendFileSync(this.statsLedger, line + "\n", "utf-8");
      this.cache = null;
      if (++this.appendCount % 50 === 0) this.compactIfNeeded();
    } catch (_) {}
  }

  public getFormattedSavings(): string {
    const stats = this.getStats();
    const tokens = stats.totalTokensSaved || 0;
    if (tokens < 1000) return `⌬ ${tokens}t`;
    if (tokens < 1000000) return `⌬ -${(tokens / 1000).toFixed(1)}k`;
    return `⌬ -${(tokens / 1000000).toFixed(2)}M`;
  }

  private readLegacyStats(): ToolFlowStats {
    try {
      if (fs.existsSync(this.legacyStatsFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.legacyStatsFile, "utf-8"));
        return { ...emptyStats(), ...parsed };
      }
    } catch (_) {}
    return emptyStats();
  }

  private aggregate(raw: string): ToolFlowStats {
    const stats = emptyStats();
    stats.lastUpdated = 0;
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const evt = JSON.parse(trimmed);
        if (evt.type === "snapshot") {
          stats.totalTokensSaved += evt.totalTokensSaved || 0;
          stats.dehydratedLogsCount += evt.dehydratedLogsCount || 0;
          stats.readCacheHitsCount += evt.readCacheHitsCount || 0;
          stats.blastRadiusBlocksCount += evt.blastRadiusBlocksCount || 0;
          stats.lastUpdated = Math.max(stats.lastUpdated, evt.lastUpdated || 0);
          continue;
        }
        if (typeof evt.tokens !== "number") continue;
        stats.totalTokensSaved += Math.max(0, evt.tokens);
        if (evt.type === "log") stats.dehydratedLogsCount++;
        else if (evt.type === "read_cache") stats.readCacheHitsCount++;
        else if (evt.type === "blast") stats.blastRadiusBlocksCount++;
        stats.lastUpdated = Math.max(stats.lastUpdated, evt.ts || 0);
      } catch (_) {}
    }
    if (stats.lastUpdated === 0) stats.lastUpdated = Date.now();
    return stats;
  }

  private appendSnapshot(stats: ToolFlowStats): void {
    const snapshot = JSON.stringify({ ts: Date.now(), type: "snapshot", ...stats });
    fs.appendFileSync(this.statsLedger, snapshot + "\n", "utf-8");
    this.cache = null;
  }

  private compactIfNeeded(): void {
    try {
      if (fs.statSync(this.statsLedger).size <= STATS_COMPACT_BYTES) return;
      const stats = this.getStats();
      const tempPath = `${this.statsLedger}.tmp.${process.pid}`;
      fs.writeFileSync(tempPath, JSON.stringify({ ts: Date.now(), type: "snapshot", ...stats }) + "\n", "utf-8");
      fs.renameSync(tempPath, this.statsLedger);
      this.cache = null;
    } catch (_) {}
  }
}
