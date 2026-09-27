import type { ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  EcosystemTaxonomy,
  CapabilityItem,
  TaskDiagnosis,
  TaskRequirementSlot,
  Blueprint,
  BlueprintStage,
  ProjectFingerprint,
  TradeOffPlan,
  ABMatrix,
  DAGPlanResult,
  DAGWave
} from "./types.js";
import { sniffProjectFingerprint, cleanName } from "./taxonomy.js";
import { bindDeepEcosystemToStage, EcosystemRadar } from "./deep_ecosystem.js";
import { extractValidJsonObject } from "./json_extractor.js";
import { CancellableLoader } from "@earendil-works/pi-tui";
import crypto from "crypto";
import path from "path";
import fs from "fs";

export interface TaskRouteDecision {
  mode: "FAST_TRACK" | "BLUEPRINT";
  reason: string;
  suggestedTools: string[];
}

/**
 * 任务轻重双模路由器 (Fast-Track 极速直达 vs Blueprint 渐进编排)
 */
export function diagnoseTaskExecutionMode(
  task: string,
  userExplicitMode?: "fast" | "blueprint"
): TaskRouteDecision {
  if (userExplicitMode === "fast") {
    return {
      mode: "FAST_TRACK",
      reason: "用户显式指定极速通道",
      suggestedTools: ["read", "edit", "write", "bash", "powershell", "grep", "find"]
    };
  }
  if (userExplicitMode === "blueprint") {
    return {
      mode: "BLUEPRINT",
      reason: "用户显式要求工程蓝图编排",
      suggestedTools: []
    };
  }

  const trimmed = (task || "").trim();
  const lower = trimmed.toLowerCase();

  // 1. 系统级架构词汇强制走完整蓝图
  const hasHeavyScope = /(重构系统|架构设计|全新系统|端到端开发|从头开发|设计整个|全栈系统|从零构建|新建工程|大型系统|全量迁移|architect|refactor\s+all|from\s+scratch)/i.test(lower);
  if (hasHeavyScope) {
    return { mode: "BLUEPRINT", reason: "检测到系统级重构或全局架构诉求", suggestedTools: [] };
  }

  // 2. 判定极速通道特征：具体文件、行号符号、微操作动词
  const hasSingleFileTarget = /\b[\w-]+\.(ts|tsx|js|jsx|py|rs|go|json|css|scss|html|vue|md)\b/i.test(lower);
  const hasSpecificLineOrSymbol = /(第\s*\d+\s*行|line\s*\d+|函数|function\s+\w+|class\s+\w+|方法|变量)/i.test(lower);
  const hasMicroActionVerb = /(修复|fix|修改|改一下|微调|format|加个注释|添加注释|加注释|补充类型|类型修复|换个颜色|改个文案|改文案|加个字段|加字段|增加字段|输出日志|加log|加打印|优化排版)/i.test(lower);

  if (trimmed.length <= 80 && (hasMicroActionVerb || hasSingleFileTarget || hasSpecificLineOrSymbol)) {
    return {
      mode: "FAST_TRACK",
      reason: `单点日常微任务 (${trimmed.length} 字, 具备局部修改意图)`,
      suggestedTools: ["read", "edit", "write", "bash", "powershell", "grep", "find"]
    };
  }

  return { mode: "BLUEPRINT", reason: "常规多阶段复合任务", suggestedTools: [] };
}

export interface ProjectArtifactProfile {
  srcPath: string;
  testPath: string;
  docPath: string;
  previewPath: string;
  reportPath: string;
  testCommands: string[];
  buildCommands?: string[];
  previewCommands?: string[];
}

/**
 * 根据工程指纹与项目真实目录结构动态推导物理产物路径，杜绝虚构目录
 */
export function inferArtifactProfile(fp?: ProjectFingerprint, cwd: string = process.cwd()): ProjectArtifactProfile {
  const pType = fp?.projectType || "node";
  const pkgMgr = fp?.packageManager || "npm";
  const topDirs = new Set(fp?.topLevelDirs || []);

  // 动态决策目录：如果项目没有对应目录，则优先使用现有结构，无目录则按语言规范放置
  const docDir = topDirs.has("docs") ? "docs" : topDirs.has("doc") ? "doc" : (topDirs.size > 0 ? "docs" : "");
  const reportDir = topDirs.has("reports") ? "reports" : (docDir || "");
  const testDir = topDirs.has("tests") ? "tests" : topDirs.has("test") ? "test" : topDirs.has("spec") ? "spec" : (pType === "rust" ? "tests" : (topDirs.size > 0 ? "tests" : ""));
  const srcDir = topDirs.has("src") ? "src" : topDirs.has("lib") ? "lib" : topDirs.has("app") ? "app" : (pType === "rust" ? "src" : (topDirs.size > 0 ? "src" : ""));

  switch (pType) {
    case "rust":
      return {
        srcPath: path.join(srcDir, "main.rs").replace(/\\/g, "/"),
        testPath: path.join(testDir, "integration_test.rs").replace(/\\/g, "/"),
        docPath: path.join(docDir, "design.md").replace(/\\/g, "/"),
        previewPath: path.join(reportDir, "preview_summary.md").replace(/\\/g, "/"),
        reportPath: path.join(reportDir, "verification_summary.json").replace(/\\/g, "/"),
        testCommands: ["cargo check", "cargo test"],
        buildCommands: ["cargo build"],
        previewCommands: ["cargo run -- --help"]
      };
    case "python": {
      const runner = pkgMgr === "uv" ? "uv run pytest" : pkgMgr === "poetry" ? "poetry run pytest" : "pytest";
      const mainPath = path.join(srcDir, "main.py").replace(/\\/g, "/");
      return {
        srcPath: mainPath,
        testPath: path.join(testDir, "test_main.py").replace(/\\/g, "/"),
        docPath: path.join(docDir, "design.md").replace(/\\/g, "/"),
        previewPath: path.join(reportDir, "preview_summary.md").replace(/\\/g, "/"),
        reportPath: path.join(reportDir, "verification_summary.json").replace(/\\/g, "/"),
        testCommands: [runner],
        buildCommands: [],
        previewCommands: [pkgMgr === "uv" ? `uv run python ${mainPath}` : `python ${mainPath}`]
      };
    }
    case "go":
      return {
        srcPath: "main.go",
        testPath: "main_test.go",
        docPath: path.join(docDir, "design.md").replace(/\\/g, "/"),
        previewPath: path.join(reportDir, "preview_summary.md").replace(/\\/g, "/"),
        reportPath: path.join(reportDir, "verification_summary.json").replace(/\\/g, "/"),
        testCommands: ["go vet ./...", "go test -v ./..."],
        buildCommands: ["go build -v ."],
        previewCommands: ["go run main.go"]
      };
    case "cpp":
      return {
        srcPath: path.join(srcDir, "main.cpp").replace(/\\/g, "/"),
        testPath: path.join(testDir, "test_main.cpp").replace(/\\/g, "/"),
        docPath: path.join(docDir, "design.md").replace(/\\/g, "/"),
        previewPath: path.join(reportDir, "preview_summary.md").replace(/\\/g, "/"),
        reportPath: path.join(reportDir, "verification_summary.json").replace(/\\/g, "/"),
        testCommands: ["ctest --output-on-failure"],
        buildCommands: ["cmake -B build", "cmake --build build"],
        previewCommands: []
      };
    case "node":
    default: {
      const isUnknown = fp?.projectType === "unknown" || !fp?.projectType;
      const isGenericDoc = fp?.projectType === "generic_doc";
      const isTs = fp?.mainFramework === "TypeScript" || fp?.coreDependencies?.some(d => d.includes("typescript"));
      
      let testCmds: string[] = [];
      let buildCmds: string[] = [];
      let previewCmds: string[] = [];
      let srcPath = path.join(srcDir, isTs ? "main.ts" : "main.js").replace(/\\/g, "/");

      if (isGenericDoc) {
        srcPath = path.join(docDir, "index.md").replace(/\\/g, "/");
        testCmds = [];
        buildCmds = [];
        previewCmds = [];
      } else if (isUnknown) {
        // 未知工程指纹：严格根据目录已有真实文件嗅探，严禁无脑默认 index.html！
        const hasPy = fs.existsSync(path.join(cwd, "requirements.txt")) || fs.existsSync(path.join(cwd, "main.py"));
        const hasTs = fs.existsSync(path.join(cwd, "tsconfig.json"));
        const hasPs = fs.existsSync(path.join(cwd, "scripts")) && fs.readdirSync(path.join(cwd, "scripts")).some(f => f.endsWith(".ps1"));
        
        if (hasPy) {
          srcPath = "main.py";
        } else if (hasTs) {
          srcPath = "src/index.ts";
        } else if (hasPs) {
          srcPath = "scripts/main.ps1";
        } else {
          srcPath = "src/index.js";
        }
        testCmds = [];
        buildCmds = [];
        previewCmds = [];
      } else {
        // 标准 Node 项目
        const hasTestScript = fp?.packageManager && fp.packageManager !== "unknown";
        // 仅在明确检测到测试脚本或已知单测框架时添加 test 命令，防止空跑失败
        testCmds = [];
        buildCmds = isTs ? [`${pkgMgr} run build`] : [];
        previewCmds = [];
      }

      return {
        srcPath,
        testPath: path.join(testDir, isTs ? "index.test.ts" : "index.test.js").replace(/\\/g, "/"),
        docPath: path.join(docDir, "design.md").replace(/\\/g, "/"),
        previewPath: path.join(reportDir, "preview_summary.md").replace(/\\/g, "/"),
        reportPath: path.join(reportDir, "verification_summary.json").replace(/\\/g, "/"),
        testCommands: testCmds,
        buildCommands: buildCmds,
        previewCommands: previewCmds
      };
    }
  }
}

