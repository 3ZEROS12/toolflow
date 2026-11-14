import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";
import type {
  CapabilityItem,
  EcosystemTaxonomy,
  LayerType,
  ProjectFingerprint,
  ProjectType,
} from "../core/types.js";
import { atomicWriteFileSync } from "../core/atomic-fs.js";
import { extractValidJsonObject } from "../core/json-extract.js";
import { getGitChangedFiles } from "../core/workspace-store.js";
import { callExtensionLlm, type LlmModelRuntime } from "./llm-client.js";
export type { LlmModelRuntime } from "./llm-client.js";

function hasExplicitAgentDir(): boolean {
  return Boolean(process.env.PI_CODING_AGENT_DIR || process.env.PI_CONFIG_DIR || process.env.PI_AGENT_DIR);
}

function isTestEnvironment(): boolean {
  return Boolean(process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === "test" || process.env.VITEST);
}

function getPiAgentDir(): string {
  return (
    process.env.PI_CODING_AGENT_DIR ||
    process.env.PI_CONFIG_DIR ||
    process.env.PI_AGENT_DIR ||
    path.join(os.homedir(), ".pi", "agent")
  );
}

function getRuntimeTaxonomyCachePath(): string {
  return path.join(getPiAgentDir(), "toolflow-taxonomy.json");
}
export function cleanName(rawName: string): string {
  let clean = rawName;
  if (clean.includes("/") || clean.includes("\\")) {
    const parts = clean.split(/[\\/]/);
    clean = parts[parts.length - 1] || clean;
  }
  clean = clean.replace(/^pi-/, "");
  clean = clean.replace(/\.ts$|\.js$|\.md$/, "");
  return clean;
}

export function generateCapabilityCompactDigest(item: Partial<CapabilityItem>): string {
  const cName = item.cleanName || cleanName(item.name || item.id || "item");
  const layerTag = item.layer ? item.layer.split("_")[0] : "L1";
  const desc = (item.description || "").trim();
  const shortDesc = desc.length > 42 ? desc.slice(0, 39) + "..." : desc;
  return shortDesc ? `[${layerTag}] ${cName}: ${shortDesc}` : `[${layerTag}] ${cName}`;
}

