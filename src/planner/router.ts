import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ABMatrix,
  ArchitectSpark,
  EcosystemTaxonomy,
  ProjectArtifactProfile,
  ProjectFingerprint,
  TaskDiagnosis,
  TaskRequirementSlot,
  TaskRouteDecision,
} from "../core/types.js";
import { extractValidJsonObject } from "../core/json-extract.js";
import { sniffProjectFingerprint } from "./taxonomy.js";
import { callExtensionLlm, type LlmModelRuntime } from "./llm-client.js";
import { formatActiveAnchorHint } from "./anchor-handshake.js";

/** CJK ideographs carry more meaning per character, so script presence drives the language-neutral heuristics. */
const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff]/;


/**
 * Classifies whether a task needs a multi-stage blueprint or lightweight fast execution.
 */
export function diagnoseTaskExecutionMode(
  task: string,
  fp?: ProjectFingerprint,
  userExplicitMode?: "fast" | "blueprint"
): TaskRouteDecision {
  if (userExplicitMode === "fast") {
    return { mode: "fast", reason: "User explicitly requested fast execution.", estimatedComplexity: "low" };
  }
  if (userExplicitMode === "blueprint") {
    return { mode: "blueprint", reason: "User explicitly requested full blueprint planning.", estimatedComplexity: "high" };
  }

  const trimmed = task.trim();
  const lower = trimmed.toLowerCase();

  const isCjkTask = CJK_PATTERN.test(trimmed);

  const heavyPattern =
    /refactor|architect|migrate|redesign|pipeline|multi-stage|framework|fullstack|monorepo|end-to-end|system/i;
  if (heavyPattern.test(lower) || (isCjkTask && trimmed.length > 26)) {
    return {
      mode: "blueprint",
      reason: "Detected architectural, multi-stage, or system-wide task scope.",
      estimatedComplexity: "high",
    };
  }

  const microPattern =
    /^(fix|rename|typo|format|lint|tweak|add comment|update version|bump|check|explain)/i;
  if (trimmed.length < 48 && microPattern.test(lower) && !lower.includes("and ")) {
    return {
      mode: "fast",
      reason: "Localized single-concern task suited for fast execution.",
      estimatedComplexity: "low",
    };
  }

  if (isCjkTask && trimmed.length <= 10) {
    return {
      mode: "fast",
      reason: "Compact single-goal directive.",
      estimatedComplexity: "low",
    };
  }

  if (fp?.projectType === "monorepo" || (fp?.changedModules && fp.changedModules.length >= 3)) {
    return {
      mode: "blueprint",
      reason: "Multi-module workspace change benefits from staged DAG verification.",
      estimatedComplexity: "medium",
    };
  }

  if (trimmed.length <= 28 && !/\s/.test(trimmed)) {
    return {
      mode: "fast",
      reason: "Compact single-goal directive.",
      estimatedComplexity: "low",
    };
  }

  return {
    mode: "blueprint",
    reason: "Composite engineering task routed to staged blueprint execution.",
    estimatedComplexity: "medium",
  };
}

/**
 * Maps a project's detected language/framework to realistic source, test, and verification commands.
 */
