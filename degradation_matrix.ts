import type { EcosystemTaxonomy } from "./types.js";

export type DegradationTier = "TIER_1_NATIVE" | "TIER_2_GENERIC" | "TIER_3_FALLBACK";

export interface ToolCapabilityResolution {
  capability: string;
  selectedTool: string;
  fallbackTool: string;
  tier: DegradationTier;
  instruction: string;
}

export class GracefulDegradationMatrix {
  private availableTools: Set<string>;

  constructor(taxonomyOrTools?: EcosystemTaxonomy | string[]) {
    this.availableTools = new Set();
    if (Array.isArray(taxonomyOrTools)) {
      taxonomyOrTools.forEach(t => this.availableTools.add(t));
    } else if (taxonomyOrTools && taxonomyOrTools.extensions) {
      taxonomyOrTools.extensions.forEach(e => this.availableTools.add(e.id));
      taxonomyOrTools.extensions.forEach(e => this.availableTools.add(e.name));
    }
  }

  public resolveCapability(
    capability: "git_checkpoint" | "code_edit" | "test_runner" | "file_search" | "browser_preview",
    projectType?: "node" | "rust" | "python" | "go" | "unknown"
  ): ToolCapabilityResolution {
    const defaultShell = process.platform === "win32" ? "powershell" : "bash";

    switch (capability) {
      case "git_checkpoint":
        if (this.availableTools.has("pi-rewind") || this.availableTools.has("git_checkpoint")) {
          return {
            capability,
            selectedTool: "pi-rewind",
            fallbackTool: defaultShell,
            tier: "TIER_1_NATIVE",
            instruction: "调用专用快照插件秒级创建快照"
          };
        }
        return {
          capability,
          selectedTool: defaultShell,
          fallbackTool: defaultShell,
          tier: "TIER_2_GENERIC",
          instruction: "使用原生 Git plumbing 命令 refs/pi-checkpoints/* 创建影子引用"
        };

      case "code_edit":
        if (this.availableTools.has("edit")) {
          return {
            capability,
            selectedTool: "edit",
            fallbackTool: "write",
            tier: "TIER_1_NATIVE",
            instruction: "使用精准差量替换工具 edit 进行无损补丁修改"
          };
        }
        return {
          capability,
          selectedTool: "write",
          fallbackTool: "write",
          tier: "TIER_2_GENERIC",
          instruction: "使用 write 工具直接进行文件重写落盘"
        };

      case "file_search":
        if (this.availableTools.has("rg") || this.availableTools.has("grep")) {
          return {
            capability,
            selectedTool: "grep",
            fallbackTool: "find",
            tier: "TIER_1_NATIVE",
            instruction: "使用正则文本搜索定位关键符号"
          };
        }
        return {
          capability,
          selectedTool: "find",
          fallbackTool: "read",
          tier: "TIER_2_GENERIC",
          instruction: "使用文件树遍历过滤目标文件"
        };

      case "browser_preview":
        if (this.availableTools.has("pi-browser") || this.availableTools.has("browser_action")) {
          return {
            capability,
            selectedTool: "pi-browser",
            fallbackTool: defaultShell,
            tier: "TIER_1_NATIVE",
            instruction: "拉起真机浏览器执行交互式验收与截图"
          };
        }
        return {
          capability,
          selectedTool: defaultShell,
          fallbackTool: "read",
          tier: "TIER_3_FALLBACK",
          instruction: "输出本地静态链接或启动临时开发服务器供人工预览"
        };

      case "test_runner":
      default:
        let runnerInstruction = "调用语言原生命令执行单元测试与门禁退出码校验";
        if (projectType === "rust") {
          runnerInstruction = "执行 cargo test 运行 Rust 原生测试套件与类型校验";
        } else if (projectType === "python") {
          runnerInstruction = "执行 pytest / python -m unittest 运行 Python 测试套件";
        } else if (projectType === "go") {
          runnerInstruction = "执行 go test ./... 运行 Go 单元测试与覆盖率检查";
        } else if (projectType === "node") {
          runnerInstruction = "执行 npm test / pnpm test / vitest 运行 Node.js 测试";
        }

        return {
          capability,
          selectedTool: defaultShell,
          fallbackTool: defaultShell,
          tier: "TIER_2_GENERIC",
          instruction: runnerInstruction
        };
    }
  }

  /**
   * P0: 动态工具剪枝 (Stage 粒度工具集合解析)
   * 严防设计阶段死锁：允许 write 写入设计文档 docs/design.md
   */
  public resolvePrunedToolsForStage(
    stageKindOrId?: string,
    stageAllowedTools: string[] = []
  ): { allowedTools: string[]; blockedTools: string[] } {
    let baseAllowed: string[] = [];
    let baseBlocked: string[] = [];

    const raw = (stageKindOrId || "").toLowerCase();
    let normalizedKind = "code";
    if (raw.includes("design") || raw.includes("architect") || raw.includes("spec") || raw.includes("rfc")) {
      normalizedKind = "design";
    } else if (raw.includes("preview") || raw.includes("audit") || raw.includes("receipt") || raw.includes("review")) {
      normalizedKind = "preview";
    } else if (raw.includes("test") || raw.includes("verif") || raw.includes("qa") || raw.includes("gate")) {
      normalizedKind = "test";
    }

    switch (normalizedKind) {
      case "design":
        baseAllowed = ["read", "grep", "find", "ls", "write", "web_search", "fetch_content"];
        baseBlocked = ["edit", "bash", "powershell"];
        break;
      case "preview":
        baseAllowed = ["read", "grep", "find", "ls", "plannotator", "fetch_content", "mcp"];
        baseBlocked = ["edit", "write"];
        break;
      case "test":
        baseAllowed = ["read", "grep", "find", "ls", "bash", "powershell", "write", "goal_complete", "goal_blocked", "goal_wait", "mcp"];
        baseBlocked = ["edit"];
        break;
      case "code":
      default:
        baseAllowed = ["read", "grep", "find", "ls", "write", "edit", "bash", "powershell", "workflow", "subagent", "mcp"];
        baseBlocked = [];
        break;
    }

    // 若 stage 显式声明了允许的高阶工具或受限工具，以显式声明与基线交集/并集为准
    let mergedAllowed = Array.from(new Set([...baseAllowed, ...stageAllowedTools]));
    if (stageAllowedTools && stageAllowedTools.length > 0) {
      // 保证显式声明的高级工具（如 workflow / goal_complete 等）必被激活
      mergedAllowed = Array.from(new Set([...stageAllowedTools, ...baseAllowed.filter(b => ["read", "grep", "find", "ls"].includes(b))]));
    }
    return {
      allowedTools: mergedAllowed,
      blockedTools: baseBlocked.filter(b => !mergedAllowed.includes(b))
    };
  }
}
