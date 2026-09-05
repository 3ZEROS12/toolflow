/**
 * ToolFlow Deep Ecosystem Engine (v1.8.0)
 * 深度生态装配系统:
 * 1. Deep Skills Distiller: 物理读取并结构化提炼 SKILL.md 规则、SOP 与门禁检查点
 * 2. Deep MCP Registry: 方法级探测与精准参数调用模板合成 (无幻觉直达)
 * 3. Deep Contract Binder: 将方法级调用模板与高压 Skill 契约注入蓝图各阶段
 */

import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { DistilledSkillContract, McpToolBinding, BlueprintStage, EcosystemBundlePlan, RecommendedPackageItem } from "./types.js";

const execAsync = promisify(exec);

// ============================================================================
// 1. Deep Skills Distiller (Skill 深度解析与 SOP 规则蒸馏器)
// ============================================================================

export class SkillDistiller {
  /**
   * 从给定的 SKILL.md 文件物理内容中蒸馏提炼紧凑规则契约
   */
  public static distillFromContent(skillName: string, content: string, filePath?: string): DistilledSkillContract {
    const lines = content.split(/\r?\n/);
    const directives: string[] = [];
    const sopSteps: string[] = [];
    const rules: string[] = [];
    const checkpoints: string[] = [];

    let currentSection: "unknown" | "sop" | "rules" | "checklist" | "directives" = "unknown";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      // 标题探测
      const lower = line.toLowerCase();
      if (line.startsWith("#")) {
        if (lower.includes("step") || lower.includes("workflow") || lower.includes("sop") || lower.includes("流程") || lower.includes("步骤")) {
          currentSection = "sop";
        } else if (lower.includes("rule") || lower.includes("guideline") || lower.includes("constraint") || lower.includes("规范") || lower.includes("原则")) {
          currentSection = "rules";
        } else if (lower.includes("check") || lower.includes("audit") || lower.includes("verify") || lower.includes("清单") || lower.includes("验收")) {
          currentSection = "checklist";
        } else if (lower.includes("command") || lower.includes("usage") || lower.includes("directive") || lower.includes("指令")) {
          currentSection = "directives";
        } else {
          currentSection = "unknown";
        }
        continue;
      }

      // 提取核心指令 (如 /plan, /review, 或者带有反引号的命令)
      if (currentSection === "directives" || line.startsWith("`/") || line.includes("`plannotator") || line.includes("`workflow")) {
        if ((line.startsWith("-") || line.startsWith("*") || line.startsWith("•") || line.match(/^\d+\./)) && line.length < 180) {
          directives.push(line.replace(/^[-*•\d.]\s*/, ""));
        }
      }

      // 提取 SOP 步骤
      if (currentSection === "sop" || line.match(/^\d+\.\s/)) {
        if (line.length < 200 && (line.match(/^\d+\./) || line.startsWith("-") || line.startsWith("*"))) {
          sopSteps.push(line.replace(/^[-*•\d.]\s*/, ""));
        }
      }

      // 提取硬性约束规则 (含 Never, Always, 严禁, 必须, 绝不)
      if (currentSection === "rules" || lower.includes("never") || lower.includes("always") || line.includes("严禁") || line.includes("必须") || line.includes("禁止")) {
        if ((line.startsWith("-") || line.startsWith("*") || line.startsWith("•")) && line.length < 200) {
          rules.push(line.replace(/^[-*•]\s*/, ""));
        }
      }

      // 提取验收检查清单 (Checkpoints)
      if (currentSection === "checklist" || line.includes("[ ]") || line.includes("[x]")) {
        if (line.length < 180) {
          checkpoints.push(line.replace(/^[-*•]\s*(\[[ x]\]\s*)?/, ""));
        }
      }
    }

    // 兜底保障：若未按规整 Markdown 排版，从全局嗅探高价值指令
    if (directives.length === 0) {
      const slashMatches = content.match(/\/[a-zA-Z0-9_-]+/g);
      if (slashMatches) {
        directives.push(...Array.from(new Set(slashMatches)).slice(0, 3));
      }
    }
    if (rules.length === 0) {
      rules.push(`严格遵守「${skillName}」技能的操作标准，确保工作流程专业可溯。`);
    }
    if (checkpoints.length === 0) {
      checkpoints.push(`验证「${skillName}」所规定的产物输出完整性。`);
    }