export function inferArtifactProfile(
  fp?: ProjectFingerprint,
  cwd: string = process.cwd()
): ProjectArtifactProfile {
  const srcDir = fp?.sourceDir && fp.sourceDir !== "." ? fp.sourceDir : "src";
  const testDir = fp?.testDir && fp.testDir !== "." ? fp.testDir : "tests";
  const pType = fp?.projectType || "unknown";
  const pkgMgr = fp?.packageManager || "npm";
  const reportDir = path.join(".pi", "toolflow", "reports");
  const summaryPath = path.join(reportDir, "verification_summary.json").replace(/\\/g, "/");

  switch (pType) {
    case "rust":
      return {
        srcPath: "src/main.rs",
        testPath: "tests/integration_test.rs",
        summaryPath,
        testCommands: ["cargo check", "cargo test"],
        buildCommands: ["cargo build"],
        previewCommands: ["cargo run -- --help"],
      };

    case "python": {
      const runner =
        pkgMgr === "uv" ? "uv run pytest" : pkgMgr === "poetry" ? "poetry run pytest" : "pytest";
      return {
        srcPath: path.join(srcDir, "main.py").replace(/\\/g, "/"),
        testPath: path.join(testDir, "test_main.py").replace(/\\/g, "/"),
        summaryPath,
        testCommands: [runner],
        buildCommands: ["python -m py_compile"],
        previewCommands: ["python -m main --help"],
      };
    }

    case "go":
      return {
        srcPath: "main.go",
        testPath: "main_test.go",
        summaryPath,
        testCommands: ["go test ./..."],
        buildCommands: ["go build ./..."],
        previewCommands: ["go run . --help"],
      };

    case "cpp":
      return {
        srcPath: "src/main.cpp",
        testPath: "tests/test_main.cpp",
        summaryPath,
        testCommands: ["ctest --output-on-failure"],
        buildCommands: ["cmake --build build"],
        previewCommands: ["./build/app --help"],
      };

    case "web": {
      const fw = (fp?.mainFramework || "").toLowerCase();
      const hasPkgJson = fs.existsSync(path.join(cwd, "package.json"));
      const srcPath =
        fw.includes("vue")
          ? "src/App.vue"
          : fw.includes("react") || fw.includes("next")
            ? "src/App.tsx"
            : hasPkgJson
              ? path.join(srcDir, "index.ts").replace(/\\/g, "/")
              : "index.html";
      const runCmd = pkgMgr === "pnpm" ? "pnpm" : pkgMgr === "yarn" ? "yarn" : pkgMgr === "bun" ? "bun" : "npm";
      return {
        srcPath,
        testPath: hasPkgJson ? path.join(testDir, "app.test.ts").replace(/\\/g, "/") : "index.test.js",
        summaryPath,
        testCommands: hasPkgJson ? [`${runCmd} test`] : ["node --test"],
        buildCommands: hasPkgJson ? [`${runCmd} run build`] : [],
        previewCommands: hasPkgJson ? [`${runCmd} run dev`] : [],
      };
    }

    case "node":
    case "monorepo": {
      const runCmd = pkgMgr === "pnpm" ? "pnpm" : pkgMgr === "yarn" ? "yarn" : pkgMgr === "bun" ? "bun" : "npm";
      let isPlainJs = false;
      const fullSrcDir = path.join(cwd, srcDir);
      if (!fs.existsSync(path.join(cwd, "tsconfig.json")) && fs.existsSync(fullSrcDir)) {
        try {
          const entries = fs.readdirSync(fullSrcDir);
          const hasJs = entries.some(e => /\.(?:c|m)?js$/.test(e));
          const hasTs = entries.some(e => /\.tsx?$/.test(e));
          if (hasJs && !hasTs) isPlainJs = true;
        } catch {
          // Ignore unreadable src directory
        }
      }
      const ext = isPlainJs ? "js" : "ts";
      return {
        srcPath: path.join(srcDir, `index.${ext}`).replace(/\\/g, "/"),
        testPath: path.join(testDir, `index.test.${ext}`).replace(/\\/g, "/"),
        summaryPath,
        testCommands: [`${runCmd} test`],
        buildCommands: [`${runCmd} run build`],
        previewCommands: [`${runCmd} start`],
      };
    }

    default:
      return {
        srcPath: path.join(srcDir, "index.ts").replace(/\\/g, "/"),
        testPath: path.join(testDir, "index.test.ts").replace(/\\/g, "/"),
        summaryPath,
        testCommands: ["npm test"],
        buildCommands: ["npm run build"],
        previewCommands: [],
      };
  }
}

export function generateABTradeOffMatrix(task: string, fp?: ProjectFingerprint): ABMatrix {
  const lower = task.toLowerCase();
  const isComplex = /refactor|architect|migrate|scale|plugin|monorepo/.test(lower) || task.length > 40;
  const stackLabel = fp?.mainFramework || fp?.projectType || "workspace";

  return {
    planA: {
      id: "A",
      title: "Agile Incremental Delivery",
      tagline: `Minimal changes tailored to ${stackLabel}, fastest path to verified output`,
      pros: [
        "Touches only directly affected modules with minimal regression risk",
        "Fast verification cycle and clean diff",
        "Zero speculative abstractions",
      ],
      cons: ["Follow-up extensions may need light refactoring later"],
      estimatedEffort: "Low-Medium (2 stages)",
      recommendedFor: "Targeted features, bug fixes, and rapid iteration",
    },
    planB: {
      id: "B",
      title: "Modular Decoupled Architecture",
      tagline: "Clear interface boundaries, independent test seams, and review isolation",
      pros: [
        "Clean separation between core logic, adapters, and UI",
        "High long-term maintainability and parallel verification",
        "Isolated diff-only review stage before completion",
      ],
      cons: ["More files touched initially", "Slightly higher planning overhead"],
      estimatedEffort: "Medium-High (3 stages)",
      recommendedFor: "Refactors, cross-module features, and public APIs",
    },
    recommendedPlan: isComplex ? "B" : "A",
    rationale: isComplex
      ? "Task scope spans architecture or multiple modules; Plan B prevents coupling."
      : "Task scope is focused; Plan A delivers verified results with minimal churn.",
  };
}

