import type {
  BlueprintStage,
  DAGPlanResult,
  DAGWave,
  EcosystemTaxonomy,
} from "../core/types.js";

/**
 * Computes topological execution waves using Kahn's algorithm and flags dependency cycles.
 */
export function planDAGWaves(stages: BlueprintStage[]): DAGPlanResult {
  if (!stages || stages.length === 0) {
    return { sortedStages: [], waves: [], hasCycles: false };
  }

  const stageMap = new Map<string, BlueprintStage>();
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  for (const stage of stages) {
    stageMap.set(stage.stageId, stage);
    inDegree.set(stage.stageId, 0);
    adjList.set(stage.stageId, []);
  }

  for (const stage of stages) {
    for (const depId of stage.dependsOn ?? []) {
      if (!stageMap.has(depId)) continue;
      if (depId === stage.stageId) {
        return {
          sortedStages: stages,
          waves: [],
          hasCycles: true,
          cycleNodes: [stage.stageId],
        };
      }
      adjList.get(depId)!.push(stage.stageId);
      inDegree.set(stage.stageId, (inDegree.get(stage.stageId) ?? 0) + 1);
    }
  }

  let currentFrontier: string[] = [];
  for (const [stageId, deg] of inDegree.entries()) {
    if (deg === 0) currentFrontier.push(stageId);
  }

  const waves: DAGWave[] = [];
  const sortedStages: BlueprintStage[] = [];
  let waveIndex = 1;

  while (currentFrontier.length > 0) {
    const waveStages: BlueprintStage[] = [];
    const nextFrontier: string[] = [];

    for (const id of currentFrontier) {
      const stage = stageMap.get(id)!;
      waveStages.push(stage);
      sortedStages.push(stage);

      for (const nextId of adjList.get(id) ?? []) {
        const nextDeg = (inDegree.get(nextId) ?? 0) - 1;
        inDegree.set(nextId, nextDeg);
        if (nextDeg === 0) nextFrontier.push(nextId);
      }
    }

    waves.push({
      waveIndex,
      stages: waveStages,
      isParallel: waveStages.length > 1,
    });

    currentFrontier = nextFrontier;
    waveIndex++;
  }

  if (sortedStages.length < stages.length) {
    const visited = new Set(sortedStages.map(s => s.stageId));
    const cycleNodes = stages.filter(s => !visited.has(s.stageId)).map(s => s.stageId);
    return {
      sortedStages,
      waves,
      hasCycles: true,
      cycleNodes,
    };
  }

  return { sortedStages, waves, hasCycles: false };
}

export type DegradationTier = "TIER_1_NATIVE" | "TIER_2_GENERIC" | "TIER_3_FALLBACK";

export interface ToolCapabilityResolution {
  capability: string;
  selectedTool: string;
  fallbackTool: string;
  tier: DegradationTier;
  instruction: string;
}

const CORE_DEFAULTS = ["read", "write", "edit", "bash", "grep", "find", "ls"];

/**
 * Resolves stage tool needs against currently registered Pi tools with 3-tier graceful fallback.
 */
export class GracefulDegradationMatrix {
  private readonly availableTools: Set<string>;

  constructor(taxonomyOrTools?: EcosystemTaxonomy | string[]) {
    this.availableTools = new Set<string>();
    if (Array.isArray(taxonomyOrTools)) {
      for (const t of taxonomyOrTools) {
        if (t) this.availableTools.add(t);
      }
    } else if (taxonomyOrTools) {
      for (const item of taxonomyOrTools.tools ?? []) {
        if (item.name) this.availableTools.add(item.name);
        if (item.cleanName) this.availableTools.add(item.cleanName);
      }
    }
    for (const core of CORE_DEFAULTS) this.availableTools.add(core);
  }

  public hasTool(name: string): boolean {
    if (this.availableTools.has(name)) return true;
    for (const t of this.availableTools) {
      if (t.toLowerCase().includes(name.toLowerCase())) return true;
    }
    return false;
  }

