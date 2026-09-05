import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";
import { fileURLToPath } from "url";
import { EcosystemTaxonomy, CapabilityItem, LayerType, ProjectFingerprint, ProjectType } from "./types.js";

import { extractValidJsonObject } from "./json_extractor.js";

const PI_AGENT_BASE = process.env.PI_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_TAXONOMY_PATH = path.resolve(__dirname, "ecosystem_taxonomy.json");
const ROOT_TAXONOMY_PATH = path.resolve(__dirname, "..", "ecosystem_taxonomy.json");
// 动态相对寻址：优先包内当前目录与上一级，彻底消除任何写死路径的假设
const TAXONOMY_PATH = fs.existsSync(LOCAL_TAXONOMY_PATH)
  ? LOCAL_TAXONOMY_PATH
  : (fs.existsSync(ROOT_TAXONOMY_PATH) ? ROOT_TAXONOMY_PATH : LOCAL_TAXONOMY_PATH);
const SETTINGS_PATH = path.join(PI_AGENT_BASE, "settings.json");
const NPM_MODULES_PATH = path.join(PI_AGENT_BASE, "npm", "node_modules");
const PROMPTS_PATH = path.join(PI_AGENT_BASE, "prompts");

function computeHash(str: string): string {
  return crypto.createHash("sha256").update(str).digest("hex").slice(0, 16);
}