    return {
      skillName,
      filePath,
      directives: directives.slice(0, 4),
      sopSteps: sopSteps.slice(0, 5),
      rules: rules.slice(0, 5),
      checkpoints: checkpoints.slice(0, 5)
    };
  }

  /**
   * 物理读取本地 SKILL.md 并蒸馏
   */
  public static distillFromFile(filePath: string, skillName: string): DistilledSkillContract {
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf-8");
        return this.distillFromContent(skillName, content, filePath);
      }
    } catch (_) {}

    return {
      skillName,
      filePath,
      directives: [`/skill:${skillName}`],
      sopSteps: [`激活并遵循 ${skillName} 流程`],
      rules: [`执行本阶段时强制应用 ${skillName} 的规范`],
      checkpoints: [`检查 ${skillName} 规约是否满足`]
    };
  }

  /**
   * 将蒸馏契约格式化为可直接物理注入 System Prompt 的高压契约块
   */
  public static formatAsSystemContract(contract: DistilledSkillContract): string {
    const lines: string[] = [];
    lines.push(`\n<skill_contract skill="${contract.skillName}">`);
    lines.push(`  [SOP 核心规范与操作约束]`);
    for (const rule of contract.rules) {
      lines.push(`  • ${rule}`);
    }
    if (contract.sopSteps.length > 0) {
      lines.push(`  [执行 SOP 步骤]`);
      contract.sopSteps.forEach((s, idx) => lines.push(`  ${idx + 1}. ${s}`));
    }
    if (contract.checkpoints.length > 0) {
      lines.push(`  [完工核对门禁 (Checkpoints)]`);
      for (const cp of contract.checkpoints) {
        lines.push(`  [ ] ${cp}`);
      }
    }
    lines.push(`</skill_contract>\n`);
    return lines.join("\n");
  }
}

// ============================================================================
// 2. Deep MCP Registry (MCP 方法级字典与调用模板合成器)
// ============================================================================

export interface KnownMcpMethodProfile {
  server: string;
  tool: string;
  category: "browser" | "database" | "git" | "filesystem" | "api" | "general";
  description: string;
  sampleTemplate: string;
}

// 内置常见高频 MCP Server 深度方法知识库 (开箱即用无幻觉)
export const KNOWN_MCP_METHODS: KnownMcpMethodProfile[] = [
  // Playwright / Puppeteer 浏览器自动化
  {
    server: "playwright",
    tool: "playwright_navigate",
    category: "browser",
    description: "导航到指定页面进行测试或渲染",
    sampleTemplate: `mcp({ server: "playwright", tool: "playwright_navigate", args: { url: "http://localhost:3000" } })`
  },
  {
    server: "playwright",
    tool: "playwright_screenshot",
    category: "browser",
    description: "截取网页渲染画面进行视觉走查",
    sampleTemplate: `mcp({ server: "playwright", tool: "playwright_screenshot", args: { path: "preview.png" } })`
  },
  {
    server: "puppeteer",
    tool: "puppeteer_navigate",
    category: "browser",
    description: "控制 Headless 浏览器打开本地/远程页面",
    sampleTemplate: `mcp({ server: "puppeteer", tool: "puppeteer_navigate", args: { url: "http://localhost:8080" } })`
  },
  {
    server: "puppeteer",
    tool: "puppeteer_screenshot",
    category: "browser",
    description: "对当前前端页面进行快照走查",
    sampleTemplate: `mcp({ server: "puppeteer", tool: "puppeteer_screenshot", args: { name: "page_check" } })`
  },
  // 数据库相关 (Postgres / MySQL / SQLite)
  {
    server: "postgres",
    tool: "query",
    category: "database",
    description: "执行 SQL 查询以校验数据表结构与真实数据",
    sampleTemplate: `mcp({ server: "postgres", tool: "query", args: { sql: "SELECT * FROM users LIMIT 5;" } })`
  },
  {
    server: "sqlite",
    tool: "read_query",
    category: "database",
    description: "查询 SQLite 数据库表或 Schema",
    sampleTemplate: `mcp({ server: "sqlite", tool: "read_query", args: { query: "SELECT name FROM sqlite_master WHERE type='table';" } })`
  },
  // GitHub / 协作
  {
    server: "github",
    tool: "create_pull_request",
    category: "git",
    description: "基于当前交付成果自动创建 PR",
    sampleTemplate: `mcp({ server: "github", tool: "create_pull_request", args: { title: "feat: deliver task", branch: "feat/task" } })`
  },
  {
    server: "github",
    tool: "get_file_contents",
    category: "git",
    description: "检索远端仓库关键参照代码",
    sampleTemplate: `mcp({ server: "github", tool: "get_file_contents", args: { path: "README.md" } })`
  },
  // 通用 Fetch / API
  {
    server: "fetch",
    tool: "fetch",
    category: "api",
    description: "抓取外部 API 规范或文档",
    sampleTemplate: `mcp({ server: "fetch", tool: "fetch", args: { url: "https://api.example.com/v1/health" } })`
  }
];