  public resolveCapability(capabilityType: "web_search" | "browser" | "subagent" | "lsp" | "mcp"): ToolCapabilityResolution {
    switch (capabilityType) {
      case "web_search":
        if (this.hasTool("web_search")) {
          return {
            capability: "web_search",
            selectedTool: "web_search",
            fallbackTool: "bash",
            tier: "TIER_1_NATIVE",
            instruction: "Use `web_search` to verify official APIs and documentation.",
          };
        }
        return {
          capability: "web_search",
          selectedTool: "bash",
          fallbackTool: "read",
          tier: "TIER_2_GENERIC",
          instruction: "`web_search` unavailable; fall back to `bash` (`curl`) or local docs.",
        };

      case "browser":
        if (this.hasTool("browser_probe_interaction")) {
          return {
            capability: "browser",
            selectedTool: "browser_probe_interaction",
            fallbackTool: "bash",
            tier: "TIER_1_NATIVE",
            instruction: "Use `browser_probe_interaction` to verify live DOM and console output.",
          };
        }
        if (this.hasTool("playwright") || this.hasTool("mcp")) {
          return {
            capability: "browser",
            selectedTool: "mcp",
            fallbackTool: "bash",
            tier: "TIER_2_GENERIC",
            instruction: "Use MCP browser automation or headless verification scripts.",
          };
        }
        return {
          capability: "browser",
          selectedTool: "bash",
          fallbackTool: "read",
          tier: "TIER_3_FALLBACK",
          instruction: "Browser controller unavailable; verify build and DOM invariants via headless CLI/tests.",
        };

      case "subagent":
        if (this.hasTool("subagent")) {
          return {
            capability: "subagent",
            selectedTool: "subagent",
            fallbackTool: "read",
            tier: "TIER_1_NATIVE",
            instruction: "Delegate isolated review or parallel sub-tasks via `subagent`.",
          };
        }
        return {
          capability: "subagent",
          selectedTool: "read",
          fallbackTool: "grep",
          tier: "TIER_3_FALLBACK",
          instruction: "`subagent` unavailable; execute isolated diff-only self-review in place.",
        };

      case "lsp":
        if (this.hasTool("lsp")) {
          return {
            capability: "lsp",
            selectedTool: "lsp",
            fallbackTool: "grep",
            tier: "TIER_1_NATIVE",
            instruction: "Use `lsp` for definition/reference checks.",
          };
        }
        return {
          capability: "lsp",
          selectedTool: "grep",
          fallbackTool: "find",
          tier: "TIER_2_GENERIC",
          instruction: "`lsp` unavailable; use `grep` and `find` for symbol tracing.",
        };

      case "mcp":
        if (this.hasTool("mcp")) {
          return {
            capability: "mcp",
            selectedTool: "mcp",
            fallbackTool: "bash",
            tier: "TIER_1_NATIVE",
            instruction: "Use configured MCP tool bindings.",
          };
        }
        return {
          capability: "mcp",
          selectedTool: "bash",
          fallbackTool: "read",
          tier: "TIER_3_FALLBACK",
          instruction: "MCP unavailable; use direct CLI/file tools.",
        };
    }
  }

  public computeAdaptiveTools(stageAllowedTools: string[] = []): {
    mergedTools: string[];
    degradedWarnings: string[];
  } {
    const warnings: string[] = [];
    const effective = new Set<string>(CORE_DEFAULTS);

    for (const tool of stageAllowedTools) {
      if (this.hasTool(tool)) {
        effective.add(tool);
      } else {
        if (tool.includes("browser")) {
          const res = this.resolveCapability("browser");
          effective.add(res.selectedTool);
          warnings.push(res.instruction);
        } else if (tool.includes("web_search")) {
          const res = this.resolveCapability("web_search");
          effective.add(res.selectedTool);
          warnings.push(res.instruction);
        } else if (tool.includes("subagent")) {
          const res = this.resolveCapability("subagent");
          effective.add(res.selectedTool);
          warnings.push(res.instruction);
        } else {
          effective.add(tool);
        }
      }
    }

    return {
      mergedTools: Array.from(effective),
      degradedWarnings: warnings,
    };
  }
}