/** 清理包名前缀 (如 npm:pi-rewind -> pi-rewind, git:github.com/.../foo -> foo) */
export function cleanName(raw: string): string {
  let name = raw.replace(/^npm:/, "");
  if (name.startsWith("git:")) {
    const parts = name.split("/");
    name = parts[parts.length - 1] || name;
  }
  name = name.replace(/^@[^/]+\//, "");
  return name;
}

/**
 * 极速探测本地工程指纹（纯 Node fs/path 同步检测，零外部子进程开销）
 */
export function sniffProjectFingerprint(cwd: string = process.cwd()): ProjectFingerprint {
  let projectType: ProjectType = "unknown";
  let mainFramework: string | undefined;
  let packageManager: ProjectFingerprint["packageManager"] = "unknown";
  const coreDependencies: string[] = [];
  let topLevelDirs: string[] = [];

  try {
    if (fs.existsSync(cwd)) {
      const entries = fs.readdirSync(cwd, { withFileTypes: true });
      const ignoredDirs = new Set(["node_modules", "target", "dist", ".git", ".pi", "build", "out"]);
      topLevelDirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith(".") && !ignoredDirs.has(e.name.toLowerCase()))
        .map(e => e.name);
    }
  } catch (_) {}

  // 1. Node / JS / TS 体系
  const pkgJsonPath = path.join(cwd, "package.json");
  if (fs.existsSync(pkgJsonPath)) {
    projectType = "node";
    if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) {
      packageManager = "pnpm";
    } else if (fs.existsSync(path.join(cwd, "yarn.lock"))) {
      packageManager = "yarn";
    } else if (fs.existsSync(path.join(cwd, "package-lock.json"))) {
      packageManager = "npm";
    } else {
      packageManager = "npm";
    }

    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
      const allDeps = {
        ...(pkg.dependencies || {}),
        ...(pkg.devDependencies || {}),
        ...(pkg.peerDependencies || {})
      };

      const depKeys = Object.keys(allDeps);
      coreDependencies.push(...depKeys.slice(0, 15));

      // 常见框架嗅探
      if (allDeps["next"]) mainFramework = "Next.js";
      else if (allDeps["react"]) mainFramework = "React";
      else if (allDeps["vue"]) mainFramework = "Vue";
      else if (allDeps["@nestjs/core"]) mainFramework = "NestJS";
      else if (allDeps["express"]) mainFramework = "Express";
      else if (allDeps["@earendil-works/pi-coding-agent"]) mainFramework = "Pi-Extension";
      else if (allDeps["electron"]) mainFramework = "Electron";
      else if (allDeps["typescript"] || fs.existsSync(path.join(cwd, "tsconfig.json"))) mainFramework = "TypeScript";
    } catch (_) {}
  }

  // 2. Rust 体系
  const cargoPath = path.join(cwd, "Cargo.toml");
  if (fs.existsSync(cargoPath)) {
    projectType = "rust";
    packageManager = "cargo";
    try {
      const cargoContent = fs.readFileSync(cargoPath, "utf-8");
      if (cargoContent.includes("actix-web")) mainFramework = "Actix-Web";
      else if (cargoContent.includes("axum")) mainFramework = "Axum";
      else if (cargoContent.includes("tauri")) mainFramework = "Tauri";
      else if (cargoContent.includes("tokio")) mainFramework = "Tokio";
    } catch (_) {}
  }

  // 3. Python 体系
  const pyprojectPath = path.join(cwd, "pyproject.toml");
  const reqPath = path.join(cwd, "requirements.txt");
  const pipfilePath = path.join(cwd, "Pipfile");
  if (fs.existsSync(pyprojectPath) || fs.existsSync(reqPath) || fs.existsSync(pipfilePath)) {
    projectType = "python";
    if (fs.existsSync(path.join(cwd, "uv.lock"))) packageManager = "uv";
    else if (fs.existsSync(path.join(cwd, "poetry.lock"))) packageManager = "poetry";
    else packageManager = "pip";

    try {
      const pyContent = fs.existsSync(pyprojectPath)
        ? fs.readFileSync(pyprojectPath, "utf-8")
        : (fs.existsSync(reqPath) ? fs.readFileSync(reqPath, "utf-8") : "");
      if (pyContent.includes("fastapi")) mainFramework = "FastAPI";
      else if (pyContent.includes("django")) mainFramework = "Django";
      else if (pyContent.includes("flask")) mainFramework = "Flask";
      else if (pyContent.includes("torch")) mainFramework = "PyTorch";
    } catch (_) {}
  }

  // 4. Go 体系
  const goModPath = path.join(cwd, "go.mod");
  if (fs.existsSync(goModPath)) {
    projectType = "go";
    packageManager = "go";
    try {
      const goContent = fs.readFileSync(goModPath, "utf-8");
      if (goContent.includes("gin-gonic/gin")) mainFramework = "Gin";
      else if (goContent.includes("gofiber/fiber")) mainFramework = "Fiber";
    } catch (_) {}
  }

  // 5. C/C++ 体系
  if (fs.existsSync(path.join(cwd, "CMakeLists.txt"))) {
    if (projectType === "unknown") projectType = "cpp";
    if (packageManager === "unknown") packageManager = "cmake";
    if (!mainFramework) mainFramework = "CMake";
  }

  // 6. Monorepo 嗅探
  if (fs.existsSync(path.join(cwd, "pnpm-workspace.yaml")) || fs.existsSync(path.join(cwd, "lerna.json"))) {
    projectType = "monorepo";
  }

  // 7. Git 状态与受影响模块嗅探（纯 Node 零外部子进程，读取 HEAD 与变更）
  const gitDir = path.join(cwd, ".git");
  const hasGit = fs.existsSync(gitDir);
  let isClean = true;
  let gitBranch: string | undefined;
  const activeModifiedPaths: string[] = [];

  if (hasGit) {
    try {
      const headFile = path.join(gitDir, "HEAD");
      if (fs.existsSync(headFile)) {
        const headContent = fs.readFileSync(headFile, "utf-8").trim();
        if (headContent.startsWith("ref: refs/heads/")) {
          gitBranch = headContent.replace("ref: refs/heads/", "");
        }
      }
    } catch (_) {}
  }

  return {
    projectType,
    mainFramework,
    packageManager,
    hasGit,
    isClean,
    topLevelDirs,
    coreDependencies,
    gitBranch,
    activeModifiedPaths: activeModifiedPaths.length > 0 ? activeModifiedPaths : undefined
  };
}

