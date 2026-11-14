import * as fs from "node:fs";
import * as path from "node:path";
import { exec, execSync } from "node:child_process";
import { promisify } from "node:util";
import type {
  BlueprintStage,
  DistilledSkillContract,
  EcosystemBundlePlan,
  McpToolBinding,
  RecommendedPackageItem,
} from "../core/types.js";

const execAsync = promisify(exec);

const CURATED_ECOSYSTEM_CATALOG: RecommendedPackageItem[] = [
  {
    name: "pi-control-chrome",
    source: "npm:pi-control-chrome",
    description: "Real Chrome/Edge DevTools automation with live DOM, screenshot, and console error probes.",
    leverageReason: "Enables headless/browser verification and runtime DOM inspection.",
    stars: 420,
    official: true,
  },
  {
    name: "pi-subagents",
    source: "npm:pi-subagents",
    description: "Multi-agent coordinator for parallel background workers and fresh-context code review.",
    leverageReason: "Supports isolated review stages and concurrent verification.",
    stars: 380,
    official: true,
  },
  {
    name: "pi-web-access",
    source: "npm:pi-web-access",
    description: "Live documentation search and URL content extraction.",
    leverageReason: "Pulls up-to-date framework and API specs without stale memory.",
    stars: 310,
    official: true,
  },
  {
    name: "pi-anchor",
    source: "npm:pi-anchor",
    description: "Persistent cross-session task dock with DAG tracking and session teleport.",
    leverageReason: "Retains active progress and pinned constraints across restarts.",
    stars: 260,
    official: true,
  },
];

export class DeepSkillsDistiller {
  public static distillFromFile(skillName: string, filePath: string): DistilledSkillContract {
    const empty: DistilledSkillContract = {
      skillName,
      filePath,
      directives: [],
      sopSteps: [],
      rules: [],
      checkpoints: [],
    };
    try {
      if (!filePath || !fs.existsSync(filePath)) return empty;
      const raw = fs.readFileSync(filePath, "utf-8");
      const lines = raw.split(/\r?\n/);

      let section: "none" | "sop" | "rules" | "checkpoints" = "none";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        if (line.startsWith("#")) {
          const lower = line.toLowerCase();
          if (lower.includes("sop") || lower.includes("workflow") || lower.includes("step")) {
            section = "sop";
          } else if (lower.includes("rule") || lower.includes("constraint") || lower.includes("invariant")) {
            section = "rules";
          } else if (lower.includes("check") || lower.includes("gate") || lower.includes("verify")) {
            section = "checkpoints";
          } else {
            section = "none";
          }
          continue;
        }

        const bullet = line.replace(/^[-*+]\s+|^\d+\.\s+/, "").trim();
        if (!bullet) continue;

        if (section === "sop" && empty.sopSteps.length < 6) {
          empty.sopSteps.push(bullet);
        } else if (section === "rules" && empty.rules.length < 6) {
          empty.rules.push(bullet);
        } else if (section === "checkpoints" && empty.checkpoints.length < 6) {
          empty.checkpoints.push(bullet);
        } else if (
          (line.startsWith("-") || line.startsWith("*") || /^\d+\./.test(line)) &&
          empty.directives.length < 8
        ) {
          empty.directives.push(bullet);
        }
      }
      return empty;
    } catch {
      return empty;
    }
  }
}

export class McpMethodRegistry {
  public static resolveBindingsForStage(
    availableMcpServers: string[],
    stageObjective: string,
    isReviewStage: boolean = false
  ): McpToolBinding[] {
    if (!availableMcpServers || availableMcpServers.length === 0) return [];
    const bindings: McpToolBinding[] = [];
    const lowerObj = (stageObjective || "").toLowerCase();

    for (const server of availableMcpServers) {
      const lowerSrv = server.toLowerCase();
      if (lowerSrv.includes("playwright") || lowerSrv.includes("chrome") || lowerSrv.includes("puppeteer")) {
        if (isReviewStage || /ui|web|preview|screenshot|render|dom|browser/.test(lowerObj)) {
          bindings.push({
            server,
            tool: "screenshot",
            reason: "Capture visual preview and verify DOM layout without guesswork",
            template: `mcp({ server: "${server}", tool: "screenshot", args: { path: "preview.png" } })`,
          });
        }
      } else if (lowerSrv.includes("context7") || lowerSrv.includes("docs") || lowerSrv.includes("fetch")) {
        bindings.push({
          server,
          tool: "query-docs",
          reason: "Verify current API signatures before implementation",
          template: `mcp({ server: "${server}", tool: "query-docs", args: { query: "..." } })`,
        });
      } else if (lowerSrv.includes("postgres") || lowerSrv.includes("sqlite") || lowerSrv.includes("db")) {
        bindings.push({
          server,
          tool: "query",
          reason: "Inspect live schema constraints cleanly",
          template: `mcp({ server: "${server}", tool: "query", args: { sql: "SELECT 1" } })`,
        });
      }
    }

    return bindings;
  }
}