/**
 * 确定性 Kahn 算法 DAG 拓扑排序与分波调度器 (Kahn's Algorithm & Wave Decomposition)
 * Ponytail 优化：若 stages 只有 1 个阶段或无任何依赖关系，直接零计算走极简流水线，杜绝虚胖开销。
 */
export function planDAGWaves(stages: BlueprintStage[]): DAGPlanResult {
  const uniqueStages: BlueprintStage[] = [];
  const seenIds = new Set<string>();
  for (const s of stages) {
    if (!seenIds.has(s.stageId)) {
      seenIds.add(s.stageId);
      uniqueStages.push(s);
    }
  }

  // 极简流水线快路径：单阶段或完全线性任务零 DAG 开销
  if (uniqueStages.length <= 1) {
    return {
      sortedStages: uniqueStages,
      waves: [{ waveIndex: 0, stages: uniqueStages, isParallel: false }],
      hasCycles: false
    };
  }

  const hasAnyExplicitDeps = uniqueStages.some(s => s.dependsOn && s.dependsOn.length > 0);
  if (!hasAnyExplicitDeps) {
    // 阶段间无任何强制先后依赖：判定为天然可并发波次
    return {
      sortedStages: uniqueStages,
      waves: [{ waveIndex: 0, stages: uniqueStages, isParallel: uniqueStages.length > 1 }],
      hasCycles: false
    };
  }

  const stageMap = new Map<string, BlueprintStage>();
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>();

  for (const s of uniqueStages) {
    stageMap.set(s.stageId, s);
    inDegree.set(s.stageId, 0);
    adjList.set(s.stageId, []);
  }

  for (const s of uniqueStages) {
    const rawDeps = s.dependsOn || [];
    const uniqueDeps = Array.from(new Set(rawDeps));
    for (const dep of uniqueDeps) {
      if (!stageMap.has(dep)) {
        console.warn(`[ToolFlow DAG Warning] Stage '${s.stageId}' depends on unknown stage '${dep}' - dependency skipped.`);
        continue;
      }
      adjList.get(dep)!.push(s.stageId);
      inDegree.set(s.stageId, (inDegree.get(s.stageId) || 0) + 1);
    }
  }

  const waves: DAGWave[] = [];
  const sortedStages: BlueprintStage[] = [];
  let readyQueue = Array.from(inDegree.entries())
    .filter(([_, degree]) => degree === 0)
    .map(([id]) => id);

  let processedCount = 0;
  let waveIdx = 0;

  while (readyQueue.length > 0) {
    const currentWaveStages = readyQueue.map(id => stageMap.get(id)!);
    waves.push({
      waveIndex: waveIdx++,
      stages: currentWaveStages,
      isParallel: currentWaveStages.length > 1
    });
    sortedStages.push(...currentWaveStages);
    processedCount += readyQueue.length;

    const nextQueue: string[] = [];
    for (const id of readyQueue) {
      const neighbors = adjList.get(id) || [];
      for (const n of neighbors) {
        const d = (inDegree.get(n) || 1) - 1;
        inDegree.set(n, d);
        if (d === 0) {
          nextQueue.push(n);
        }
      }
    }
    readyQueue = nextQueue;
  }

  const hasCycles = processedCount < uniqueStages.length;
  const cycleNodes = hasCycles
    ? Array.from(inDegree.entries()).filter(([_, d]) => d > 0).map(([id]) => id)
    : undefined;

  // 如果检测到环路，按原始顺序兜底返回并标记环路节点
  return {
    sortedStages: hasCycles ? uniqueStages : sortedStages,
    waves: hasCycles ? [{ waveIndex: 0, stages: uniqueStages, isParallel: false }] : waves,
    hasCycles,
    cycleNodes
  };
}

/**
 * 构造 A/B 架构权衡矩阵 (Option A 敏捷轻量直出 vs Option B 工业工程)
 */
export function generateABTradeOffMatrix(task: string, fp?: ProjectFingerprint): TradeOffPlan {
  const profile = inferArtifactProfile(fp);
  const isComplex = task.length > 30 || /系统|框架|重构|架构|全套|引擎|platform|workflow/i.test(task);

  const matrix: ABMatrix = {
    planA: {
      name: "Option A: 敏捷轻量型 (Lean & Agile)",
      description: `精简流水线，直接交付核心实现 (${profile.srcPath}) 并完成效果走查。`,
      pros: ["极速闭环交付", "Token 开销降低 50-70%", "零冗余设计文件"],
      cons: ["缺乏分层设计文档", "单测与门禁较为简略"],
      tokenOverhead: "minimal"
    },
    planB: {
      name: "Option B: 工业级工程型 (Industrial & Robust)",
      description: `5 阶段严谨工程：方案契约 (${profile.docPath})、模块实现、效果走查 (${profile.previewPath})、全量测试 (${profile.testPath}) 与高保真审计。`,
      pros: ["分层严谨、可维护性高", "包含【效果展示与客户共创层】", "全链路物理校验与测试覆盖"],
      cons: ["多阶段上下文交互", "Token 消耗相对中高"],
      tokenOverhead: "medium"
    },
    dimensions: [
      {
        name: "交付速度 (Velocity)",
        scoreA: 5,
        scoreB: 3,
        commentary: "Plan A 免去繁复设计文档，快速跑通核心原型"
      },
      {
        name: "客户共创深度 (Co-Creation)",
        scoreA: 4,
        scoreB: 5,
        commentary: "Plan B 具备专门的效果走查与意见征询阶段，体验掌控力更强"
      },
      {
        name: "架构健壮性 (Robustness)",
        scoreA: 3,
        scoreB: 5,
        commentary: "Plan B 具备契约文档、多 Agent 审计与 64 位 SHA 门禁"
      },
      {
        name: "长期可维护度 (Maintainability)",
        scoreA: 3,
        scoreB: 5,
        commentary: "Plan B 具备自动化测试套件与清晰设计边界"
      }
    ],
    recommendation: isComplex ? "B" : "A",
    rationale: isComplex
      ? "任务涉及多模块或系统级设计，推荐工业级工程方案保障质量与客户共创。"
      : "任务目标明确且边界清晰，推荐敏捷轻量型以兼顾速度与效果。"
  };

  return {
    id: `tradeoff_${crypto.randomBytes(3).toString("hex")}`,
    title: "A/B 架构与交付模式权衡 (A/B Trade-Off)",
    summary: matrix.rationale,
    matrix
  };
}

/**
 * 根据具体任务类型推导自适应元决策模型（大白话、场景契合、无生硬黑话、无死板假插件硬绑）
 */