function scanPrompts(): CapabilityItem[] {
  const prompts: CapabilityItem[] = [];
  if (fs.existsSync(PROMPTS_PATH)) {
    const files = fs.readdirSync(PROMPTS_PATH);
    for (const file of files) {
      if (file.endsWith(".md")) {
        const id = file.replace(/\.md$/, "");
        prompts.push({
          id: `/${id}`,
          name: `/${id}`,
          kind: "prompt",
          layer: "L1_UTILITY",
          description: `全局提示词 [/${id}]`,
          tokenImpact: "minimal",
          triggerWhen: `调用 /${id}`,
          summary: `触发 /${id} 快捷动作`,
          tags: ["#prompt", `#${id}`],
          costLevel: "$0"
        });
      }
    }
  }

  if (fs.existsSync(NPM_MODULES_PATH)) {
    try {
      const scanDir = (base: string) => {
        const items = fs.readdirSync(base);
        for (const item of items) {
          const full = path.join(base, item);
          if (item.startsWith("@")) {
            scanDir(full);
            continue;
          }
          const pkgPromptsPath = path.join(full, "prompts");
          if (fs.existsSync(pkgPromptsPath)) {
            const files = fs.readdirSync(pkgPromptsPath);
            for (const file of files) {
              if (file.endsWith(".md")) {
                const id = file.replace(/\.md$/, "");
                let layer: LayerType = "L1_UTILITY";
                let tokenImpact: "minimal" | "low" | "medium" | "high" = "low";
                let costLevel: "$0" | "$1" | "$2" | "$3" = "$1";
                if (id.includes("research")) { layer = "L2_PERCEPTION"; tokenImpact = "medium"; costLevel = "$2"; }
                else if (id.includes("parallel") || id.includes("review-loop") || id.includes("council")) { layer = "L3_ORCHESTRATION"; tokenImpact = "high"; costLevel = "$3"; }

                prompts.push({
                  id: `/${id}`,
                  name: `/${id}`,
                  kind: "prompt",
                  layer,
                  description: `扩展指令 [/${id}]`,
                  tokenImpact,
                  triggerWhen: `触发专用流水线 ${id}`,
                  summary: `执行专职流水线 ${id}`,
                  tags: ["#pipeline", `#${id}`],
                  costLevel
                });
              }
            }
          }
        }
      };
      scanDir(NPM_MODULES_PATH);
    } catch (_) {}
  }
  return prompts;
}

function inferCapabilityFromMetadata(id: string, name: string, desc: string, kind: "extension" | "skill" | "tool" | "mcp"): CapabilityItem {
  const text = `${id} ${name} ${desc}`.toLowerCase();
  
  let layer: LayerType = "L1_UTILITY";
  let tokenImpact: "minimal" | "low" | "medium" | "high" = "low";
  let costLevel: "$0" | "$1" | "$2" | "$3" = "$1";
  const tags: string[] = [`#${kind}`, `#${cleanName(id)}`];

  let bindingReason = "基础通用能力";
  if (/(review|audit|plannotator|gate|guard|verify|assert|check|lint|test|inspect|validate|assertion|simplify)/.test(text)) {
    layer = "L4_REVIEW_GUARD";
    tokenImpact = "medium";
    costLevel = "$1";
    tags.push("#quality-guard");
    bindingReason = "代码审查走查、断言比对与质量门禁强拦截";
  } else if (/(workflow|subagent|orchestrat|parallel|dag|chain|spawn|lane|pipeline|council|agent|worker|batch|fanout)/.test(text)) {
    layer = "L3_ORCHESTRATION";
    tokenImpact = "high";
    costLevel = "$3";
    tags.push("#orchestration");
    bindingReason = "多任务并发分发与子流程编排调度";
  } else if (/(rewind|undo|git|checkpoint|snapshot|history|clean|format|diff|lock|rollback|sandbox|permission)/.test(text)) {
    layer = "L1_UTILITY";
    tokenImpact = "minimal";
    costLevel = "$0";
    tags.push("#safety");
    bindingReason = "工作区快照管理、影响面锁定与安全回滚";
  } else if (/(search|fetch|web|crawl|scrape|http|net|url|mcp|database|sql|api|doc|query|retrieve|read|browser|chrome|playwright|puppeteer|cdp|computer-use|gui)/.test(text)) {
    layer = "L2_PERCEPTION";
    tokenImpact = "medium";
    costLevel = "$2";
    tags.push("#perception");
    bindingReason = "精准信息检索、浏览器控制与外部数据源接入";
  }

  const cleanDesc = desc ? desc.slice(0, 36).replace(/\r?\n/g, " ") : `动态识别组件 [${cleanName(name)}]`;

  return {
    id: cleanName(id),
    name: cleanName(name),
    kind,
    layer,
    description: cleanDesc,
    tokenImpact,
    triggerWhen: `根据任务需求动态调度 ${cleanName(name)}`,
    summary: cleanDesc,
    tags,
    costLevel,
    bindingReason
  };
}

export function scanMcpServers(): CapabilityItem[] {
  const mcps: CapabilityItem[] = [];
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
      if (settings.mcpServers && typeof settings.mcpServers === "object") {
        for (const [serverName, serverConf] of Object.entries<any>(settings.mcpServers)) {
          const desc = serverConf?.description || `MCP 协议服务 [${serverName}]`;
          mcps.push(inferCapabilityFromMetadata(serverName, serverName, desc, "mcp"));
        }
      }
    } catch (_) {}
  }
  return mcps;
}