export function bindDeepEcosystemToStage(
  stage: BlueprintStage,
  availableMcpServers: string[],
  discoveredSkills: Array<{ name: string; filePath?: string }>
): void {
  if (availableMcpServers && availableMcpServers.length > 0) {
    const mcpBindings = McpMethodRegistry.resolveBindingsForStage(
      availableMcpServers,
      stage.coreObjective,
      Boolean(stage.isReviewStage)
    );
    if (mcpBindings.length > 0) {
      stage.mcpToolBindings = mcpBindings;
    }
  }

  const stageSkillNames = stage.boundCapabilities?.skills ?? [];
  if (stageSkillNames.length > 0) {
    const targetSkillName = stageSkillNames[0];
    const matched = discoveredSkills.find(
      s => s.name === targetSkillName || s.name.includes(targetSkillName)
    );
    if (matched?.filePath && fs.existsSync(matched.filePath)) {
      stage.skillContract = DeepSkillsDistiller.distillFromFile(targetSkillName, matched.filePath);
    } else {
      stage.skillContract = {
        skillName: targetSkillName,
        directives: [`Strictly apply ${targetSkillName} conventions during this stage.`],
        sopSteps: [],
        rules: [`Do not deviate from ${targetSkillName} constraints.`],
        checkpoints: [`Verify ${targetSkillName} acceptance criteria.`],
      };
    }
  }
}

export class EcosystemRadar {
  public static scanCatalog(task: string, existingPackages: string[] = []): EcosystemBundlePlan[] {
    const lowerTask = task.toLowerCase();
    const isWebOrUi = /web|ui|frontend|html|css|react|vue|svelte|browser|dom|page|dashboard|preview/.test(lowerTask);
    const isComplex = /refactor|architect|multi|pipeline|orchestr|agent|test|audit|review/.test(lowerTask);

    const missing = CURATED_ECOSYSTEM_CATALOG.filter(
      pkg => !existingPackages.some(e => e.toLowerCase().includes(pkg.name.toLowerCase()))
    );

    const recommended = missing.filter(pkg => {
      if (pkg.name === "pi-control-chrome") return isWebOrUi;
      if (pkg.name === "pi-subagents") return isComplex;
      return true;
    });

    const bundles: EcosystemBundlePlan[] = [];
    if (recommended.length > 0) {
      bundles.push({
        id: "bundle_recommended",
        title: "[Recommended] Task-Matched Extension Pack",
        description: `Add ${recommended.length} missing capability package(s) suited to this task.`,
        packages: recommended,
        isRecommended: true,
      });
    }

    bundles.push({
      id: "bundle_vanilla",
      title: "[Zero Dependencies] Standalone Built-In Mode",
      description: "Proceed using only already-installed Pi tools and extensions.",
      packages: [],
      isRecommended: recommended.length === 0,
    });

    return bundles;
  }

  public static resolvePiCliCommand(): string {
    const localAppData = process.env.LOCALAPPDATA || "";
    const appData = process.env.APPDATA || "";
    const candidates = [
      path.join(appData, "npm", "pi.cmd"),
      path.join(appData, "npm", "pi"),
      path.join(localAppData, "pnpm", "pi.cmd"),
      "pi",
    ];

    for (const candidate of candidates) {
      if (candidate === "pi") return "pi";
      if (fs.existsSync(candidate)) return `"${candidate}"`;
    }

    try {
      const cmd = process.platform === "win32" ? "where pi" : "which pi";
      const out = execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim();
      const firstLine = out.split(/\r?\n/)[0]?.trim();
      if (firstLine) return `"${firstLine}"`;
    } catch {
      // Fallback to bare pi
    }

    return "pi";
  }

  public static async installEcosystemPackages(
    packages: RecommendedPackageItem[]
  ): Promise<{ success: boolean; installed: string[]; failed: string[]; log: string }> {
    const installed: string[] = [];
    const failed: string[] = [];
    const logs: string[] = [];
    const piBin = EcosystemRadar.resolvePiCliCommand();

    for (const pkg of packages) {
      try {
        logs.push(`[ToolFlow] Installing ${pkg.source}...`);
        await execAsync(`${piBin} install ${pkg.source}`, { timeout: 60000 });
        installed.push(pkg.name);
        logs.push(`[ToolFlow] Installed ${pkg.name}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        failed.push(pkg.name);
        logs.push(`[ToolFlow] Failed to install ${pkg.name}: ${msg}`);
      }
    }

    return {
      success: failed.length === 0,
      installed,
      failed,
      log: logs.join("\n"),
    };
  }
}