export function generateUniversalMetaSlots(
  task: string,
  _tax: EcosystemTaxonomy,
  fp: ProjectFingerprint,
  tradeOff: TradeOffPlan
): TaskDiagnosis {
  const slots: TaskRequirementSlot[] = [];
  const lowerTask = task.toLowerCase();
  const isWeb = /网页|网站|web|ui|前端|页面|组件|vue|react|html|css|界面|dashboard|app|展示/i.test(lowerTask);
  const isCli = /cli|命令行|脚本|工具|tool|command|cmd|terminal/i.test(lowerTask);
  const isServiceOrBackend = /后端|api|server|服务|中间件|database|db|数据库|微服务|daemon|守护/i.test(lowerTask);

  // 通用 Ponytail 生态感知：基于任务关键词与所有已安装生态组件的语义碰撞
  const allInstalled = [
    ...((_tax && _tax.extensions) || []),
    ...((_tax && _tax.skills) || []),
    ...((_tax && _tax.prompts) || [])
  ];

  // 通用多颗粒度分词（支持单字、双字、三字与英文子串提取）
  const taskKeywords: string[] = [];
  const cleanedTask = task.replace(/[，。！？、,\.!?]/g, " ");
  for (let len = 4; len >= 2; len--) {
    for (let i = 0; i <= cleanedTask.length - len; i++) {
      const sub = cleanedTask.substring(i, i + len).trim().toLowerCase();
      if (sub && !["完成", "我想", "开发", "制作", "实现", "一个", "需要", "如何", "怎么", "通知", "提醒"].includes(sub)) {
        taskKeywords.push(sub);
      }
    }
  }
  (task.match(/[a-zA-Z0-9_-]{2,}/g) || []).forEach(w => taskKeywords.push(w.toLowerCase()));

  const matchKw = (kw: string, text: string) => {
    if (kw.length <= 1) return false; // 忽略单字避免泛误匹配
    // 对于短单词(2-3字符)，必须全字匹配或作为独立分词，避免 "pi" 命中 "pi-btw"
    if (kw === "pi" || kw === "agent" || kw === "tool") return false;
    return text.includes(kw);
  };

  let topEcosystemMatch: CapabilityItem | null = null;
  if (taskKeywords.length > 0) {
    for (const item of allInstalled) {
      // 忽略基础框架、通用运维、侧边栏等通用工具，只对具备专用领域业务能力的生态进行协同
      const ignoredTools = ["toolflow", "pi-tui-status-beautifier", "pi-btw", "input-history", "pi-rewind"];
      if (ignoredTools.includes(item.name.toLowerCase()) || ignoredTools.some(ig => item.name.toLowerCase().includes(ig))) {
        continue;
      }
      const targetText = `${item.name} ${item.description || ""} ${(item.tags || []).join(" ")}`.toLowerCase();
      const matchCount = taskKeywords.filter(kw => matchKw(kw, targetText)).length;
      if (matchCount > 0) {
        topEcosystemMatch = item;
        break;
      }
    }
  }

  // 1. Core implementation strategy
  slots.push({
    slotId: "domain_feature_preference",
    title: "1. Core Scope & Implementation Strategy",
    category: "scope",
    question: "Select the implementation scope for this task:",
    options: [
      {
        id: "opt_feature_comprehensive",
        label: "[Standard Engineering] Complete production implementation",
        description: "Clean modular interfaces, error handling, and maintainable structure",
        isRecommended: true,
        recommendedEcosystem: {
          extensions: [],
          reason: "Standard production architecture"
        }
      },
      {
        id: "opt_feature_minimal",
        label: "[Minimal Prototype] Core path only",
        description: "Focus strictly on the primary happy path with minimal code",
        isRecommended: false,
        recommendedEcosystem: {
          extensions: [],
          reason: "Lightweight rapid prototype"
        }
      }
    ]
  });

  // 2. Visual / Runtime / Interaction style
  if (isWeb) {
    slots.push({
      slotId: "visual_style_preference",
      title: "2. Visual Design & UI Aesthetic",
      category: "design",
      question: "Select your preferred visual design system:",
      options: [
        {
          id: "opt_style_modern",
          label: "[Modern Refined] Curated palette, crisp typography & subtle motion",
          description: "Balanced spacing, vector SVG icons, 8px grid, and smooth transitions",
          isRecommended: true,
          recommendedEcosystem: {
            extensions: ["pi-web-access", "@plannotator/pi-extension"],
            reason: "Live browser inspection & visual verification"
          }
        },
        {
          id: "opt_style_dark",
          label: "[Warm Dark] High-clarity dark mode with accent highlights",
          description: "Eye-friendly warm dark surfaces with crisp contrast and focus states",
          isRecommended: false,
          recommendedEcosystem: {
            extensions: ["@plannotator/pi-extension"],
            reason: "Dark theme contrast inspection"
          }
        },
        {
          id: "opt_style_minimal",
          label: "[Editorial Minimal] Swiss grid layout & generous whitespace",
          description: "Restrained typography-driven layout with zero visual clutter",
          isRecommended: false,
          recommendedEcosystem: {
            extensions: ["@plannotator/pi-extension"],
            reason: "Clean layout walkthrough"
          }
        }
      ]
    });
  } else if (isCli) {
    slots.push({
      slotId: "execution_runtime_preference",
      title: "2. Terminal Interaction & Output Style",
      category: "design",
      question: "Select the CLI interaction and output format:",
      options: [
        {
          id: "opt_cli_rich",
          label: "[Interactive TUI] Styled prompts, status indicators & clear summary",
          description: "Guided terminal prompts with color highlights and progress feedback",
          isRecommended: true,
          recommendedEcosystem: {
            extensions: ["pi-tui-status-beautifier"],
            reason: "Polished terminal status output"
          }
        },
        {
          id: "opt_cli_standard",
          label: "[Unix Pipe-Friendly] Flags + clean stdout/stderr",
          description: "Standard POSIX arguments and stream-friendly output for scripting",
          isRecommended: false,
          recommendedEcosystem: {
            extensions: [],
            reason: "Pure minimal CLI delivery"
          }
        },
        {
          id: "opt_cli_json",
          label: "[Structured Output] Supports JSON/YAML machine-readable output",
          description: "Includes structured output flags for downstream automation pipelines",
          isRecommended: false,
          recommendedEcosystem: {
            extensions: [],
            reason: "Automation pipeline integration"
          }
        }
      ]
    });
  } else if (isServiceOrBackend) {
    slots.push({
      slotId: "execution_runtime_preference",
      title: "2. Service Architecture & API Protocol",
      category: "design",
      question: "Select the backend service architecture:",
      options: [
        {
          id: "opt_backend_rest",
          label: "[Standard RESTful JSON API] Explicit routes, validation & error envelopes",
          description: "Well-structured endpoints with unified error handling and input validation",
          isRecommended: true,
          recommendedEcosystem: {
            extensions: ["pi-web-access"],
            reason: "Standard API specification alignment"
          }
        },
        {
          id: "opt_backend_fast",
          label: "[Zero-Bloat Microservice] Minimal middleware & fast cold start",
          description: "Lowest dependency footprint focused on throughput and low latency",
          isRecommended: false,
          recommendedEcosystem: {
            extensions: [],
            reason: "Lightweight backend delivery"
          }
        },
        {
          id: "opt_backend_modular",
          label: "[Layered Domain Architecture] Decoupled controller / service / store",
          description: "Clean separation of concerns for long-term extensibility and testing",
          isRecommended: false,
          recommendedEcosystem: {
            extensions: ["pi-subagents"],
            reason: "Multi-module layered organization"
          }
        }
      ]
    });
  } else {
    slots.push({
      slotId: "execution_runtime_preference",
      title: "2. Execution & Interaction Mode",
      category: "design",
      question: "Select how this solution should run:",
      options: [
        {
          id: "opt_runtime_direct",
          label: "[Out-of-the-Box Local] Zero-config direct execution",
          description: "Runs directly in the current workspace with immediate verification",
          isRecommended: true,
          recommendedEcosystem: {
            extensions: ["pi-web-access"],
            reason: "Direct workspace verification"
          }
        },
        {
          id: "opt_runtime_cli",
          label: "[On-Demand Script] Single-shot CLI invocation",
          description: "Runs once and exits cleanly, ideal for scripts and automation",
          isRecommended: false,
          recommendedEcosystem: {
            extensions: [],
            reason: "Lightweight script mode"
          }
        },
        {
          id: "opt_runtime_web",
          label: "[Visual Preview] Includes interactive preview or dashboard",
          description: "Provides a visual page or console for live inspection",
          isRecommended: false,
          recommendedEcosystem: {
            extensions: ["@plannotator/pi-extension"],
            reason: "Visual walkthrough & inspection"
          }
        }
      ]
    });
  }

  // 3. Build & Code Structure
  slots.push({
    slotId: "delivery_strategy",
    title: "3. Code Structure & Packaging",
    category: "scope",
    question: "Select how the codebase should be structured:",
    options: [
      {
        id: "opt_delivery_agile",
        label: isWeb
          ? "[Componentized] Clean HTML/CSS/JS modules"
          : "[Compact & Focused] Single-file or lean module layout",
        description: isWeb
          ? "Cleanly separated assets that run immediately in the browser"
          : "Focused core implementation with zero unnecessary scaffolding",
        isRecommended: true,
        recommendedEcosystem: {
          extensions: ["pi-web-access"],
          reason: "Modern clean structure"
        }
      },
      {
        id: "opt_delivery_modular",
        label: "[Modular Layered] Decoupled business logic & interfaces",
        description: "Separated modules and types for straightforward maintenance",
        isRecommended: false,
        recommendedEcosystem: {
          extensions: ["pi-subagents"],
          reason: "Modular decoupled delivery"
        }
      },
      {
        id: "opt_delivery_enterprise",
        label: "[Full Engineering Suite] Design contract + automated tests",
        description: "Includes architecture contract, unit test suite, and quality verification",
        isRecommended: false,
        recommendedEcosystem: {
          extensions: ["pi-subagents", "pi-rewind", "@plannotator/pi-extension"],
          reason: "End-to-end quality gate"
        }
      }
    ]
  });

  // 4. Quality & Resilience Highlights
  slots.push({
    slotId: "ai_spark_highlights",
    title: "4. Resilience & Quality Enhancements",
    category: "general",
    question: "Select additional quality safeguards:",
    options: [
      {
        id: "opt_spark_smart_assistant",
        label: "[Defensive Validation] Input validation & clear diagnostics",
        description: "Guards boundary conditions with actionable error messages",
        isRecommended: true,
        recommendedEcosystem: {
          extensions: [],
          reason: "High reliability"
        }
      },
      {
        id: "opt_spark_responsive_export",
        label: "[Configurable Hooks] Extensible options & parameters",
        description: "Exposes clean configuration parameters for future extension",
        isRecommended: false,
        recommendedEcosystem: {
          extensions: [],
          reason: "Extensibility support"
        }
      },
      {
        id: "opt_spark_none",
        label: "[Pure Minimal] Core functionality only",
        description: "Zero extra helpers; smallest possible code footprint",
        isRecommended: false,
        recommendedEcosystem: {
          extensions: [],
          reason: "Minimal footprint"
        }
      }
    ]
  });

  const dynamicGoals = [
    `Implement core functionality for "${task}"`,
    `Verify physical artifacts and pass automated checks`
  ];

  const architectSparks = [
    {
      id: "spark_graceful_error_handling",
      title: "Boundary Input Validation & Error Recovery",
      description: "Guard edge cases and invalid inputs without crashing",
      impact: "Reliability & resilience",
      isAcceptedByDefault: true
    },
    {
      id: "spark_inspect_and_verify",
      title: "Zero-Dependency Self-Check",
      description: "Include a fast runnable verification check for core logic",
      impact: "Testability & confidence",
      isAcceptedByDefault: false
    }
  ];

  if (isWeb) {
    architectSparks.push({
      id: "spark_responsive_modern_ui",
      title: "Responsive Layout & Accessibility",
      description: "Adapt cleanly across desktop and mobile viewports with keyboard support",
      impact: "UI/UX polish",
      isAcceptedByDefault: true
    });
  } else if (isCli) {
    architectSparks.push({
      id: "spark_cli_pipe_friendly",
      title: "Standard Streams & Exit Codes",
      description: "Support stdin/stdout piping and standard non-zero exit codes on failure",
      impact: "Script & CI integration",
      isAcceptedByDefault: true
    });
  } else if (isServiceOrBackend) {
    architectSparks.push({
      id: "spark_security_structured_log",
      title: "Structured Logging & Request Guards",
      description: "Emit structured JSON logs and guard against malformed payloads",
      impact: "Observability & security",
      isAcceptedByDefault: true
    });
  }

  return {
    taskDescription: task,
    researchSummary: `针对 ${fp.projectType} 工程体系与任务目标，已自动推导场景化元决策模型与动态交付目标。`,
    requirementSlots: slots,
    dynamicGoals,
    tradeOff,
    architectSparks
  };
}