export function scanRealPiTools(registeredTools: Array<{ name: string; description?: string }> = []): CapabilityItem[] {
  const tools: CapabilityItem[] = [];
  for (const t of registeredTools) {
    if (!t.name) continue;
    tools.push(inferCapabilityFromMetadata(t.name, t.name, t.description || `宿主注册工具 [${t.name}]`, "tool"));
  }
  return tools;
}

export function scanSkills(): CapabilityItem[] {
  const skills: CapabilityItem[] = [];
  if (fs.existsSync(NPM_MODULES_PATH)) {
    const scanDir = (base: string) => {
      try {
        const items = fs.readdirSync(base);
        for (const item of items) {
          const full = path.join(base, item);
          if (item.startsWith("@")) {
            scanDir(full);
            continue;
          }
          const skillsDir = path.join(full, "skills");
          if (fs.existsSync(skillsDir)) {
            const skillFolders = fs.readdirSync(skillsDir);
            for (const sf of skillFolders) {
              let desc = "";
              const skillMdPath = path.join(skillsDir, sf, "SKILL.md");
              if (fs.existsSync(skillMdPath)) {
                try {
                  const content = fs.readFileSync(skillMdPath, "utf8").slice(0, 512);
                  const m = content.match(/description:\s*([^\r\n]+)/i);
                  if (m) desc = m[1].trim();
                } catch (_) {}
              }
              skills.push(inferCapabilityFromMetadata(sf, sf, desc, "skill"));
            }
          }
        }
      } catch (_) {}
    };
    scanDir(NPM_MODULES_PATH);
  }
  return skills;
}

function scanExtensions(rawPkgs: string[]): CapabilityItem[] {
  return rawPkgs.map((raw) => {
    const cleaned = cleanName(raw);
    let desc = "";
    
    // 动态嗅探 package.json 的 description (处理 npm: 前缀以兼容 Windows 路径)
    const normalizedPkgDir = raw.replace(/^npm:/, "");
    const pkgJsonPath = path.join(NPM_MODULES_PATH, normalizedPkgDir, "package.json");
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkgData = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
        desc = pkgData.description || "";
      } catch (_) {}
    }
    
    return inferCapabilityFromMetadata(cleaned, cleaned, desc, "extension");
  });
}

/** 生成三元高压缩特征摘要字符串 (< 350 Tokens) */
export function generateCapabilityCompactDigest(taxonomy: EcosystemTaxonomy): string {
  const lines: string[] = [];
  const allItems = [...taxonomy.extensions, ...taxonomy.skills, ...taxonomy.prompts];

  for (const item of allItems) {
    const layerTag = item.layer === "L1_UTILITY" ? "INF" : item.layer === "L2_PERCEPTION" ? "DOM" : item.layer === "L3_ORCHESTRATION" ? "ORC" : "GRD";
    const summary = item.summary || item.description;
    const tags = (item.tags || [`#${item.name}`]).join(", ");
    const cost = item.costLevel || "$1";
    lines.push(`[${layerTag}] ${item.name}: ${summary} (${tags}) <${cost}>`);
  }

  return lines.join("\n");
}

export function loadOrRefreshTaxonomy(
  cwd: string = process.cwd(),
  registeredTools: Array<{ name: string; description?: string }> = []
): EcosystemTaxonomy {
  let pkgNames: string[] = [];
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
      pkgNames = Array.isArray(settings.packages) ? settings.packages : [];
    } catch (_) {}
  }

  const projectFingerprint = sniffProjectFingerprint(cwd);
  const toolNames = registeredTools.map(t => t.name).sort();
  const rawKey = JSON.stringify({ pkgs: pkgNames.sort(), tools: toolNames });
  const currentFingerprint = computeHash(rawKey);

  if (fs.existsSync(TAXONOMY_PATH)) {
    try {
      const cached = JSON.parse(fs.readFileSync(TAXONOMY_PATH, "utf-8")) as EcosystemTaxonomy;
      // 在纯净 CI/无预装包或命中指纹时，直接复用随包分发的静态分类库
      if (
        (cached.installedFingerprint === currentFingerprint || (pkgNames.length === 0 && toolNames.length === 0)) &&
        cached.skills &&
        cached.prompts &&
        cached.mcps
      ) {
        return {
          ...cached,
          projectFingerprint,
          availableToolNames: toolNames.length > 0 ? toolNames : cached.availableToolNames
        };
      }
    } catch (_) {}
  }

  const extensions = scanExtensions(pkgNames);
  const skills = scanSkills();
  const prompts = scanPrompts();
  const mcps = scanMcpServers();
  const tools = scanRealPiTools(registeredTools);

  const summaryByLayer: Record<LayerType, number> = {
    L1_UTILITY: 0,
    L2_PERCEPTION: 0,
    L3_ORCHESTRATION: 0,
    L4_REVIEW_GUARD: 0
  };

  [...extensions, ...skills, ...prompts, ...mcps, ...tools].forEach(item => {
    if (item.layer && summaryByLayer[item.layer] !== undefined) {
      summaryByLayer[item.layer]++;
    }
  });

  const taxonomy: EcosystemTaxonomy = {
    installedFingerprint: currentFingerprint,
    projectFingerprint,
    updatedAt: Date.now(),
    extensions,
    skills,
    prompts,
    mcps,
    tools,
    availableToolNames: toolNames,
    summaryByLayer
  };

  try {
    const parentDir = path.dirname(TAXONOMY_PATH);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    fs.writeFileSync(TAXONOMY_PATH, JSON.stringify(taxonomy, null, 2), "utf-8");
  } catch (_) {}

  return taxonomy;
}