export function generateUniversalMetaSlots(
  task: string,
  _tax: EcosystemTaxonomy,
  fp: ProjectFingerprint,
  tradeOff: ABMatrix
): TaskDiagnosis {
  const slots: TaskRequirementSlot[] = [];
  const lowerTask = task.toLowerCase();
  const isWeb = /web|ui|frontend|html|css|react|vue|svelte|dashboard|page/.test(lowerTask);
  const isCli = /cli|command|script|terminal|tool/.test(lowerTask);
  const isService = /api|server|backend|service|database|db|microservice/.test(lowerTask);

  slots.push({
    slotId: "slot_delivery_scope",
    title: "1. Delivery Scope & Architecture",
    category: "scope",
    question: "How should this task be scoped and structured?",
    options: [
      {
        id: "opt_scope_plan_a",
        label: `[Recommended] ${tradeOff.planA.title}`,
        description: tradeOff.planA.tagline,
        isRecommended: tradeOff.recommendedPlan === "A",
        recommendedEcosystem: { extensions: [], reason: "Zero extra dependencies" },
      },
      {
        id: "opt_scope_plan_b",
        label: tradeOff.planB.title,
        description: tradeOff.planB.tagline,
        isRecommended: tradeOff.recommendedPlan === "B",
        recommendedEcosystem: { extensions: ["pi-subagents"], reason: "Isolated review stage" },
      },
    ],
  });

  if (isWeb) {
    slots.push({
      slotId: "slot_domain_focus",
      title: "2. UI & Browser Verification",
      category: "design",
      question: "How should the web/UI behavior be verified?",
      options: [
        {
          id: "opt_web_browser",
          label: "[Recommended] Build + Live Browser Probe",
          description: "Verify bundle compilation and DOM/console behavior in a real browser.",
          isRecommended: true,
          recommendedEcosystem: {
            extensions: ["pi-control-chrome"],
            reason: "Real DOM and console verification",
          },
        },
        {
          id: "opt_web_headless",
          label: "Build + Unit/DOM Tests Only",
          description: "Verify TypeScript/bundler build and automated DOM/logic tests.",
          isRecommended: false,
          recommendedEcosystem: { extensions: [], reason: "Fast offline verification" },
        },
      ],
    });
  } else if (isCli) {
    slots.push({
      slotId: "slot_domain_focus",
      title: "2. CLI Ergonomics & Exit Contracts",
      category: "design",
      question: "What level of CLI contract and edge-case coverage do you want?",
      options: [
        {
          id: "opt_cli_strict",
          label: "[Recommended] Strict Exit Codes & Help/Flag Tests",
          description: "Verify argument parsing, stdout/stderr separation, and non-zero exits.",
          isRecommended: true,
          recommendedEcosystem: { extensions: [], reason: "Core CLI contract coverage" },
        },
        {
          id: "opt_cli_minimal",
          label: "Direct Working Script",
          description: "Ship core command behavior with smoke execution check.",
          isRecommended: false,
          recommendedEcosystem: { extensions: [], reason: "Minimal setup" },
        },
      ],
    });
  } else if (isService) {
    slots.push({
      slotId: "slot_domain_focus",
      title: "2. API Contract & Resilience",
      category: "design",
      question: "How should service boundaries and validation be handled?",
      options: [
        {
          id: "opt_backend_contract",
          label: "[Recommended] Typed Input Validation & Unified Errors",
          description: "Validate boundaries and test success + failure status paths.",
          isRecommended: true,
          recommendedEcosystem: { extensions: ["pi-web-access"], reason: "API spec alignment" },
        },
        {
          id: "opt_backend_fast",
          label: "Lightweight Endpoint",
          description: "Keep handlers lean with focused integration checks.",
          isRecommended: false,
          recommendedEcosystem: { extensions: [], reason: "Low overhead" },
        },
      ],
    });
  } else {
    slots.push({
      slotId: "slot_verification_depth",
      title: "2. Verification & Review Depth",
      category: "verification",
      question: "Select verification strictness before marking complete:",
      options: [
        {
          id: "opt_verify_full",
          label: "[Recommended] Typecheck + Targeted Tests + Diff Review",
          description: "Run typecheck, targeted test suite, and read-only diff review.",
          isRecommended: true,
          recommendedEcosystem: { extensions: [], reason: "High reliability" },
        },
        {
          id: "opt_verify_smoke",
          label: "Fast Smoke Check",
          description: "Verify compilation and primary execution path quickly.",
          isRecommended: false,
          recommendedEcosystem: { extensions: [], reason: "Fast iteration" },
        },
      ],
    });
  }

  const dynamicGoals: string[] = [
    `Align implementation with ${fp.mainFramework || fp.projectType} project conventions`,
    "Deliver verifiable artifacts with passing typecheck/tests and zero leftover temp files",
  ];

  const architectSparks: ArchitectSpark[] = [
    {
      id: "spark_zero_regression",
      title: "Backward Compatibility Guard",
      description: "Preserve existing public exports and CLI/command signatures unless explicitly changed.",
      impact: "Prevents downstream breakage",
      isAcceptedByDefault: true,
    },
    {
      id: "spark_isolated_tests",
      title: "Workspace-Isolated Tests",
      description: "Run tests in temporary directories without touching real user configuration.",
      impact: "Deterministic CI & local runs",
      isAcceptedByDefault: true,
    },
  ];

  return {
    taskDescription: task,
    researchSummary: `Analyzed ${fp.projectType} workspace (${fp.packageManager}) and synthesized decision slots.`,
    requirementSlots: slots,
    dynamicGoals,
    tradeOff,
    architectSparks,
  };
}