export class McpMethodRegistry {
  /**
   * 根据检测到的 MCP Server 列表，智能生成阶段适用的方法级精准绑定
   */
  public static resolveBindingsForStage(
    serverNames: string[],
    stageObjective: string,
    isReviewStage: boolean = false
  ): McpToolBinding[] {
    const bindings: McpToolBinding[] = [];
    const lowerObj = stageObjective.toLowerCase();

    for (const sName of serverNames) {
      const lowerServer = sName.toLowerCase();
      // 匹配已知方法
      const matched = KNOWN_MCP_METHODS.filter(m => m.server.toLowerCase() === lowerServer);

      if (matched.length > 0) {
        for (const item of matched) {
          // 如果是测试/走查阶段，优先绑定截图和测试
          if (isReviewStage && (item.category === "browser" || item.tool.includes("screenshot") || item.tool.includes("query"))) {
            bindings.push({
              server: item.server,
              tool: item.tool,
              reason: item.description,
              template: item.sampleTemplate
            });
          } else if (!isReviewStage && item.category !== "browser") {
            // 普通阶段绑定非浏览器走查工具
            bindings.push({
              server: item.server,
              tool: item.tool,
              reason: item.description,
              template: item.sampleTemplate
            });
          } else if (lowerObj.includes("page") || lowerObj.includes("web") || lowerObj.includes("ui") || lowerObj.includes("页面")) {
            // 明确指明 UI 的阶段，直接挂载浏览器操作
            bindings.push({
              server: item.server,
              tool: item.tool,
              reason: item.description,
              template: item.sampleTemplate
            });
          }
        }
      } else {
        // 未知但配置了的通用 MCP Server：生成规范的标准动态调用模板
        bindings.push({
          server: sName,
          tool: `${sName}_action`,
          reason: `调用客户配置的「${sName}」专用服务`,
          template: `mcp({ server: "${sName}", tool: "<tool_name>", args: { ... } })`
        });
      }
    }

    return bindings.slice(0, 3); // 每个阶段精准绑定最相关的 1-3 个方法，杜绝过载
  }
}

// ============================================================================
// 3. Deep Contract Binder (生态深度灌注与阶段装备)
// ============================================================================