export function sniffProjectFingerprint(cwd: string = process.cwd()): ProjectFingerprint {
  let projectType: ProjectType = "unknown";
  let packageManager: ProjectFingerprint["packageManager"] = "unknown";
  let mainFramework: string | undefined;
  let sourceDir = "src";
  let testDir = "tests";
  const keyConfigFiles: string[] = [];

  const checkFile = (rel: string): boolean => {
    const exists = fs.existsSync(path.join(cwd, rel));
    if (exists && !keyConfigFiles.includes(rel)) keyConfigFiles.push(rel);
    return exists;
  };

  if (checkFile("package.json")) {
    projectType = "node";
    if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) packageManager = "pnpm";
    else if (fs.existsSync(path.join(cwd, "yarn.lock"))) packageManager = "yarn";
    else if (fs.existsSync(path.join(cwd, "bun.lockb")) || fs.existsSync(path.join(cwd, "bun.lock"))) packageManager = "bun";
    else packageManager = "npm";

    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8"));
      if (parsed && typeof parsed === "object") {
        const pkg = parsed as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        if (allDeps.next) { mainFramework = "Next.js"; projectType = "web"; }
        else if (allDeps.nuxt) { mainFramework = "Nuxt"; projectType = "web"; }
        else if (allDeps.react) { mainFramework = "React"; projectType = "web"; }
        else if (allDeps.vue) { mainFramework = "Vue"; projectType = "web"; }
        else if (allDeps.svelte) { mainFramework = "Svelte"; projectType = "web"; }
        else if (allDeps.express || allDeps.fastify || allDeps.hono || allDeps.koa) {
          mainFramework = allDeps.hono ? "Hono" : allDeps.fastify ? "Fastify" : "Express";
        } else if (allDeps.electron) {
          mainFramework = "Electron";
        }
      }
    } catch {
      // Ignore malformed package.json
    }
  }

  if (checkFile("Cargo.toml")) {
    projectType = "rust";
    packageManager = "cargo";
    mainFramework = "Cargo";
    testDir = "tests";
    try {
      const cargo = fs.readFileSync(path.join(cwd, "Cargo.toml"), "utf-8");
      if (cargo.includes("axum")) mainFramework = "Axum";
      else if (cargo.includes("actix-web")) mainFramework = "Actix-Web";
      else if (cargo.includes("tokio")) mainFramework = "Tokio";
    } catch {
      // Ignore read failure
    }
  }

  if (checkFile("pyproject.toml") || checkFile("requirements.txt") || checkFile("setup.py")) {
    if (projectType === "unknown") projectType = "python";
    if (checkFile("uv.lock")) packageManager = "uv";
    else if (checkFile("poetry.lock")) packageManager = "poetry";
    else if (packageManager === "unknown") packageManager = "pip";
    try {
      const pyText = fs.existsSync(path.join(cwd, "pyproject.toml"))
        ? fs.readFileSync(path.join(cwd, "pyproject.toml"), "utf-8")
        : fs.existsSync(path.join(cwd, "requirements.txt"))
          ? fs.readFileSync(path.join(cwd, "requirements.txt"), "utf-8")
          : "";
      if (pyText.includes("fastapi")) mainFramework = "FastAPI";
      else if (pyText.includes("django")) mainFramework = "Django";
      else if (pyText.includes("flask")) mainFramework = "Flask";
      else if (pyText.includes("pytest")) mainFramework = "Pytest";
    } catch {
      // Ignore read failure
    }
  }

  if (checkFile("go.mod")) {
    if (projectType === "unknown") projectType = "go";
    if (packageManager === "unknown") packageManager = "go";
    sourceDir = ".";
    testDir = ".";
    try {
      const goMod = fs.readFileSync(path.join(cwd, "go.mod"), "utf-8");
      if (goMod.includes("gin-gonic/gin")) mainFramework = "Gin";
      else if (goMod.includes("gofiber/fiber")) mainFramework = "Fiber";
    } catch {
      // Ignore read failure
    }
  }

  if (checkFile("CMakeLists.txt")) {
    if (projectType === "unknown") projectType = "cpp";
    if (packageManager === "unknown") packageManager = "cmake";
    if (!mainFramework) mainFramework = "CMake";
  }

  if (checkFile("pnpm-workspace.yaml") || checkFile("lerna.json")) {
    projectType = "monorepo";
  }

  if (projectType === "unknown") {
    if (fs.existsSync(path.join(cwd, "index.html"))) {
      projectType = "web";
      mainFramework = "Vanilla HTML/JS";
    } else if (fs.existsSync(path.join(cwd, "src"))) {
      projectType = "node";
    }
  }

  if (fs.existsSync(path.join(cwd, "test"))) testDir = "test";
  else if (fs.existsSync(path.join(cwd, "__tests__"))) testDir = "__tests__";

  if (!fs.existsSync(path.join(cwd, sourceDir)) && fs.existsSync(path.join(cwd, "app"))) {
    sourceDir = "app";
  }

  const gitInfo = getGitChangedFiles(cwd);
  const changedModules: string[] = [];
  for (const rel of [...gitInfo.changedFiles, ...gitInfo.untrackedFiles]) {
    const top = rel.split("/")[0];
    if (top && !changedModules.includes(top)) changedModules.push(top);
  }

  return {
    projectType,
    packageManager,
    mainFramework,
    sourceDir,
    testDir,
    hasGit: gitInfo.isGit,
    isDirty: gitInfo.changedFiles.length > 0 || gitInfo.untrackedFiles.length > 0,
    changedModules: changedModules.slice(0, 6),
    keyConfigFiles,
  };
}

function classifyByHeuristic(
  name: string,
  description: string,
  type: CapabilityItem["type"]
): { layer: LayerType; reason: string } {
  const lower = `${name} ${description}`.toLowerCase();

  if (lower.includes("review") || lower.includes("guard") || lower.includes("security") || lower.includes("audit") || lower.includes("test") || lower.includes("lint")) {
    return { layer: "L4_REVIEW_GUARD", reason: "Validation, security guard, or audit capability" };
  }
  if (lower.includes("subagent") || lower.includes("orchestr") || lower.includes("workflow") || lower.includes("toolflow") || lower.includes("anchor") || lower.includes("plan")) {
    return { layer: "L3_ORCHESTRATION", reason: "Task orchestration, workflow, or multi-agent coordination" };
  }
  if (lower.includes("browser") || lower.includes("mcp") || lower.includes("search") || lower.includes("web") || lower.includes("fetch") || lower.includes("chrome") || lower.includes("image")) {
    return { layer: "L2_PERCEPTION", reason: "External perception, web search, or browser automation" };
  }
  if (type === "prompt") {
    return { layer: "L3_ORCHESTRATION", reason: "Reusable engineering prompt template" };
  }
  return { layer: "L1_UTILITY", reason: "General developer utility" };
}