/**
 * 需求深度解构与多维共创推导
 */
export async function diagnoseTaskRequirements(
  task: string,
  taxonomy: EcosystemTaxonomy,
  ctx?: ExtensionContext,
  providedFp?: ProjectFingerprint
): Promise<TaskDiagnosis> {
  const fp = providedFp || taxonomy.projectFingerprint || sniffProjectFingerprint();
  const tradeOff = generateABTradeOffMatrix(task, fp);

  const availableExtList = (taxonomy.extensions || []).map(e => e.name).join(", ");
  const availableSkillList = (taxonomy.skills || []).map(s => s.name).join(", ");
  const availableMcpList = (taxonomy.mcps || []).map(m => `mcp:${m.name}`).join(", ");
  const availablePromptList = (taxonomy.prompts || []).map(p => `prompt:${p.name}`).join(", ");
  const registeredToolList = (taxonomy.availableToolNames || []).join(", ");

  const prompt = `[ROLE: Senior Architect & Product Lead]
User Task: "${task}"
Local Environment: Project Type=${fp.projectType}, Framework=${fp.mainFramework || "none"}, PackageManager=${fp.packageManager}
Available Tools: Extensions=[${availableExtList}], Skills=[${availableSkillList}], MCP=[${availableMcpList}], Prompts=[${availablePromptList}], RegisteredTools=[${registeredToolList}]

[CRITICAL LANGUAGE & FLEXIBILITY RULES]:
1. MATCH USER LANGUAGE (ALL WORLD LANGUAGES): Detect the language of User Task ("${task}") — e.g. Chinese, English, Japanese, Korean, Spanish, French, German — and write ALL "title", "question", "label", "description", "reason", "researchSummary", "dynamicGoals", and "architectSparks" in that EXACT SAME LANGUAGE. Never mix languages.
2. TASK-ADAPTIVE FLEXIBILITY: Generate 2 to 4 decision dimensions ("requirementSlots") dynamically tailored to "${task}". Do NOT output generic corporate software boilerplate. Ask concrete, domain-specific questions that directly shape "${task}" (e.g., for a tank game: gameplay mode, visual theme, controls/difficulty; for a web app: layout, interactivity, data flow; for a CLI/backend: interface, storage, error handling).
3. ECOSYSTEM MATCHING: Only attach an installed extension/skill in "recommendedEcosystem.extensions" if it genuinely assists that option.
4. Keep "slotId" values as stable keys: first slot "domain_feature_preference", second slot "visual_style_preference" (for web/UI) or "execution_runtime_preference", third slot "delivery_strategy", optional fourth slot "ai_spark_highlights".

[OUTPUT FORMAT]:
Return ONLY valid raw JSON matching this structure:
{
  "researchSummary": "...",
  "requirementSlots": [
    {
      "slotId": "domain_feature_preference",
      "title": "1. ...",
      "category": "scope",
      "question": "...",
      "options": [
        {
          "id": "opt_feature_comprehensive",
          "label": "[...] ...",
          "description": "...",
          "isRecommended": true,
          "recommendedEcosystem": { "extensions": [], "reason": "..." }
        },
        {
          "id": "opt_feature_minimal",
          "label": "[...] ...",
          "description": "...",
          "isRecommended": false,
          "recommendedEcosystem": { "extensions": [], "reason": "..." }
        }
      ]
    }
  ],
  "architectSparks": [
    {
      "id": "spark_1",
      "title": "...",
      "description": "...",
      "impact": "...",
      "isAcceptedByDefault": true
    }
  ],
  "dynamicGoals": [
    "...",
    "..."
  ]
}`;

  const installedNames = [
    ...(taxonomy.extensions || []).map(e => e.name),
    ...(taxonomy.skills || []).map(s => s.name),
    ...(taxonomy.mcps || []).map(m => m.name)
  ];
  const ecosystemBundles = await EcosystemRadar.searchEcosystemCatalog(task, installedNames);

  let ecosystemExtensionSlot: TaskRequirementSlot | null = null;
  if (ecosystemBundles && ecosystemBundles.length > 0) {
    ecosystemExtensionSlot = {
      slotId: "slot_ecosystem_expansion",
      title: "0. Ecosystem Bundle",
      category: "ecosystem",
      question: "",
      options: ecosystemBundles.map(b => ({
        id: b.id,
        label: b.title,
        description: b.description,
        isRecommended: b.isRecommended,
        recommendedEcosystem: {
          extensions: b.packages.map(p => p.name),
          reason: b.isRecommended ? "Curated ecosystem bundle" : "Standalone"
        }
      }))
    };
  }

  // In live Pi sessions (ctx.modelRegistry + ctx.model available), invoke the LLM dynamically
  // so options, questions, and goals are tailored to the task in the user's native language.
  const canUseLLM = Boolean(
    ctx &&
    (ctx as any).modelRegistry &&
    (ctx as any).model &&
    (ctx as any).forceLLM !== false
  );

  if (canUseLLM) {
    try {
      const mr = (ctx as any).modelRegistry;
      const model = (ctx as any).model;
      const ui = (ctx as any).ui;

      const invokeModel = async (signal?: AbortSignal): Promise<string | null> => {
        const res = await mr.complete(
          model,
          {
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: prompt }],
                timestamp: Date.now()
              }
            ]
          },
          {
            maxTokens: 2000,
            temperature: 0.3,
            ...(signal ? { signal } : {})
          }
        );
        if ((res as any)?.stopReason === "aborted") return null;
        return (res.content || [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n");
      };

      let textBlocks: string | null = null;
      if (ui && typeof ui.custom === "function") {
        textBlocks = await ui.custom((tui: any, theme: any, _kb: any, done: (val: string | null) => void) => {
          const loader = new CancellableLoader(
            tui,
            (s: string) => theme.fg("accent", s),
            (s: string) => theme.fg("dim", s),
            `Analyzing task with ${model.id || "AI"}... (Esc to skip)`
          );
          loader.onAbort = () => done(null);
          invokeModel(loader.signal)
            .then(done)
            .catch(() => done(null));
          return loader;
        });
      } else {
        textBlocks = await invokeModel();
      }

      if (textBlocks) {
        const parsed = extractValidJsonObject(textBlocks);
        if (parsed.requirementSlots && Array.isArray(parsed.requirementSlots) && parsed.requirementSlots.length >= 2) {
          const finalSlots = ecosystemExtensionSlot
            ? [ecosystemExtensionSlot, ...parsed.requirementSlots]
            : parsed.requirementSlots;

          return {
            taskDescription: task,
            researchSummary: parsed.researchSummary || task,
            requirementSlots: finalSlots,
            decisionSlots: finalSlots,
            dynamicGoals: Array.isArray(parsed.dynamicGoals) && parsed.dynamicGoals.length > 0
              ? parsed.dynamicGoals
              : [task],
            tradeOff,
            architectSparks: Array.isArray(parsed.architectSparks) ? parsed.architectSparks : []
          };
        }
      }
    } catch (_err) {
      // Fallback to offline heuristic slots if LLM call fails or is aborted
    }
  }

  // 本地智能自适应元决策推导（依据任务类型：Web / CLI / Backend / 通用动态适配）
  const fallback = generateUniversalMetaSlots(task, taxonomy, fp, tradeOff);
  const finalFallbackSlots = ecosystemExtensionSlot
    ? [ecosystemExtensionSlot, ...fallback.requirementSlots]
    : fallback.requirementSlots;

  return {
    ...fallback,
    requirementSlots: finalFallbackSlots,
    decisionSlots: finalFallbackSlots,
    tradeOff
  };
}