export async function diagnoseTaskRequirements(
  task: string,
  taxonomy: EcosystemTaxonomy,
  ctx?: LlmModelRuntime,
  providedFp?: ProjectFingerprint,
  cwd: string = process.cwd()
): Promise<TaskDiagnosis> {
  const fp = providedFp || taxonomy.projectFingerprint || sniffProjectFingerprint(cwd);
  const tradeOff = generateABTradeOffMatrix(task, fp);
  const fallback = generateUniversalMetaSlots(task, taxonomy, fp, tradeOff);

  try {
    const extNames = taxonomy.extensions.map(e => e.cleanName).slice(0, 12).join(", ");
    const userPrompt =
      `Analyze the user's task and workspace (${fp.projectType}, ${fp.mainFramework || fp.packageManager}).\n` +
      `IMPORTANT: Write all user-facing labels, descriptions, and goals in the SAME language as the user's task ("${task}").\n` +
      `Available extensions: ${extNames || "core tools only"}.${formatActiveAnchorHint(cwd)}\n` +
      `Return strict JSON matching:\n` +
      `{"researchSummary":"...","dynamicGoals":["..."],"requirementSlots":[{"slotId":"slot_1","title":"...","category":"scope|design|verification","question":"...","options":[{"id":"opt_1","label":"...","description":"...","isRecommended":true}]}]}`;

    const rawText = await callExtensionLlm(
      ctx,
      "You are a staff software architect producing structured task decision slots.",
      userPrompt,
      1200
    );
    if (!rawText) return fallback;

    const parsed = extractValidJsonObject(rawText);
    const parsedSlots = Array.isArray(parsed.requirementSlots) ? parsed.requirementSlots : [];
    if (parsedSlots.length === 0) return fallback;

    const slots: TaskRequirementSlot[] = parsedSlots
      .filter((s): s is Record<string, unknown> => Boolean(s && typeof s === "object"))
      .slice(0, 4)
      .map((s, idx) => {
        const rawOpts = Array.isArray(s.options) ? s.options : [];
        return {
          slotId: typeof s.slotId === "string" ? s.slotId : `slot_${idx + 1}`,
          title: typeof s.title === "string" ? s.title : `Decision ${idx + 1}`,
          category: normalizeSlotCategory(s.category),
          question: typeof s.question === "string" ? s.question : "Select an option:",
          options: rawOpts
            .filter((o): o is Record<string, unknown> => Boolean(o && typeof o === "object"))
            .slice(0, 4)
            .map((o, oIdx) => ({
              id: typeof o.id === "string" ? o.id : `opt_${idx}_${oIdx}`,
              label: typeof o.label === "string" ? o.label : `Option ${oIdx + 1}`,
              description: typeof o.description === "string" ? o.description : "",
              isRecommended: Boolean(o.isRecommended),
              recommendedEcosystem: { extensions: [], reason: "LLM matched" },
            })),
        };
      })
      .filter(s => s.options.length > 0);

    if (slots.length === 0) return fallback;

    const dynamicGoals = Array.isArray(parsed.dynamicGoals)
      ? parsed.dynamicGoals.filter((g): g is string => typeof g === "string" && g.trim().length > 0).slice(0, 4)
      : fallback.dynamicGoals;

    return {
      taskDescription: task,
      researchSummary:
        typeof parsed.researchSummary === "string" && parsed.researchSummary.trim()
          ? parsed.researchSummary
          : fallback.researchSummary,
      requirementSlots: slots,
      dynamicGoals: dynamicGoals.length > 0 ? dynamicGoals : fallback.dynamicGoals,
      tradeOff,
      architectSparks: fallback.architectSparks,
    };
  } catch {
    return fallback;
  }
}

function normalizeSlotCategory(value: unknown): TaskRequirementSlot["category"] {
  if (value === "scope" || value === "design" || value === "capability" || value === "verification") {
    return value;
  }
  return "general";
}