function scanMarkdownItems(
  dirs: string[],
  type: "skill" | "prompt",
  target: CapabilityItem[],
  seenNames: Set<string>
): void {
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        let mdPath: string | null = null;
        if (entry.isDirectory()) {
          const nested = path.join(dir, entry.name, type === "skill" ? "SKILL.md" : "PROMPT.md");
          if (fs.existsSync(nested)) mdPath = nested;
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          mdPath = path.join(dir, entry.name);
        }
        if (!mdPath) continue;

        const baseName = entry.name.replace(/\.md$/, "");
        if (seenNames.has(baseName)) continue;
        seenNames.add(baseName);

        let desc = `${type === "skill" ? "Skill" : "Prompt"} module: ${baseName}`;
        try {
          const content = fs.readFileSync(mdPath, "utf-8");
          const descMatch = content.match(/description:\s*(.+)/i);
          if (descMatch && descMatch[1]) {
            desc = descMatch[1].trim().replace(/^["']|["']$/g, "");
          } else {
            const heading = content.split("\n").find(l => l.trim().startsWith("#"));
            if (heading) desc = heading.replace(/^#+\s*/, "").trim();
          }
        } catch {
          // Ignore unreadable markdown
        }

        const cName = cleanName(baseName);
        const { layer, reason } = classifyByHeuristic(cName, desc, type);
        const item: CapabilityItem = {
          id: `${type}_${cName}`,
          name: baseName,
          cleanName: cName,
          type,
          layer,
          layerReason: reason,
          description: desc,
          compactDigest: "",
          filePath: mdPath,
        };
        item.compactDigest = generateCapabilityCompactDigest(item);
        target.push(item);
      }
    } catch {
      // Ignore unreadable directory
    }
  }
}

export function discoverEcosystemTaxonomy(cwd: string = process.cwd(), runtimeTools: unknown[] = []): EcosystemTaxonomy {
  // Tests that never pointed PI_AGENT_DIR at a sandbox must not read the operator's live
  // ~/.pi/agent tree (results were host-dependent and broke the zero-host-pollution rule).
  // Workspace-local `.pi/` scanning still runs, so fingerprint and repo skills stay testable.
  const agentDir = isTestEnvironment() && !hasExplicitAgentDir() ? "" : getPiAgentDir();
  const agentPaths = (...segments: string[]): string[] =>
    agentDir ? [path.join(agentDir, ...segments)] : [];

  const extensions: CapabilityItem[] = [];
  const skills: CapabilityItem[] = [];
  const prompts: CapabilityItem[] = [];
  const tools: CapabilityItem[] = [];

  const extSeen = new Set<string>();
  const settingsPath = agentDir ? path.join(agentDir, "settings.json") : "";
  if (settingsPath && fs.existsSync(settingsPath)) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      if (parsed && typeof parsed === "object" && "packages" in parsed && Array.isArray(parsed.packages)) {
        for (const pkg of parsed.packages) {
          const pkgName = typeof pkg === "string" ? pkg : pkg && typeof pkg === "object" && "name" in pkg && typeof pkg.name === "string" ? pkg.name : "";
          if (!pkgName) continue;
          const cName = cleanName(pkgName.replace(/^npm:/, ""));
          if (extSeen.has(cName)) continue;
          extSeen.add(cName);
          const { layer, reason } = classifyByHeuristic(cName, pkgName, "extension");
          const item: CapabilityItem = {
            id: `ext_${cName}`,
            name: pkgName,
            cleanName: cName,
            type: "extension",
            layer,
            layerReason: reason,
            description: `Pi extension package (${cName})`,
            compactDigest: "",
          };
          item.compactDigest = generateCapabilityCompactDigest(item);
          extensions.push(item);
        }
      }
    } catch {
      // Ignore malformed settings.json
    }
  }

  scanMarkdownItems(
    [path.join(cwd, ".pi", "skills"), ...agentPaths("skills")],
    "skill",
    skills,
    new Set<string>()
  );
  scanMarkdownItems(
    [path.join(cwd, ".pi", "prompts"), ...agentPaths("prompts")],
    "prompt",
    prompts,
    new Set<string>()
  );

  const toolSeen = new Set<string>();
  for (const rawTool of runtimeTools) {
    const name =
      typeof rawTool === "string"
        ? rawTool
        : rawTool && typeof rawTool === "object" && "name" in rawTool && typeof rawTool.name === "string"
          ? rawTool.name
          : "";
    if (!name || toolSeen.has(name)) continue;
    toolSeen.add(name);
    const description =
      rawTool && typeof rawTool === "object" && "description" in rawTool && typeof rawTool.description === "string"
        ? rawTool.description
        : `Runtime tool: ${name}`;
    const cName = cleanName(name);
    const { layer, reason } = classifyByHeuristic(cName, description, "tool");
    const item: CapabilityItem = {
      id: `tool_${cName}`,
      name,
      cleanName: cName,
      type: "tool",
      layer,
      layerReason: reason,
      description,
      compactDigest: "",
    };
    item.compactDigest = generateCapabilityCompactDigest(item);
    tools.push(item);
  }

  const fingerprint = sniffProjectFingerprint(cwd);
  const hash = crypto
    .createHash("md5")
    .update(JSON.stringify({ e: extensions.map(x => x.id), s: skills.map(x => x.id), p: prompts.map(x => x.id), t: tools.map(x => x.id) }))
    .digest("hex")
    .slice(0, 8);

  return {
    version: hash,
    scannedAt: Date.now(),
    projectFingerprint: fingerprint,
    extensions,
    skills,
    prompts,
    tools,
  };
}