export async function deepAnalyzeTaxonomyWithLLM(
  taxonomy: EcosystemTaxonomy,
  pi: { executePrompt?: (prompt: string) => Promise<string> }
): Promise<EcosystemTaxonomy> {
  if (!pi || typeof pi.executePrompt !== "function") {
    return taxonomy;
  }

  const unclassified = [...taxonomy.extensions, ...taxonomy.skills, ...taxonomy.prompts].filter(
    (i) => i.summary?.includes("动态识别组件") || i.bindingReason?.includes("基础通用能力") || !i.layer
  );

  if (unclassified.length === 0) {
    return taxonomy;
  }

  const prompt = [
    "[DIRECTIVE: CLASSIFY_TOOLSET]",
    "Analyze the following installed items and classify each into: L1_UTILITY | L2_PERCEPTION | L3_ORCHESTRATION | L4_REVIEW_GUARD.",
    "Return JSON format: { items: Array<{ id: string, layer: string, summary: string, tags: string[] }> }",
    "",
    "Items:",
    ...unclassified.map((u) => `- ID: ${u.id}, Name: ${u.name}, RawDesc: ${u.description.slice(0, 120)}`)
  ].join("\n");

  try {
    const rawRes = await pi.executePrompt(prompt);
    const parsed = extractValidJsonObject(rawRes);
    if (parsed && Array.isArray(parsed.items)) {
      const itemMap = new Map(parsed.items.map((it: any) => [it.id, it]));
      const updateList = (list: CapabilityItem[]) =>
        list.map((item) => {
          const hit: any = itemMap.get(item.id);
          if (hit) {
            return {
              ...item,
              layer: (hit.layer as LayerType) || item.layer,
              summary: hit.summary || item.summary,
              tags: Array.isArray(hit.tags) ? hit.tags : item.tags
            };
          }
          return item;
        });

      taxonomy.extensions = updateList(taxonomy.extensions);
      taxonomy.skills = updateList(taxonomy.skills);
      taxonomy.prompts = updateList(taxonomy.prompts);

      const summary: Record<LayerType, number> = {
        L1_UTILITY: 0,
        L2_PERCEPTION: 0,
        L3_ORCHESTRATION: 0,
        L4_REVIEW_GUARD: 0
      };
      [...taxonomy.extensions, ...taxonomy.skills, ...taxonomy.prompts].forEach((i) => {
        if (i.layer && summary[i.layer] !== undefined) summary[i.layer]++;
      });
      taxonomy.summaryByLayer = summary;
      try {
        fs.writeFileSync(TAXONOMY_PATH, JSON.stringify(taxonomy, null, 2), "utf-8");
      } catch (_) {}
    }
  } catch (_) {}

  return taxonomy;
}

/**
 * 阶段三：MCP 与生态 Skills 联邦动态发现接口 (零 Token 扫描)
 */
export async function discoverEcosystemTaxonomy(
  cwd: string = process.cwd(),
  registeredTools: Array<{ name: string; description?: string }> = []
): Promise<EcosystemTaxonomy> {
  return loadOrRefreshTaxonomy(cwd, registeredTools);
}

export function reflectEnvironmentContext(
  ctx?: any,
  cwd: string = process.cwd()
): EcosystemTaxonomy {
  const tools = (ctx && typeof ctx.getAllTools === "function")
    ? ctx.getAllTools()
    : [];
  return loadOrRefreshTaxonomy(cwd, tools);
}