export async function synthesizeBlueprintPlanWithLLM(
  task: string,
  diagnosis: TaskDiagnosis,
  userDecisions: Record<string, string>,
  taxonomy: EcosystemTaxonomy,
  ctx?: any
): Promise<{ primaryArtifact: string; targetLanguage: string; isFrontend: boolean; stageHeavyTools?: { stage1?: string[]; stage2?: string[]; stage3?: string[] } }> {
  // 默认由工程拓扑保底
  const fp = taxonomy.projectFingerprint || sniffProjectFingerprint();
  const profile = inferArtifactProfile(fp);

  // 极速路径：从用户任务中尝试提取明确的文件路径（例如 src/auth.ts、tests/login.test.ts 等）
  const pathMatch = task.match(/(?:[a-zA-Z0-9_\-\.\/]+\.(?:ts|js|py|rs|go|cpp|c|h|java|vue|tsx|jsx|json|md|html))/i);
  const detectedPath = pathMatch ? pathMatch[0].replace(/\\/g, "/") : "";

  const isFrontendHeuristic =
    /(网页|网站|前端|页面|组件|单页|画布|网页版|小游戏|坦克|贪吃蛇|俄罗斯方块|打砖块|五子棋|2048|扫雷|vue|react|html|css|界面|dashboard|landing\s*page|web\s*app|browser\s*game|ui(?![a-z])|canvas|frontend)/i.test(
      task
    ) && !/(backend|后端|通信|hook|服务|daemon|http\s*api|server|api|cli|terminal)/i.test(task);

  const hasFrontendFramework = Boolean(
    fp.mainFramework &&
    fp.mainFramework !== "none" &&
    /(react|vue|next|nuxt|svelte|angular)/i.test(fp.mainFramework)
  );
  const defaultPrimaryArtifact =
    detectedPath ||
    (isFrontendHeuristic && !hasFrontendFramework
      ? "index.html"
      : profile.srcPath);

  const fallback = {
    primaryArtifact: defaultPrimaryArtifact,
    targetLanguage: fp.language || (isFrontendHeuristic ? "html" : "typescript"),
    isFrontend: isFrontendHeuristic
  };

  // ⚡ 极速优先：默认跳过二次串行 LLM 往返，零延迟开工！仅在明确 forceLLM 时才触发后台请求
  const forceLLM = Boolean((ctx as any)?.forceLLM);
  if (!forceLLM) {
    return fallback;
  }

  if (!ctx || !(ctx as any).modelRegistry || !(ctx as any).model) {
    return fallback;
  }

  try {
    const mr = (ctx as any).modelRegistry;
    const model = (ctx as any).model;

    const extraHeavyTools = (taxonomy.tools || [])
      .map(t => t.name)
      .filter(name => !["read", "write", "edit", "bash", "powershell", "grep", "find"].includes(name));

    const prompt = `[ROLE: Senior Architect & Heavy Tool Allocator]
Analyze the user task, project architecture, and available heavy tools/MCPs for medium-large execution.
User Task: "${task}"
Selected Decisions: ${JSON.stringify(userDecisions)}
Workspace: ${fp.language} (${fp.projectType})
Available Heavy Tools & MCPs: ${extraHeavyTools.join(", ") || "none"}

RULES:
1. primaryArtifact: src/index.ts, main.py for backend/CLI/daemon/bot. Only use index.html for web/UI.
2. Dynamic Heavy Tool Allocation (Token Optimization):
   - ONLY allocate heavy tools/MCPs to the stage where they are genuinely required.
   - stage1: Research/perception (e.g. web_search, fetch_content, documentation MCP).
   - stage2: Implementation/orchestration (e.g. workflow, subagent, database/api MCP).
   - stage3: Review/verification (e.g. browser/playwright MCP, test/lint MCP).
   - Omit unused heavy tools to save massive context token overhead.

Output ONLY a single JSON object:
{
  "primaryArtifact": "src/index.ts",
  "targetLanguage": "typescript",
  "isFrontend": false,
  "stageHeavyTools": { "stage1": [], "stage2": [], "stage3": [] }
}`;

    const res = await mr.complete(
      model,
      {
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt }],
            timestamp: Date.now()
          }
        ]
      },
      { temperature: 0.1, maxTokens: 400 }
    );

    const textBlocks = (res.content || [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n");

    const parsed = extractValidJsonObject(textBlocks);
    if (parsed && typeof parsed.primaryArtifact === "string") {
      return {
        primaryArtifact: parsed.primaryArtifact,
        targetLanguage: parsed.targetLanguage || fp.language,
        isFrontend: Boolean(parsed.isFrontend),
        stageHeavyTools: parsed.stageHeavyTools
      };
    }
  } catch (_) {}

  return fallback;
}
export function synthesizeBlueprint(
  task: string,
  diagnosis: TaskDiagnosis,
  userDecisions: Record<string, string>,
  taxonomy: EcosystemTaxonomy,
  selectedPlan?: "A" | "B",
  customRequirements?: string[],
  llmArtifactPlan?: { primaryArtifact: string; targetLanguage?: string; isFrontend?: boolean; stageHeavyTools?: { stage1?: string[]; stage2?: string[]; stage3?: string[] } }
): Blueprint {
  const blueprintId = `bp_${crypto.randomBytes(4).toString("hex")}`;
  const fp = taxonomy.projectFingerprint || sniffProjectFingerprint();
  const profile = inferArtifactProfile(fp);
  const isWebOrUI = llmArtifactPlan !== undefined && llmArtifactPlan.isFrontend !== undefined
    ? Boolean(llmArtifactPlan.isFrontend) ||
      (/(网页|网站|前端|页面|组件|单页|画布|网页版|小游戏|坦克|贪吃蛇|俄罗斯方块|打砖块|五子棋|2048|扫雷|vue|react|html|css|界面|dashboard|landing\s*page|web\s*app|browser\s*game|ui(?![a-z])|canvas|frontend)/i.test(task) &&
       !/(backend|后端|通信|hook|服务|daemon|http\s*api|server|api|cli|terminal)/i.test(task))
    : (/(网页|网站|前端|页面|组件|单页|画布|网页版|小游戏|坦克|贪吃蛇|俄罗斯方块|打砖块|五子棋|2048|扫雷|vue|react|html|css|界面|dashboard|landing\s*page|web\s*app|browser\s*game|ui(?![a-z])|canvas|frontend)/i.test(task) &&
       !/(backend|后端|通信|hook|服务|daemon|http\s*api|server|api|cli|terminal)/i.test(task));

  const activatedExts = new Set<string>();
  const activatedSkills = new Set<string>();
  const activatedPrompts = new Set<string>();
  const reasons: string[] = [];

  for (const slot of diagnosis.requirementSlots) {
    const chosenOptId = userDecisions[slot.slotId];
    const opt = slot.options.find(o => o.id === chosenOptId) || slot.options.find(o => o.isRecommended) || slot.options[0];
    if (opt?.recommendedEcosystem) {
      opt.recommendedEcosystem.extensions?.forEach(e => activatedExts.add(e));
      opt.recommendedEcosystem.skills?.forEach(s => activatedSkills.add(s));
      opt.recommendedEcosystem.prompts?.forEach(p => activatedPrompts.add(p));
      reasons.push(`• ${slot.title}: ${opt.label} (${opt.recommendedEcosystem.reason})`);
    }
  }

  const customReqs = customRequirements || (userDecisions.custom_requirements
    ? [userDecisions.custom_requirements]
    : userDecisions.customRequirements
    ? (Array.isArray(userDecisions.customRequirements) ? userDecisions.customRequirements : [userDecisions.customRequirements])
    : undefined);

  const customReqNotice = customReqs && customReqs.length > 0
    ? `\n[Custom Requirements (Highest Priority)]: ${customReqs.join("; ")}`
    : "";

  const isOrchestrationActive = activatedExts.has("pi-subagents") || activatedExts.has("@quintinshaw/pi-dynamic-workflows");

  // 推导实机预览入口
  const livePreviewUrl = isWebOrUI
    ? `file:///${path.resolve(process.cwd(), "index.html").replace(/\\/g, "/")}`
    : undefined;
  const livePreviewCmd = profile.previewCommands && profile.previewCommands.length > 0
    ? profile.previewCommands[0]
    : isWebOrUI
    ? "start index.html"
    : undefined;

  const explicitPlan = selectedPlan || (userDecisions.__plan as "A" | "B" | undefined) || (userDecisions.plan as "A" | "B" | undefined);
  const isPlanB = explicitPlan === "B" || (!explicitPlan && (userDecisions.delivery_strategy?.includes("modular") || userDecisions.delivery_strategy?.includes("enterprise")));
  const isAgile = !isPlanB;

  // 动态提取环境中四层能力集合（完全基于 L1~L4 语义分类，彻底移除固定包名特判）
  const allExts = taxonomy.extensions || [];
  const allSkills = taxonomy.skills || [];
  const allPrompts = taxonomy.prompts || [];

  const l2PerceptionExts = allExts.filter(e => e.layer === "L2_PERCEPTION").map(e => e.name);
  const l3OrchestrationExts = allExts.filter(e => e.layer === "L3_ORCHESTRATION").map(e => e.name);
  const l4ReviewExts = allExts.filter(e => e.layer === "L4_REVIEW_GUARD").map(e => e.name);

  // 动态提取环境中实际注册与发现的工具名清单（绝不假设任何未安装的第三方插件）
  const realTools = new Set(taxonomy.availableToolNames || []);
  const hasTool = (name: string) => realTools.has(name) || (taxonomy.tools || []).some(t => t.name === name);

  // 动态感知与自动收集已安装的额外工具（如用户自定义 MCP、自定义扩展工具）
  const extraTools = (taxonomy.tools || [])
    .map(t => t.name)
    .filter(name => !["read", "write", "edit", "bash", "powershell", "grep", "find"].includes(name));

  // 🧠 核心架构：若大模型推导给出了精细的阶段重型工具编排 (stageHeavyTools)，优先采用 LLM 深度推理分配！
  const llmAlloc = llmArtifactPlan?.stageHeavyTools;
  const stage1Tools = ["read", "bash", "powershell", "grep", "find"];
  const stage2Tools = ["read", "edit", "write", "bash", "powershell", "grep", "find"];
  const stage3Tools = ["read", "bash", "powershell", "grep", "find"];

  if (isAgile) {
    stage1Tools.push("edit", "write");
  }
  ["goal_complete", "goal_blocked", "goal_wait"].forEach(t => { if (hasTool(t)) stage3Tools.push(t); });

  if (llmAlloc && typeof llmAlloc === "object") {
    // 🎯 方案 A：大模型精准推理分配，严格按需下发重型工具，彻底消灭不相关 MCP 的 Token 暴利税
    if (Array.isArray(llmAlloc.stage1)) {
      llmAlloc.stage1.forEach(t => { if (hasTool(t) && !stage1Tools.includes(t)) stage1Tools.push(t); });
    }
    if (Array.isArray(llmAlloc.stage2)) {
      llmAlloc.stage2.forEach(t => { if (hasTool(t) && !stage2Tools.includes(t)) stage2Tools.push(t); });
    }
    if (Array.isArray(llmAlloc.stage3)) {
      llmAlloc.stage3.forEach(t => { if (hasTool(t) && !stage3Tools.includes(t)) stage3Tools.push(t); });
    }
  } else {
    // 🛡️ 方案 B：无大模型分配时的启发式通用降级
    if (l2PerceptionExts.length > 0 || hasTool("web_search") || hasTool("fetch_content") || hasTool("source_check")) {
      ["web_search", "fetch_content", "source_check"].forEach(t => { if (hasTool(t)) stage1Tools.push(t); });
    }
    if (hasTool("mcp")) stage1Tools.push("mcp");
    if (hasTool("mcpScript")) stage1Tools.push("mcpScript");
    if (hasTool("workflow")) stage1Tools.push("workflow");
    extraTools.forEach(toolName => {
      const item = (taxonomy.tools || []).find(t => t.name === toolName);
      if (item && item.layer === "L2_PERCEPTION" && !stage1Tools.includes(toolName)) stage1Tools.push(toolName);
      if (!stage2Tools.includes(toolName)) stage2Tools.push(toolName);
      if (item && item.layer === "L4_REVIEW_GUARD" && !stage3Tools.includes(toolName)) stage3Tools.push(toolName);
    });
    if (hasTool("workflow")) stage2Tools.push("workflow");
    if (hasTool("subagent")) stage2Tools.push("subagent");
    if (hasTool("mcp")) stage2Tools.push("mcp");
    if (hasTool("mcpScript")) stage2Tools.push("mcpScript");
    if (hasTool("workflow")) stage3Tools.push("workflow");
    if (hasTool("mcp")) stage3Tools.push("mcp");
    if (hasTool("mcpScript")) stage3Tools.push("mcpScript");
  }
  // 交付物产物：若 LLM 推导给出了明确产物则 100% 采纳，否则由工程拓扑保底
  const defaultSrcPath = (llmArtifactPlan && llmArtifactPlan.primaryArtifact)
    ? llmArtifactPlan.primaryArtifact
    : (isWebOrUI ? "index.html" : profile.srcPath);
  const stage2VerificationCommands = (!isWebOrUI && (profile.buildCommands?.length || profile.testCommands?.length))
    ? [...(profile.buildCommands || []), ...(profile.testCommands || [])]
    : undefined;

  // 任务轻重自适应探测 (Adaptive Task Complexity Router)
  // 识别是否属于日常单点改动/局部修补/微任务，打破僵化的字符数硬限制
  const taskLower = (task || "").toLowerCase();
  const explicitMicro = userDecisions.__microTask === "true" || userDecisions.__microTask === ("true" as any);
  
  // 智能微任务判别：
  // 1. 包含明确的单点修改、修补、微调、日志、类型补充等意图动词
  const hasMicroActionVerb = /(修复|fix|修改|改一下|微调|format|加个注释|添加注释|加注释|补充类型|类型修复|换个颜色|改个文案|改文案|加个字段|加字段|增加字段|输出日志|加log|加打印)/i.test(taskLower);
  // 2. 没有强烈的全局多模块架构、系统级新建或全流程生命周期诉求
  const hasHeavyArchitecturalScope = /(重构系统|架构设计|全新系统|端到端开发|从头开发|设计整个|全栈系统|从零构建|新建工程|大型系统|全量迁移)/i.test(taskLower);
  // 3. 长度在适度范围内（80字以内单句指令），或者指名了具体的单个文件名/函数名
  const isTargetedOrConcise = taskLower.length <= 80 || /\.(ts|js|py|rs|go|json|css|html|md)\b/i.test(taskLower);

  const isLightweightIntent = hasMicroActionVerb && !hasHeavyArchitecturalScope && isTargetedOrConcise;

  const isMicroTask = !isPlanB && (explicitMicro || isLightweightIntent);

  let rawStages: BlueprintStage[];
  if (isMicroTask) {
    rawStages = [
      {
        stageId: "stage_1_direct_execution",
        title: "Direct Execution & Verification",
        roleProfile: "quick_specialist",
        coreObjective: `Apply the requested changes directly, verify, and deliver.${customReqNotice}`,
        boundCapabilities: {
          extensions: [],
          skills: []
        },
        expectedArtifact: defaultSrcPath,
        expectedArtifacts: [defaultSrcPath],
        targetPatterns: ["src/**", "lib/**", "tests/**", "*"],
        artifactContract: `Produce verified code changes.`,
        verificationCommands: stage2VerificationCommands,
        allowedTools: ["read", "edit", "write", "bash", "powershell", "grep", "find"],
        tokenCostNotice: "Direct execution, 0 stage overhead"
      }
    ];
  } else {
    rawStages = isAgile
      ? [
        {
          stageId: "stage_1_design",
          title: "Design Contract",
          roleProfile: "system_architect",
          coreObjective: `Define the ${fp.projectType} architecture and interface contract in ${profile.docPath}.${customReqNotice}`,
          boundCapabilities: {
            extensions: l2PerceptionExts.slice(0, 2),
            prompts: Array.from(activatedPrompts).filter(p => p.includes("research") || p.includes("clarify"))
          },
          expectedArtifact: profile.docPath,
          expectedArtifacts: [profile.docPath],
          targetPatterns: ["docs/**", "*.md"],
          artifactContract: `Module architecture and interface contract written to ${profile.docPath}.${customReqNotice ? " Constraints: " + customReqNotice : ""}`,
          allowedTools: stage1Tools,
          tokenCostNotice: "Establish clear design contract"
        },
        {
          stageId: "stage_2_implementation_preview",
          title: "Implementation & Live Walkthrough",
          roleProfile: isOrchestrationActive ? "subagent_orchestrator" : "principal_engineer",
          dependsOn: ["stage_1_design"],
          coreObjective: `Implement core functionality in ${defaultSrcPath} following the design contract and run a live walkthrough.`,
          isInteractiveCoCreation: true,
          previewUrl: livePreviewUrl,
          previewCommand: livePreviewCmd,
          boundCapabilities: {
            extensions: Array.from(activatedExts),
            skills: Array.from(activatedSkills)
          },
          expectedArtifact: defaultSrcPath,
          expectedArtifacts: [defaultSrcPath],
          targetPatterns: ["src/**", "lib/**", "*.ts", "*.js", "*.rs", "*.py", "*.go", "*.html"],
          artifactContract: `Complete and verify ${defaultSrcPath}.`,
          verificationCommands: stage2VerificationCommands,
          allowedTools: stage2Tools,
          tokenCostNotice: "Combined implementation & walkthrough"
        },
        {
          stageId: "stage_3_verification_delivery",
          title: "Verification & Delivery Receipt",
          roleProfile: "quality_auditor",
          dependsOn: ["stage_2_implementation_preview"],
          coreObjective: `Run automated verification and SHA-256 artifact checks, then write the delivery report.`,
          boundCapabilities: {
            extensions: Array.from(activatedExts).filter(e => e.includes("goal") || e.includes("tui")),
            skills: Array.from(activatedSkills)
          },
          expectedArtifact: profile.reportPath,
          expectedArtifacts: [profile.reportPath, ...(isWebOrUI || !profile.testPath ? [] : [profile.testPath])],
          targetPatterns: ["reports/**", "tests/**", "docs/**", "*.test.*", "*.spec.*"],
          artifactContract: `Verification report with SHA-256 checksums at ${profile.reportPath}.`,
          verificationCommands: !isWebOrUI && profile.testCommands && profile.testCommands.length > 0 ? profile.testCommands : undefined,
          allowedTools: stage3Tools,
          isReviewStage: true,
          reviewIsolation: {
            enabled: true,
            requireColdStart: true,
            diffOnlyContext: true
          },
          tokenCostNotice: "Automated verification & delivery receipt"
        }
      ]
    : [
        {
          stageId: "stage_1_design",
          title: "Design Contract",
          roleProfile: "system_architect",
          coreObjective: `Author the ${fp.projectType} architecture specification and design contract in ${profile.docPath}.${customReqNotice}`,
          boundCapabilities: {
            extensions: l2PerceptionExts.slice(0, 2),
            prompts: Array.from(activatedPrompts).filter(p => p.includes("research") || p.includes("clarify"))
          },
          expectedArtifact: profile.docPath,
          expectedArtifacts: [profile.docPath],
          targetPatterns: ["docs/**", "*.md"],
          artifactContract: `Complete design specification written to ${profile.docPath}.${customReqNotice ? " Constraints: " + customReqNotice : ""}`,
          allowedTools: stage1Tools,
          tokenCostNotice: "Upfront design contract"
        },
        {
          stageId: "stage_2_implementation",
          title: "Core Implementation",
          roleProfile: isOrchestrationActive ? "subagent_orchestrator" : "principal_engineer",
          dependsOn: ["stage_1_design"],
          coreObjective: `Implement core modules in ${defaultSrcPath} strictly following Stage 1's design contract.`,
          boundCapabilities: {
            extensions: Array.from(activatedExts).filter(e => e.includes("subagents") || e.includes("workflows") || e.includes("rewind")),
            skills: Array.from(activatedSkills)
          },
          expectedArtifact: defaultSrcPath,
          expectedArtifacts: [defaultSrcPath],
          targetPatterns: ["src/**", "lib/**", "*.ts", "*.js", "*.rs", "*.py", "*.go", "*.html"],
          artifactContract: `Complete ${defaultSrcPath} matching the design contract.`,
          verificationCommands: stage2VerificationCommands,
          allowedTools: stage2Tools,
          tokenCostNotice: "Focused core implementation"
        },
        {
          stageId: "stage_3_preview_cocreation",
          title: "Live Walkthrough & Preview",
          roleProfile: "experience_consultant",
          dependsOn: ["stage_2_implementation"],
          coreObjective: "Launch live preview or walkthrough, verify interactive UX, and record walkthrough observations.",
          isInteractiveCoCreation: true,
          proactiveInquiryPrompt: "Core implementation is complete. Would you like any adjustments to interaction, layout, or styling?",
          previewUrl: livePreviewUrl,
          previewCommand: livePreviewCmd,
          boundCapabilities: {
            extensions: Array.from(activatedExts).filter(e => e.includes("plannotator") || e.includes("web")),
            skills: Array.from(activatedSkills).filter(s => s.includes("plannotator"))
          },
          expectedArtifact: profile.previewPath,
          expectedArtifacts: [profile.previewPath],
          targetPatterns: ["reports/**", "docs/**", "*.md"],
          artifactContract: `Walkthrough summary written to ${profile.previewPath}.`,
          verificationCommands: profile.previewCommands && profile.previewCommands.length > 0 ? profile.previewCommands : undefined,
          allowedTools: hasTool("mcp") ? ["read", "write", "bash", "powershell", "grep", "find", "mcp"] : ["read", "write", "bash", "powershell", "grep", "find"],
          tokenCostNotice: "Interactive walkthrough & UX check"
        },
        {
          stageId: "stage_4_testing",
          title: "Automated Testing",
          roleProfile: "test_engineer",
          dependsOn: ["stage_3_preview_cocreation"],
          coreObjective: `Write automated tests (${profile.testPath}) and verify all checks pass.`,
          boundCapabilities: {
            extensions: Array.from(activatedExts).filter(e => e.includes("goal")),
            skills: Array.from(activatedSkills)
          },
          expectedArtifact: profile.testPath,
          expectedArtifacts: [profile.testPath],
          targetPatterns: ["tests/**", "*.test.*", "*.spec.*"],
          artifactContract: `Test suite passing at ${profile.testPath}.`,
          verificationCommands: profile.testCommands,
          allowedTools: stage2Tools.concat(stage3Tools.filter(t => !stage2Tools.includes(t))),
          tokenCostNotice: "Automated test gate"
        },
        {
          stageId: "stage_5_audit_delivery",
          title: "Final Delivery Receipt",
          roleProfile: "quality_auditor",
          dependsOn: ["stage_4_testing"],
          coreObjective: `Generate the final verification summary and SHA-256 artifact ledger.`,
          boundCapabilities: {
            extensions: Array.from(activatedExts).filter(e => e.includes("goal") || e.includes("tui")),
            skills: []
          },
          expectedArtifact: profile.reportPath,
          expectedArtifacts: [profile.reportPath],
          targetPatterns: ["reports/**", "docs/**"],
          artifactContract: `Final verification summary at ${profile.reportPath}.`,
          allowedTools: ["read", "write", "bash", "powershell", "grep", "find", "mcp"],
          isReviewStage: true,
          reviewIsolation: {
            enabled: true,
            requireColdStart: true,
            diffOnlyContext: true
          },
          tokenCostNotice: "Final settlement & delivery receipt"
        }
      ];
  }

  // 执行 Kahn DAG 拓扑排序与分波解算
  const dagResult = planDAGWaves(rawStages);

  // 深度生态方法级与 SOP 规则物理灌注 (Deep MCP & Deep Skills)
  const availableMcpServers = (taxonomy?.mcps || []).map(m => m.name.replace("mcp__", ""));
  const discoveredSkills = (taxonomy?.skills || []).map(s => ({ name: s.name, filePath: s.filePath }));
  const enrichedStages = dagResult.sortedStages.map(s => {
    bindDeepEcosystemToStage(s, availableMcpServers, discoveredSkills);
    return s;
  });

  return {
    blueprintId,
    task,
    createdAt: Date.now(),
    projectFingerprint: fp,
    userChoices: userDecisions,
    customRequirements: customReqs,
    activatedCapabilities: {
      extensions: Array.from(activatedExts),
      skills: Array.from(activatedSkills),
      prompts: Array.from(activatedPrompts)
    },
    tokenEfficiencySummary: reasons.join("\n"),
    stages: enrichedStages,
    dagWaves: dagResult.waves,
    dynamicGoals: diagnosis.dynamicGoals || [
      `实现「${task}」核心功能与关键业务链路`,
      `确保代码结构整洁并提供实机走查与验收验证`
    ]
  };
}

