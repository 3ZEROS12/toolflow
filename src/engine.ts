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

  // 1. 核心方案路径与工具流协同 (标准技术方案槽位)
  slots.push({
    slotId: "domain_feature_preference",
    title: "1. 核心功能与技术实现策略 (技术方案)",
    category: "scope",
    question: `针对「${task}」，请选择期望的技术实现路径：`,
    options: [
      {
        id: "opt_feature_comprehensive",
        label: "[标准工程方案] 完整业务实现 (推荐)",
        description: "按照现代软件工程化标准组织代码与接口契约，结构清晰且易于维护",
        isRecommended: true,
        recommendedEcosystem: {
          extensions: [],
          reason: "标准工程化架构落地"
        }
      },
      {
        id: "opt_feature_minimal",
        label: "[极简方案] 核心主干功能",
        description: "聚焦最核心的单点业务链路快速验证可行性，保持轻量纯粹",
        isRecommended: false,
        recommendedEcosystem: {
          extensions: [],
          reason: "轻量原型快速落地"
        }
      }
    ]
  });

  // 2. 视觉基调 / 交互形态 (自适应 Web / CLI / Backend / 通用)
  if (isWeb) {
    slots.push({
      slotId: "visual_style_preference",
      title: "2. 视觉设计系统与呈现质感 (UI/视觉)",
      category: "design",
      question: "请选择偏好的视觉设计系统与呈现质感：",
      options: [
        {
          id: "opt_style_modern",
          label: "[高质感现代设计] 专业调色盘/精细矢量图标/平滑微动效 (推荐)",
          description: "专业级现代 UI：精选调色盘、精细矢量 SVG 图标资产、8px 网格与优雅微动效",
          isRecommended: true,
          recommendedEcosystem: {
            extensions: ["pi-web-access", "@plannotator/pi-extension"],
            reason: "检索精美UI规范并在浏览器中实时走查体验"
          }
        },
        {
          id: "opt_style_dark",
          label: "[深邃极客/暗黑] 霓虹点缀/高对比度/精致光影质感",
          description: "科技暗黑基调、精致阴影/发光渐变与高对比度重点强调，视觉冲击强烈",
          isRecommended: false,
          recommendedEcosystem: {
            extensions: ["@plannotator/pi-extension"],
            reason: "走查暗黑主题对比度与细节"
          }
        },
        {
          id: "opt_style_minimal",
          label: "[典雅极简/大厂排版] 留白呼吸感/精美字体层次/克制衬色",
          description: "拒绝粗陋简陋，基于瑞士平面设计法则，以高级克制排版与严谨间距呈现",
          isRecommended: false,
          recommendedEcosystem: {
            extensions: ["@plannotator/pi-extension"],
            reason: "快速走查基础排版"
          }
        }
      ]
    });
  } else if (isCli) {
    slots.push({
      slotId: "execution_runtime_preference",
      title: "2. 交互体验与输出形态 (终端交互)",
      category: "design",
      question: "请选择命令行工具的交互与输出体验：",
      options: [
        {
          id: "opt_cli_rich",
          label: "[高质感终端] 交互式提示、彩色高亮与进度条 (推荐)",
          description: "带友好的交互式引导、彩色语法高亮和动态进度条，直观易用",
          isRecommended: true,
          recommendedEcosystem: {
            extensions: ["pi-tui-status-beautifier"],
            reason: "美化终端输出与状态展示"
          }
        },
        {
          id: "opt_cli_standard",
          label: "[标准无废话] 简洁参数输入与纯净输出",
          description: "支持标准标准输入输出与管道重定向，适合脚本管道集成",
          isRecommended: false,
          recommendedEcosystem: {
            extensions: [],
            reason: "极简纯粹 CLI 交付"
          }
        },
        {
          id: "opt_cli_json",
          label: "[结构化集成] 支持 JSON/YAML 多格式输出",
          description: "提供机器友好的结构化输出开关，方便与其他工具链互通",
          isRecommended: false,
          recommendedEcosystem: {
            extensions: [],
            reason: "自动化工具链标准集成"
          }
        }
      ]
    });
  } else if (isServiceOrBackend) {
    slots.push({
      slotId: "execution_runtime_preference",
      title: "2. 架构模式与通信协议 (后端服务)",
      category: "design",
      question: "请选择服务架构与接口协议规范：",
      options: [
        {
          id: "opt_backend_rest",
          label: "[标准 RESTful/JSON API] 开箱即用且规范完整 (推荐)",
          description: "提供规范的 RESTful 端点定义、统一错误处理与请求校验",
          isRecommended: true,
          recommendedEcosystem: {
            extensions: ["pi-web-access"],
            reason: "遵循行业最新 API 设计标准规范"
          }
        },
        {
          id: "opt_backend_fast",
          label: "[极简轻量服务] 最小依赖、秒级冷启动",
          description: "精简中间件，依赖最少化，专注于高并发与极速响应",
          isRecommended: false,
          recommendedEcosystem: {
            extensions: [],
            reason: "轻量极速后端交付"
          }
        },
        {
          id: "opt_backend_modular",
          label: "[领域驱动分层] 控制器/服务/数据模型解耦",
          description: "标准三层或 DDD 分层架构，便于团队协作与长期扩展",
          isRecommended: false,
          recommendedEcosystem: {
            extensions: ["pi-subagents", "@quintinshaw/pi-dynamic-workflows"],
            reason: "多智能体协作划分服务各分层模块"
          }
        }
      ]
    });
  } else {
    slots.push({
      slotId: "execution_runtime_preference",
      title: "2. 交互形态与运行模式 (交互模式)",
      category: "design",
      question: "请选择您偏好的交互形态与部署运行方式：",
      options: [
        {
          id: "opt_runtime_direct",
          label: "[直接运行] 本地开箱即用 (推荐)",
          description: "无需繁琐配置，直接在当前环境一键运行并验证",
          isRecommended: true,
          recommendedEcosystem: {
            extensions: ["pi-web-access"],
            reason: "获取最新环境配置与开箱范式"
          }
        },
        {
          id: "opt_runtime_cli",
          label: "[极简命令行] 终端单次按需调用",
          description: "即敲即用，执行完立即退出，适合自动化脚本或轻量测试",
          isRecommended: false,
          recommendedEcosystem: {
            extensions: [],
            reason: "轻量 CLI 模式"
          }
        },
        {
          id: "opt_runtime_web",
          label: "[可视化界面] 包含走查界面或控制面板",
          description: "提供直观的网页走查或控制台，方便实时监控与交互",
          isRecommended: false,
          recommendedEcosystem: {
            extensions: ["@plannotator/pi-extension"],
            reason: "提供直观走查与状态验证"
          }
        }
      ]
    });
  }

  // 3. 构建方式与代码结构 (工程架构)
  slots.push({
    slotId: "delivery_strategy",
    title: "3. 构建方式与代码结构 (构建结构)",
    category: "scope",
    question: "请选择代码构建方式：",
    options: [
      {
        id: "opt_delivery_agile",
        label: isWeb
          ? "[组件化构建] 开箱即用 (推荐)"
          : "[极简轻量] 单文件或轻量模块 (推荐)",
        description: isWeb
          ? "HTML/CSS/JS 解耦，开箱即可在浏览器直接运行"
          : "聚焦核心逻辑，开箱即用",
        isRecommended: true,
        recommendedEcosystem: {
          extensions: ["pi-web-access"],
          reason: "获取现代标准规范"
        }
      },
      {
        id: "opt_delivery_modular",
        label: "[标准分层] 模块解耦与分层架构",
        description: "业务逻辑与接口分层，便于维护",
        isRecommended: false,
        recommendedEcosystem: {
          extensions: ["pi-subagents", "@quintinshaw/pi-dynamic-workflows"],
          reason: "多模块解耦落地"
        }
      },
      {
        id: "opt_delivery_enterprise",
        label: "[完整工程] 包含文档与自动化验证",
        description: "配备完整设计文档、单测与质量门禁",
        isRecommended: false,
        recommendedEcosystem: {
          extensions: ["pi-subagents", "pi-rewind", "@plannotator/pi-extension"],
          reason: "全自动化质量保障"
        }
      }
    ]
  });

  // 4. 特色亮点与扩展考量 (特色亮点)
  slots.push({
    slotId: "ai_spark_highlights",
    title: "4. 特色亮点与扩展考量 (附加能力)",
    category: "general",
    question: "请选择附加功能偏好：",
    options: [
      {
        id: "opt_spark_smart_assistant",
        label: "[容错与反馈] 清晰运行提示 (推荐)",
        description: "增加输入校验与友好错误提示，避免异常崩溃",
        isRecommended: true,
        recommendedEcosystem: {
          extensions: [],
          reason: "高可用体验保障"
        }
      },
      {
        id: "opt_spark_responsive_export",
        label: "[接口扩展] 预留配置化接口",
        description: "预留入参配置，方便未来二次开发",
        isRecommended: false,
        recommendedEcosystem: {
          extensions: [],
          reason: "扩展能力支持"
        }
      },
      {
        id: "opt_spark_none",
        label: "[纯净精简] 仅保留核心主功能",
        description: "不添加额外代码，保持最小交付体积",
        isRecommended: false,
        recommendedEcosystem: {
          extensions: [],
          reason: "极简纯粹交付"
        }
      }
    ]
  });

  // 动态构建通用目标与架构师灵感推荐 (Architect Sparks: 基础通用能力 + 场景特化能力融合)
  const dynamicGoals = [
    `实现「${task}」核心功能与关键业务链路`,
    `确保代码结构整洁并提供实机走查与验收验证`
  ];

  // 1. 软件工程通用能力增益 (Universal Capabilities)
  const architectSparks = [
    {
      id: "spark_graceful_error_handling",
      title: "健壮容错与友好提示",
      description: "增强边界条件与输入校验保护，避免异常直接中断流程",
      impact: "健壮性与稳定性",
      isAcceptedByDefault: true
    },
    {
      id: "spark_inspect_and_verify",
      title: "零依赖自省与快速自测",
      description: "内置轻量快速自测与健康检查逻辑，便于验证产物完备性",
      impact: "可测试性与交付质量",
      isAcceptedByDefault: false
    }
  ];

  // 2. 领域场景特化能力增益 (Domain-Specific Capabilities)
  if (isWeb) {
    architectSparks.push({
      id: "spark_responsive_modern_ui",
      title: "响应式适配与交互美化",
      description: "自适应移动端与桌面端视口，增加微动效与优雅无障碍支持",
      impact: "UI/UX 体验提升",
      isAcceptedByDefault: true
    });
  } else if (isCli) {
    architectSparks.push({
      id: "spark_cli_pipe_friendly",
      title: "管道流支持与丰富退出码",
      description: "支持标准输入输出流管道传输 (stdin/stdout) 并提供标准 Exit Code",
      impact: "脚本与自动化集成友好",
      isAcceptedByDefault: true
    });
  } else if (isServiceOrBackend) {
    architectSparks.push({
      id: "spark_security_structured_log",
      title: "结构化日志与安全鉴权防御",
      description: "集成 JSON 格式结构化请求追踪与基础防刷限流守卫",
      impact: "可观测性与安全防御",
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
Task: "${task}"
Local Environment: Project Type=${fp.projectType}, Framework=${fp.mainFramework || "none"}, PackageManager=${fp.packageManager}
Available Tools: Extensions=[${availableExtList}], Skills=[${availableSkillList}], MCP=[${availableMcpList}], Prompts=[${availablePromptList}], RegisteredTools=[${registeredToolList}]

[MISSION: TAILORED DECISION MATRIX FOR THIS SPECIFIC TASK]
You must dynamically generate a tailored, plain-language 4-dimension decision matrix and 2-4 concrete dynamic goals for "${task}".
No rigid templates, no tech jargon, no generic robotic wording. Everything must be 100% relevant to the user's specific task.

[CORE PHILOSOPHY: ECOSYSTEM & TOOL MANAGEMENT FIRST (PONYTAIL PRINCIPLE)]
You are a TOOL-FLOW ORCHESTRATOR & ECOSYSTEM MANAGER.
Your mission is to understand the true essence of "${task}".
- ECOSYSTEM MATCHING: ONLY recommend an installed extension/tool/skill IF it has strong, direct, real-world semantic relevance to the task domain! DO NOT force or hallucinate unrelated tools (e.g. NEVER recommend auxiliary note/query tools like 'pi-btw' or rollback tools like 'pi-rewind' as core architecture for WeChat/Backend/Network tasks). If no installed tool is directly relevant, recommend clean custom development or standard library implementation.
- ARTIFACT REASONING: Analyze what kind of software "${task}" truly is! If it is a backend integration, message hook, daemon, bot, or CLI, the primary deliverable should be 'src/index.ts', 'src/main.ts', or 'src/bot.ts'—NEVER output 'index.html' unless the task explicitly asks for a web frontend or browser game!

[4 DIMENSIONS TO GENERATE]:
1. domain_feature_preference: "1. 方案路径与工具流协同 (推荐路径)"
   - If installed tools match the task: First option MUST be "[推荐] 现成工具流协同方案" (explaining how to directly use installed extensions/skills with zero or minimal boilerplate code).
   - Other options: "[自研] 从零定制开发" (custom implementation in workspace) or "[轻量] 极简核心原型".
2. visual_style_preference OR execution_runtime_preference:
   - For UI/Web/Frontend tasks: "2. 视觉基调与交互质感 (交互与样式)" with 3 distinct aesthetic/UX choices tailored to "${task}".
   - For CLI/Backend/Script tasks: "2. 交互体验与运行模式 (交互模式)" with 3 distinct runtime/interaction styles tailored to "${task}".
3. delivery_strategy: "3. 构建方式与代码结构 (工程架构)"
   - Question: Ask how the code and project structure should be organized for "${task}".
   - Provide 3 distinct options (e.g. Clean zero-config standalone, Modular decoupled, Full-spec industrial).
4. ai_spark_highlights: "4. 特色亮点与体验加分项 (特色亮点)"
   - Question: Suggest 2-3 unexpected, delightful spark features specifically tailored to "${task}".
   - Provide 3 options (Rich delightful spark feature, Practical utility feature, Keep minimal & pure).

[ECOSYSTEM ATTACHMENT RULES]:
- Bind recommended extensions/skills ONLY from the Available Tools list if they genuinely assist the choice.
- For options that leverage installed tools, explicitly list them in recommendedEcosystem.extensions and explain the direct benefit.
- Every option MUST have: id, label (starting with tag e.g. "[完整方案]"), description (plain-language explanation of what the user gets), isRecommended (true for the best choice in the slot), recommendedEcosystem: { extensions: [...], reason: "plain-language value to user" }.

[DYNAMIC GOALS]:
- Formulate 2-4 specific, actionable milestone goals tailored to "${task}" (e.g. "构建可交互的宠物卡片与领养表单", "提供浏览器即开即用的实机走查体验").

[OUTPUT FORMAT]:
Return ONLY valid raw JSON matching this structure (no markdown fences, or wrapped in \`\`\`json):
{
  "researchSummary": "针对「${task}」已结合当前工程环境与业务特征完成场景化推导。",
  "requirementSlots": [
    {
      "slotId": "domain_feature_preference",
      "title": "1. 核心功能与业务范围 (功能范围)",
      "category": "scope",
      "question": "...",
      "options": [
        {
          "id": "opt_feature_comprehensive",
          "label": "[完整方案] ... (推荐)",
          "description": "...",
          "isRecommended": true,
          "recommendedEcosystem": { "extensions": ["pi-web-access"], "reason": "..." }
        },
        ...
      ]
    },
    ...
  ],
  "dynamicGoals": [
    "...",
    "..."
  ]
}`;

  // 先检查全网公认生态插件（Ecosystem Radar）是否存在最优套餐方案
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
      title: "0. 生态扩展提议 (公认最优解套件推荐)",
      category: "ecosystem",
      question: "针对当前任务，社区/官方已存在公认极佳的专用扩展与 MCP 方案。是否一键装配？",
      options: ecosystemBundles.map(b => ({
        id: b.id,
        label: b.title,
        description: b.description,
        isRecommended: b.isRecommended,
        recommendedEcosystem: {
          extensions: b.packages.map(p => p.name),
          reason: b.isRecommended ? "引入社区公认神装，避免重复造轮子" : "纯净开发"
        }
      }))
    };
  }

  // ⚡ 极速优先：默认直接采用本地毫秒级工程指纹与槽位推导，零延迟、零 Token 开销秒出决策舱！
  // 仅在明确传入 { forceLLM: true } 且任务极为模糊时才降级为后台推理
  const forceLLM = Boolean((ctx as any)?.forceLLM);
  if (!forceLLM) {
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

  // 优先通过 pi 官方 modelRegistry 调用当前会话活跃大模型进行 100% 动态实时推理
  if (ctx && (ctx as any).modelRegistry && (ctx as any).model) {
    try {
      const mr = (ctx as any).modelRegistry;
      const model = (ctx as any).model;
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
          maxTokens: 2500,
          temperature: 0.3
        }
      );

      const textBlocks = (res.content || [])
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");

      if (textBlocks) {
        // 健壮提取 JSON 内容（优先 Markdown 围栏代码块，回退平衡大括号，避开贪婪匹配跨块崩溃）
        const parsed = extractValidJsonObject(textBlocks);
        if (parsed.requirementSlots && Array.isArray(parsed.requirementSlots) && parsed.requirementSlots.length >= 3) {
          const isWeb = /网页|网站|单页|web|ui|前端|页面|组件|vue|react|html|css|界面|dashboard|app/i.test(task);
          const fallbackSparks = isWeb
            ? [
                {
                  id: "spark_micro_animations",
                  title: "微交互反馈与流畅过渡",
                  description: "为核心操作增添平滑的触觉反馈与状态过渡，大幅提升界面呼吸感",
                  impact: "交互体验跃升",
                  isAcceptedByDefault: true
                }
              ]
            : [
                {
                  id: "spark_graceful_error_healing",
                  title: "优雅容错与输入校验",
                  description: "内置完善的入参自愈与异常友好提示，避免底层错误直接倾泻",
                  impact: "健壮性倍增",
                  isAcceptedByDefault: true
                }
              ];

          const finalSlots = ecosystemExtensionSlot
            ? [ecosystemExtensionSlot, ...parsed.requirementSlots]
            : parsed.requirementSlots;

          return {
            taskDescription: task,
            researchSummary: parsed.researchSummary || `已针对「${task}」由 AI 架构师结合本地环境实时动态推导。`,
            requirementSlots: finalSlots,
            decisionSlots: finalSlots,
            dynamicGoals: Array.isArray(parsed.dynamicGoals) && parsed.dynamicGoals.length > 0
              ? parsed.dynamicGoals
              : [`实现「${task}」核心业务功能与关键流程`, `确保工程代码结构规范并完成实机走查验证`],
            tradeOff,
            architectSparks: Array.isArray(parsed.architectSparks) && parsed.architectSparks.length > 0
              ? parsed.architectSparks
              : fallbackSparks
          };
        }
      }
    } catch (_err) {
      // 容错降级至本地智能自适应推导
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
  const pathMatch = task.match(/(?:[a-zA-Z0-9_\-\.\/]+\.(?:ts|js|py|rs|go|cpp|c|h|java|vue|tsx|jsx|json|md))/i);
  const detectedPath = pathMatch ? pathMatch[0].replace(/\\/g, "/") : "";

  const fallback = {
    primaryArtifact: detectedPath || profile.srcPath,
    targetLanguage: fp.language || "typescript",
    isFrontend: false
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
  const isWebOrUI = llmArtifactPlan !== undefined
    ? llmArtifactPlan.isFrontend
    : (/(网页|网站|前端|页面|组件|vue|react|html|css|界面|dashboard|ui(?![a-z])|canvas|frontend)/i.test(task) &&
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
      reasons.push(`【${slot.title}】选择「${opt.label}」➔ 赋能: ${opt.recommendedEcosystem.reason}`);
    }
  }

  const customReqs = customRequirements || (userDecisions.custom_requirements
    ? [userDecisions.custom_requirements]
    : userDecisions.customRequirements
    ? (Array.isArray(userDecisions.customRequirements) ? userDecisions.customRequirements : [userDecisions.customRequirements])
    : undefined);

  const customReqNotice = customReqs && customReqs.length > 0
    ? `\n[用户个性化补充需求 (最高优先级)]: ${customReqs.join("; ")}`
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
        title: "极速响应与验证 (单阶段极简通道)",
        roleProfile: "quick_specialist",
        coreObjective: `针对目标任务快速实施变更并执行必要验证，完成后直接交付。${customReqNotice}`,
        boundCapabilities: {
          extensions: [],
          skills: []
        },
        expectedArtifact: defaultSrcPath,
        expectedArtifacts: [defaultSrcPath],
        targetPatterns: ["src/**", "lib/**", "tests/**", "*"],
        artifactContract: `直接产出修改代码并确保无语法错误。`,
        verificationCommands: stage2VerificationCommands,
        allowedTools: ["read", "edit", "write", "bash", "powershell", "grep", "find"],
        tokenCostNotice: "极简直接执行，0 前置冗余"
      }
    ];
  } else {
    rawStages = isAgile
      ? [
        {
          stageId: "stage_1_design",
          title: "方案设计与契约 (设计阶段)",
          roleProfile: "system_architect",
          coreObjective: `依据任务目标快速确立 ${fp.projectType} 架构设计与契约 (${profile.docPath})。优先调用最新检索规范。${customReqNotice}`,
          boundCapabilities: {
            extensions: l2PerceptionExts.slice(0, 2),
            prompts: Array.from(activatedPrompts).filter(p => p.includes("research") || p.includes("clarify"))
          },
          expectedArtifact: profile.docPath,
          expectedArtifacts: [profile.docPath],
          targetPatterns: ["docs/**", "*.md"],
          artifactContract: `包含模块架构与接口契约，落盘于 ${profile.docPath}。${customReqNotice ? " 约束说明: " + customReqNotice : ""}`,
          allowedTools: stage1Tools,
          tokenCostNotice: "快速确立设计契约，杜绝架构跑偏"
        },
        {
          stageId: "stage_2_implementation_preview",
          title: "[核心制作] 敏捷编码与实机走查",
          roleProfile: isOrchestrationActive ? "subagent_orchestrator" : "principal_engineer",
          dependsOn: ["stage_1_design"],
          coreObjective: `遵循契约完成核心源码编写 (${defaultSrcPath})，拉起实机走查并向用户展示核心亮点。进入前自动建立安全快照。`,
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
          artifactContract: `完成 ${defaultSrcPath} 编写与运行走查，语法无误。`,
          verificationCommands: stage2VerificationCommands,
          allowedTools: stage2Tools,
          tokenCostNotice: "敏捷合并编码与实机走查，秒级交付"
        },
        {
          stageId: "stage_3_verification_delivery",
          title: "[门禁终审] 自动化验收与成果交付",
          roleProfile: "quality_auditor",
          dependsOn: ["stage_2_implementation_preview"],
          coreObjective: `执行自动化测试与 64 位 SHA 门禁，生成交付凭证与价值结算单。`,
          boundCapabilities: {
            extensions: Array.from(activatedExts).filter(e => e.includes("goal") || e.includes("tui")),
            skills: Array.from(activatedSkills)
          },
          expectedArtifact: profile.reportPath,
          expectedArtifacts: [profile.reportPath, ...(isWebOrUI || !profile.testPath ? [] : [profile.testPath])],
          targetPatterns: ["reports/**", "tests/**", "docs/**", "*.test.*", "*.spec.*"],
          artifactContract: `包含 SHA-256 校验和与测试结果，落盘于 ${profile.reportPath}。`,
          verificationCommands: !isWebOrUI && profile.testCommands && profile.testCommands.length > 0 ? profile.testCommands : undefined,
          allowedTools: stage3Tools,
          isReviewStage: true,
          reviewIsolation: {
            enabled: true,
            requireColdStart: true,
            diffOnlyContext: true
          },
          tokenCostNotice: "自动化测试闭环，生成价值交付收据"
        }
      ]
    : [
        {
          stageId: "stage_1_design",
          title: "[架构设计] 方案设计与意图契约",
          roleProfile: "system_architect",
          coreObjective: `依据任务目标与用户共创选型，完成 ${fp.projectType} 架构契约与设计文档编写。优先调用检索工具获取最新官方规范，杜绝过时盲猜。${customReqNotice}`,
          boundCapabilities: {
            extensions: l2PerceptionExts.slice(0, 2),
            prompts: Array.from(activatedPrompts).filter(p => p.includes("research") || p.includes("clarify"))
          },
          expectedArtifact: profile.docPath,
          expectedArtifacts: [profile.docPath],
          targetPatterns: ["docs/**", "*.md"],
          artifactContract: `包含业务范围、模块架构、接口契约与依赖规范，落盘于 ${profile.docPath}。${customReqNotice ? " 约束说明: " + customReqNotice : ""}`,
          allowedTools: stage1Tools,
          tokenCostNotice: "主动检索官方最新规范，确保设计 100% 准确"
        },
        {
          stageId: "stage_2_implementation",
          title: "[核心制作] 功能编写与模块构建",
          roleProfile: isOrchestrationActive ? "subagent_orchestrator" : "principal_engineer",
          dependsOn: ["stage_1_design"],
          coreObjective: `遵循阶段 1 设计契约完成核心代码编写 (${defaultSrcPath})。按需自主决策使用 workflow / subagent 派发并行子任务，或直接编码实现。进入前系统自动建立安全快照点。`,
          boundCapabilities: {
            extensions: Array.from(activatedExts).filter(e => e.includes("subagents") || e.includes("workflows") || e.includes("rewind")),
            skills: Array.from(activatedSkills)
          },
          expectedArtifact: defaultSrcPath,
          expectedArtifacts: [defaultSrcPath],
          targetPatterns: ["src/**", "lib/**", "*.ts", "*.js", "*.rs", "*.py", "*.go", "*.html"],
          artifactContract: `完成 ${defaultSrcPath} 核心业务逻辑编写，语法无误且符合设计契约。`,
          verificationCommands: stage2VerificationCommands,
          allowedTools: stage2Tools,
          tokenCostNotice: "专注核心源码编写，严格落实设计契约"
        },
        {
          stageId: "stage_3_preview_cocreation",
          title: "[效果走查] 实机运行与共创调优",
          roleProfile: "experience_consultant",
          dependsOn: ["stage_2_implementation"],
          coreObjective: "运行演示命令或调起实机预览，向用户直观展示当前成果亮点，并主动征询 2~3 个具体优化建议。可按需借助 plannotator / 浏览器走查工具辅助审查。",
          isInteractiveCoCreation: true,
          proactiveInquiryPrompt: "我已完成核心功能编写，以下是实际运行效果与亮点。针对交互手感/文案/样式，您是否有特定微调偏好？",
          previewUrl: livePreviewUrl,
          previewCommand: livePreviewCmd,
          boundCapabilities: {
            extensions: Array.from(activatedExts).filter(e => e.includes("plannotator") || e.includes("web")),
            skills: Array.from(activatedSkills).filter(s => s.includes("plannotator"))
          },
          expectedArtifact: profile.previewPath,
          expectedArtifacts: [profile.previewPath],
          targetPatterns: ["reports/**", "docs/**", "*.md"],
          artifactContract: `输出包含运行效果走查、功能完成对照与用户征询问题的记录，落盘于 ${profile.previewPath}。`,
          verificationCommands: profile.previewCommands && profile.previewCommands.length > 0 ? profile.previewCommands : undefined,
          allowedTools: hasTool("mcp") ? ["read", "write", "bash", "powershell", "grep", "find", "mcp"] : ["read", "write", "bash", "powershell", "grep", "find"],
          tokenCostNotice: "拉起实机走查，人机深度共创把关"
        },
        {
          stageId: "stage_4_testing",
          title: "自动化单测与物理门禁 (单测验证)",
          roleProfile: "test_engineer",
          dependsOn: ["stage_3_preview_cocreation"],
          coreObjective: `根据共创定稿成果编写单测 (${profile.testPath})，执行验证命令，确保全部绿灯并通过 64 位 SHA 物理校验。可自主使用 goal / workflow(adversarial-review) 强化门禁质量。`,
          boundCapabilities: {
            extensions: Array.from(activatedExts).filter(e => e.includes("goal")),
            skills: Array.from(activatedSkills)
          },
          expectedArtifact: profile.testPath,
          expectedArtifacts: [profile.testPath],
          targetPatterns: ["tests/**", "*.test.*", "*.spec.*"],
          artifactContract: `包含测试用例，运行 ${profile.testCommands.join(" / ") || "单测命令"} 必须通过。`,
          verificationCommands: profile.testCommands,
          allowedTools: stage2Tools.concat(stage3Tools.filter(t => !stage2Tools.includes(t))),
          tokenCostNotice: "自动化单测验证，拦截 0-Byte 伪交付"
        },
        {
          stageId: "stage_5_audit_delivery",
          title: "终审归档与高保真通知 (终审交付)",
          roleProfile: "quality_auditor",
          dependsOn: ["stage_4_testing"],
          coreObjective: `生成交付成果清单与文件校验和，并通过终端 TUI 输出交付卡片。`,
          boundCapabilities: {
            extensions: Array.from(activatedExts).filter(e => e.includes("goal") || e.includes("tui")),
            skills: []
          },
          expectedArtifact: profile.reportPath,
          expectedArtifacts: [profile.reportPath],
          targetPatterns: ["reports/**", "docs/**"],
          artifactContract: `包含测试覆盖数据、物理产物 64 位 SHA-256 指纹与竣工报告，落盘于 ${profile.reportPath}。`,
          allowedTools: ["read", "write", "bash", "powershell", "grep", "find", "mcp"],
          isReviewStage: true,
          reviewIsolation: {
            enabled: true,
            requireColdStart: true,
            diffOnlyContext: true
          },
          tokenCostNotice: "生成最终交付凭证，触发高保真多端通知"
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