export function bindDeepEcosystemToStage(
  stage: BlueprintStage,
  availableMcpServers: string[],
  discoveredSkills: Array<{ name: string; filePath?: string }>
): void {
  // 1. 绑定 MCP 方法级模板
  if (availableMcpServers && availableMcpServers.length > 0) {
    const mcpBindings = McpMethodRegistry.resolveBindingsForStage(
      availableMcpServers,
      stage.coreObjective,
      stage.isReviewStage
    );
    if (mcpBindings.length > 0) {
      stage.mcpToolBindings = mcpBindings;
    }
  }

  // 2. 蒸馏并绑定匹配到的 Skill
  if (stage.boundCapabilities?.skills && stage.boundCapabilities.skills.length > 0) {
    const targetSkillName = stage.boundCapabilities.skills[0];
    const skillItem = discoveredSkills.find(s => s.name.toLowerCase() === targetSkillName.toLowerCase());

    if (skillItem && skillItem.filePath) {
      stage.skillContract = SkillDistiller.distillFromFile(skillItem.filePath, skillItem.name);
    } else {
      stage.skillContract = {
        skillName: targetSkillName,
        directives: [`/skill:${targetSkillName}`],
        sopSteps: [`遵循 ${targetSkillName} 标准规范执行业务设计与代码构建`],
        rules: [`禁止偏离 ${targetSkillName} 的指引要求`],
        checkpoints: [`核对 ${targetSkillName} 成果指标`]
      };
    }
  }
}

// ============================================================================
// 4. Ecosystem Catalog Radar & Installer (全网生态索引雷达与一键装配管线)
// ============================================================================

/**
 * 官方通用基础设施工具底册 (仅收录官方权威通用的底层编排与基础审查框架)
 */
export const CURATED_ECOSYSTEM_CATALOG: Array<{
  name: string;
  source: string;
  keywords: string[];
  description: string;
  leverageReason: string;
  official?: boolean;
}> = [
  {
    name: "@earendil-works/pi-subagents",
    source: "npm:pi-subagents",
    keywords: ["subagent", "agent", "worker", "parallel", "council", "多代理", "子代理", "并行", "审查会"],
    description: "Pi 官方多代理隔离并发编排核心",
    leverageReason: "实现子任务隔离沙盒与并发分发，避免主会话日志爆炸",
    official: true
  },
  {
    name: "@quintinshaw/pi-dynamic-workflows",
    source: "npm:@quintinshaw/pi-dynamic-workflows",
    keywords: ["workflow", "pipeline", "dag", "flow", "工作流", "流水线"],
    description: "Pi 官方原生动态有向无环工作流调度引擎",
    leverageReason: "提供工业级状态机流转与任务管道拓扑",
    official: true
  },
  {
    name: "@plannotator/pi-extension",
    source: "npm:@plannotator/pi-extension",
    keywords: ["review", "annotation", "diff", "audit", "走查", "批注", "审查", "代码评审"],
    description: "专业可视化代码与架构走查审查套件",
    leverageReason: "提供交互式 Diff 批注与无记忆冷启动质检",
    official: true
  },
  {
    name: "@modelcontextprotocol/server-playwright",
    source: "npm:@modelcontextprotocol/server-playwright",
    keywords: ["browser", "web", "crawl", "scrape", "ui test", "e2e", "页面走查", "浏览器", "网页自动化", "截图"],
    description: "无头浏览器控制与自动化截图/端到端测试 MCP 服务",
    leverageReason: "免去从零编写 Selenium/Puppeteer 脚本，直接通过标准 MCP 调用浏览器",
    official: true
  },
  {
    name: "@modelcontextprotocol/server-postgres",
    source: "npm:@modelcontextprotocol/server-postgres",
    keywords: ["postgres", "pgsql", "database", "sql", "数据库", "表结构"],
    description: "PostgreSQL 数据库元数据探测与查询 MCP 服务",
    leverageReason: "直接读取库表结构与执行 SQL 巡检，免去手写数据库驱动"
  },
  {
    name: "@modelcontextprotocol/server-github",
    source: "npm:@modelcontextprotocol/server-github",
    keywords: ["github", "pr", "issue", "repo", "commit", "代码库"],
    description: "GitHub 仓库/PR/Issue 官方 MCP 读写网关",
    leverageReason: "一键集成 Pull Request 自动化走查与提交"
  }
];