/**
 * 动作指令诱导合成器：根据阶段属性精准注入高阶工具（workflow/goal/subagent）使用诉求，防止退化到低效裸写
 */
export function generateStageActionPrompt(
  stage: BlueprintStage,
  stageIndex: number,
  totalStages: number,
  isReview: boolean = false
): string {
  const allowed = stage.allowedTools || [];
  const hasWorkflow = allowed.includes("workflow");
  const hasGoal = allowed.includes("goal") || allowed.includes("goal_complete");
  const hasSubagent = allowed.includes("subagent");
  const hasMcp = allowed.includes("mcp");

  // 如果阶段绑定了特定 Skills，生成紧凑 SOP 指令建议
  const boundSkills = stage.boundCapabilities?.skills || [];
  const skillAdvice = stage.skillContract
    ? ` (Enforced Skill: '${stage.skillContract.skillName}' [${stage.skillContract.rules[0] || "遵循SOP"}])`
    : boundSkills.length > 0 ? ` (Tip: Leverage skill '${boundSkills[0]}')` : "";

  // 如果阶段绑定了具体的 MCP 方法，直接打出无幻觉的精准调用模版
  const mcpTemplateAdvice = (stage.mcpToolBindings && stage.mcpToolBindings.length > 0)
    ? `\nRecommended MCP Call: ${stage.mcpToolBindings[0].template}`
    : "";

  if (isReview) {
    if (hasGoal) {
      return `执行测试套件与走查验证，全部通过后确认交付。${skillAdvice}${mcpTemplateAdvice}`;
    }
    if (hasWorkflow) {
      return `可通过 'workflow({ name: "code-review" })' 走查或直接运行测试门禁。${skillAdvice}${mcpTemplateAdvice}`;
    }
    return `执行测试验证并客观走查关键变更。${skillAdvice}${mcpTemplateAdvice}`;
  }

  // 架构/设计/调研阶段
  if (stage.stageId.includes("design") || stage.title.includes("设计") || stage.title.includes("调研")) {
    if (hasWorkflow) {
      return `CRITICAL ACTION: You MUST invoke the 'write' tool to output the architectural specification into '${stage.expectedArtifact}' now. (For deep exploration, you may leverage 'workflow({ name: "deep-research" })'). Do NOT merely discuss or think.${skillAdvice}${mcpTemplateAdvice}`;
    }
    return `CRITICAL ACTION: You MUST invoke the 'write' tool to create the design specification file '${stage.expectedArtifact}' immediately. Do NOT merely discuss or think without writing.${skillAdvice}${mcpTemplateAdvice}`;
  }

  // 编码/实现阶段
  if (stage.stageId.includes("implementation") || stage.title.includes("编码") || stage.title.includes("制作")) {
    const qualityWarning = "【交付质量硬指标】严防粗制滥造：设计与视觉重灾区必须严谨打造！UI/图案绝不可用单调色块/方块敷衍，必须配备专业调色盘、精细矢量 SVG 图案/图标、一致网格间距与过渡动效；逻辑严密模块化，绝不输出玩具级半成品。";
    if (hasWorkflow || hasSubagent) {
      return `实现核心功能逻辑，可按需调用 workflow/subagent 进行并行分发或直接编写落地。${qualityWarning}${skillAdvice}${mcpTemplateAdvice}`;
    }
    return `编写实现代码并交付落盘 (${stage.expectedArtifact})。${qualityWarning}${skillAdvice}${mcpTemplateAdvice}`;
  }

  // 走查/调优阶段
  if (stage.stageId.includes("preview") || stage.title.includes("走查")) {
    return `启动本地预览/走查，切实验证实际交互效果、视觉设计与图案质感（重点走查设计是否粗糙、图案是否简陋、间距动效是否自然），查漏补缺，拒绝形式主义。${skillAdvice}${mcpTemplateAdvice}`;
  }

  // 单测/验收/门禁阶段
  if (hasGoal || stage.stageId.includes("gate") || stage.title.includes("验收") || stage.title.includes("门禁")) {
    if (hasGoal) {
      return `运行测试验证并通过 goal_complete 门禁确认交付。${skillAdvice}${mcpTemplateAdvice}`;
    }
    return `运行测试套件验证功能完备性。${skillAdvice}${mcpTemplateAdvice}`;
  }

  return `编写并落实交付成果 (${stage.expectedArtifact || "目标产物"})。${skillAdvice}${mcpTemplateAdvice}`;
}