export function loadOrRefreshTaxonomy(cwd: string = process.cwd(), runtimeTools: unknown[] = []): EcosystemTaxonomy {
  const fresh = discoverEcosystemTaxonomy(cwd, runtimeTools);
  try {
    const cachePath = getRuntimeTaxonomyCachePath();
    if (fs.existsSync(cachePath)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
      if (parsed && typeof parsed === "object" && "version" in parsed && parsed.version === fresh.version) {
        return {
          ...(parsed as EcosystemTaxonomy),
          projectFingerprint: fresh.projectFingerprint,
        };
      }
    }
  } catch {
    // Ignore stale/corrupted cache
  }
  return fresh;
}

export function reflectEnvironmentContext(ctx?: { getAllTools?: () => unknown }, cwd: string = process.cwd()): EcosystemTaxonomy {
  const tools = ctx && typeof ctx.getAllTools === "function" ? ctx.getAllTools() : [];
  return loadOrRefreshTaxonomy(cwd, Array.isArray(tools) ? tools : []);
}

export async function deepAnalyzeTaxonomyWithLLM(
  taxonomy: EcosystemTaxonomy,
  ctx?: LlmModelRuntime
): Promise<EcosystemTaxonomy> {
  try {
    const items = [...taxonomy.extensions, ...taxonomy.skills, ...taxonomy.prompts]
      .slice(0, 24)
      .map(i => ({ id: i.id, name: i.cleanName, type: i.type, description: i.description }));
    if (items.length === 0) return taxonomy;

    const rawText = await callExtensionLlm(
      ctx,
      "You classify Pi extensions, skills, and prompts into architectural layers.",
      `Classify these Pi ecosystem capabilities into layers (L1_UTILITY, L2_PERCEPTION, L3_ORCHESTRATION, L4_REVIEW_GUARD) ` +
        `and provide a concise English reason for each. Return strict JSON: {"items":[{"id":"...","layer":"...","reason":"..."}]}.\n` +
        JSON.stringify(items),
      900
    );
    if (!rawText) return taxonomy;
    const parsed = extractValidJsonObject(rawText);
    const classified = Array.isArray(parsed.items) ? parsed.items : [];
    const byId = new Map<string, { layer: LayerType; reason: string }>();

    for (const row of classified) {
      if (!row || typeof row !== "object") continue;
      const r = row as { id?: unknown; layer?: unknown; reason?: unknown };
      if (typeof r.id !== "string" || typeof r.layer !== "string") continue;
      if (
        r.layer === "L1_UTILITY" ||
        r.layer === "L2_PERCEPTION" ||
        r.layer === "L3_ORCHESTRATION" ||
        r.layer === "L4_REVIEW_GUARD"
      ) {
        byId.set(r.id, {
          layer: r.layer,
          reason: typeof r.reason === "string" ? r.reason : "Classified by LLM",
        });
      }
    }

    const applyUpdate = (list: CapabilityItem[]): CapabilityItem[] =>
      list.map(item => {
        const hit = byId.get(item.id);
        if (!hit) return item;
        const updated: CapabilityItem = { ...item, layer: hit.layer, layerReason: hit.reason };
        updated.compactDigest = generateCapabilityCompactDigest(updated);
        return updated;
      });

    const enriched: EcosystemTaxonomy = {
      ...taxonomy,
      extensions: applyUpdate(taxonomy.extensions),
      skills: applyUpdate(taxonomy.skills),
      prompts: applyUpdate(taxonomy.prompts),
    };

    atomicWriteFileSync(getRuntimeTaxonomyCachePath(), JSON.stringify(enriched, null, 2));
    return enriched;
  } catch {
    return taxonomy;
  }
}