export class EcosystemRadar {
  /**
   * 针对任务推导全网公认优秀的生态工具套餐 (Batch Recommendation)
   * 遵循建议 1：绝不逐个询问，而是打包成一揽子方案！
   */
  public static async searchEcosystemCatalog(
    task: string,
    installedNames: string[] = []
  ): Promise<EcosystemBundlePlan[]> {
    const lowerTask = task.toLowerCase();
    const recommendedPackages: RecommendedPackageItem[] = [];

    const installedSet = new Set(installedNames.map(n => n.toLowerCase().replace(/^@[\w-]+\//, "")));

    // 1. 优先扫描精选底册
    for (const item of CURATED_ECOSYSTEM_CATALOG) {
      // 若本地已安装则跳过
      const cleanName = item.name.toLowerCase().replace(/^@[\w-]+\//, "");
      if (installedSet.has(cleanName) || installedSet.has(item.name.toLowerCase())) {
        continue;
      }

      // 关键词匹配
      const hit = item.keywords.some(kw => lowerTask.includes(kw.toLowerCase()));
      if (hit) {
        recommendedPackages.push({
          name: item.name,
          source: item.source,
          description: item.description,
          leverageReason: item.leverageReason,
          official: item.official
        });
      }
    }

    // 2. 组装套餐方案 (若有推荐，返回套餐 A 与纯净方案 B)
    if (recommendedPackages.length > 0) {
      const bundleA: EcosystemBundlePlan = {
        id: "bundle_recommended",
        title: `[一键装配] 自动引入 ${recommendedPackages.length} 个社区/官方公认神装套件 (强烈推荐)`,
        description: recommendedPackages.map(p => `• @${p.name}: ${p.leverageReason}`).join("\n"),
        packages: recommendedPackages,
        isRecommended: true
      };

      const bundleB: EcosystemBundlePlan = {
        id: "bundle_vanilla",
        title: "[直接从零手写] 不引入外部新插件，仅用本地环境与标准库实现",
        description: "适合网络受限或纯净项目环境，将从零手写核心业务逻辑与通信通道",
        packages: [],
        isRecommended: false
      };

      return [bundleA, bundleB];
    }

    return [];
  }

  /**
   * 解析当前宿主系统上可执行的 `pi` 命令前缀（对 Windows 批处理/环境 PATH 进行跨平台加固）
   */
  public static resolvePiCliCommand(): string {
    if (process.platform !== "win32") {
      return "pi";
    }

    // Windows 平台加固解析策略：
    // 1. 优先尝试直接 `pi` (若全局 PATH 关联正常)
    // 2. 备选尝试 `pi.cmd` (避免某些 cmd.exe/子进程缺少 PATHEXT 解析)
    // 3. 备选尝试 `npx pi` (npm 环境原生兜底)
    // 4. 备选尝试 `npx.cmd pi`
    const candidates = ["pi", "pi.cmd", "npx pi", "npx.cmd pi"];
    for (const candidate of candidates) {
      try {
        const testCmd = `${candidate} --version`;
        const { execSync } = require("child_process");
        execSync(testCmd, { stdio: "ignore", timeout: 4000 });
        return candidate;
      } catch {
        // 继续探测下一个候选
      }
    }

    // 默认 fallback
    return "npx pi";
  }

  /**
   * 在项目本地安全安装生态包 (`pi install -l <source>`)
   */
  public static async installPackagesLocally(
    packages: RecommendedPackageItem[],
    cwd: string = process.cwd()
  ): Promise<{ success: boolean; installed: string[]; failed: string[]; log: string }> {
    const installed: string[] = [];
    const failed: string[] = [];
    const logs: string[] = [];
    const cliPrefix = EcosystemRadar.resolvePiCliCommand();

    for (const pkg of packages) {
      try {
        logs.push(`[ToolFlow] 正在为本地项目安装: ${pkg.source} ...`);
        // 安全参数校验：避免异常字符注入
        const safeSource = pkg.source.replace(/["'`$\\]/g, "");
        const cmd = `${cliPrefix} install -l ${safeSource}`;
        const { stdout, stderr } = await execAsync(cmd, { cwd, timeout: 60000 });
        installed.push(pkg.name);
        logs.push(`[ToolFlow] ${pkg.name} 安装成功:\n${stdout}`);
      } catch (err: any) {
        failed.push(pkg.name);
        logs.push(`[ToolFlow] ${pkg.name} 安装失败: ${err.message}`);
      }
    }

    return {
      success: failed.length === 0,
      installed,
      failed,
      log: logs.join("\n")
    };
  }
}

