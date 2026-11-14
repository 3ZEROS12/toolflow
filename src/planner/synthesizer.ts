import type {
  Blueprint,
  BlueprintStage,
  EcosystemTaxonomy,
  TaskDiagnosis,
} from "../core/types.js";
import { extractValidJsonObject } from "../core/json-extract.js";
import { isCjkText } from "../core/text.js";
import { BASELINE_TOOLS } from "../core/workspace-store.js";
import { bindDeepEcosystemToStage } from "./deep-ecosystem.js";
import { planDAGWaves } from "./dag.js";
import { inferArtifactProfile } from "./router.js";
import { sniffProjectFingerprint } from "./taxonomy.js";
import { callExtensionLlm, type LlmModelRuntime } from "./llm-client.js";

export interface LlmArtifactPlan {
  primaryArtifact: string;
  targetLanguage: string;
  isFrontend: boolean;
  stageHeavyTools?: {
    stage1?: string[];
    stage2?: string[];
    stage3?: string[];
  };
}

export async function synthesizeBlueprintPlanWithLLM(
  task: string,
  taxonomy: EcosystemTaxonomy,
  ctx?: LlmModelRuntime,
  cwd: string = process.cwd()
): Promise<LlmArtifactPlan> {
  const fp = taxonomy.projectFingerprint || sniffProjectFingerprint(cwd);
  const profile = inferArtifactProfile(fp, cwd);
  const fallback: LlmArtifactPlan = {
    primaryArtifact: profile.srcPath,
    targetLanguage: fp.projectType,
    isFrontend: fp.projectType === "web",
  };

  try {
    const rawText = await callExtensionLlm(
      ctx,
      "Determine primary workspace deliverables cleanly as JSON.",
      `Determine the primary deliverable artifact path, language, and whether this is a frontend/web task.\n` +
        `Workspace: ${fp.projectType} (${fp.mainFramework || fp.packageManager}), sourceDir=${fp.sourceDir}.\n` +
        `Task: "${task}"\n` +
        `Return strict JSON: {"primaryArtifact":"path/to/file","targetLanguage":"ts|py|rs|go|html|...","isFrontend":false}`,
      300
    );
    if (!rawText) return fallback;

    const parsed = extractValidJsonObject(rawText);
    return {
      primaryArtifact:
        typeof parsed.primaryArtifact === "string" && parsed.primaryArtifact.trim()
          ? parsed.primaryArtifact.trim()
          : fallback.primaryArtifact,
      targetLanguage:
        typeof parsed.targetLanguage === "string" && parsed.targetLanguage.trim()
          ? parsed.targetLanguage.trim()
          : fallback.targetLanguage,
      isFrontend: typeof parsed.isFrontend === "boolean" ? parsed.isFrontend : fallback.isFrontend,
    };
  } catch {
    return fallback;
  }
}

export function synthesizeBlueprint(
  task: string,
  diagnosis: TaskDiagnosis,
  userDecisions: Record<string, string>,
  taxonomy: EcosystemTaxonomy,
  selectedPlan?: "A" | "B",
  customRequirements?: string[],
  llmArtifactPlan?: Partial<LlmArtifactPlan>,
  cwd: string = process.cwd()
): Blueprint {
  const fp = taxonomy.projectFingerprint || sniffProjectFingerprint(cwd);
  const profile = inferArtifactProfile(fp, cwd);
  const isAgile =
    selectedPlan === "A" ||
    Object.values(userDecisions).some(v => v.includes("plan_a") || v.includes("minimal"));
  const isMicroTask =
    Object.values(userDecisions).some(v => v.includes("fast")) ||
    (/^(fix|rename|typo|format|lint|tweak|check)/i.test(task.trim()) && task.trim().length < 48) ||
    (isCjkText(task) && task.trim().length <= 8);
  const mentionedPaths = Array.from(
    new Set(
      (task.match(/(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+/g) ?? []).map(p =>
        p.replace(/^\.\//, "")
      )
    )
  );
  const mentionedTests = mentionedPaths.filter(p => /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\./i.test(p));
  const mentionedSources = mentionedPaths.filter(p => !mentionedTests.includes(p));

  const primaryArtifact =
    mentionedSources[0] || llmArtifactPlan?.primaryArtifact || profile.srcPath;
  const primaryTestArtifact = mentionedTests[0] || profile.testPath;
  const isFrontend = llmArtifactPlan?.isFrontend ?? fp.projectType === "web";

  const availableMcpServers = taxonomy.tools
    .filter(t => t.name.startsWith("mcp") || t.cleanName.includes("playwright") || t.cleanName.includes("chrome"))
    .map(t => t.cleanName);

  const discoveredSkills = taxonomy.skills.map(s => ({
    name: s.cleanName,
    filePath: s.filePath,
  }));

  const commonTargetPatterns = Array.from(
    new Set([primaryArtifact, primaryTestArtifact, "src/**", "tests/**", "test/**", "__tests__/**"])
  );

  const stages: BlueprintStage[] = isMicroTask
    ? [
        {
          stageId: "stage_1_execute",
          title: "Stage 1: Direct Implementation & Verification",
          coreObjective: `Execute "${task}" directly in ${primaryArtifact} and verify with project checks.`,
          boundCapabilities: { extensions: [], skills: [], prompts: [] },
          expectedArtifact: primaryArtifact,
          expectedArtifacts: [primaryArtifact],
          targetPatterns: commonTargetPatterns,
          artifactContract: `Updated ${primaryArtifact} passes compilation and tests.`,
          verificationCommands: profile.testCommands,
          allowedTools: [...BASELINE_TOOLS],
        },
      ]
    : isAgile
      ? [
          {
            stageId: "stage_1_implement",
            title: "Stage 1: Core Implementation",
            coreObjective: `Implement "${task}" cleanly in ${primaryArtifact} following existing conventions.`,
            boundCapabilities: {
              extensions: [],
              skills: discoveredSkills.slice(0, 1).map(s => s.name),
              prompts: [],
            },
            expectedArtifact: primaryArtifact,
            expectedArtifacts: [primaryArtifact],
            targetPatterns: commonTargetPatterns,
            artifactContract: `${primaryArtifact} exists, compiles, and implements the core requirement.`,
            allowedTools: [...BASELINE_TOOLS, ...(llmArtifactPlan?.stageHeavyTools?.stage1 ?? [])],
          },
          {
            stageId: "stage_2_verify",
            title: "Stage 2: Test & Verification",
            dependsOn: ["stage_1_implement"],
            coreObjective: `Add/update tests in ${primaryTestArtifact} and run verification commands (${profile.testCommands.join(" && ")}) until green.`,
            boundCapabilities: { extensions: [], skills: [], prompts: [] },
            expectedArtifact: primaryTestArtifact,
            expectedArtifacts: [primaryTestArtifact, primaryArtifact],
            targetPatterns: commonTargetPatterns,
            artifactContract: `Tests pass cleanly (${profile.testCommands.join(" && ")}).`,
            verificationCommands: profile.testCommands,
            allowedTools: [
              ...BASELINE_TOOLS,
              ...(isFrontend ? ["browser_probe_interaction"] : []),
              ...(llmArtifactPlan?.stageHeavyTools?.stage2 ?? []),
            ],
          },
        ]
      : [
          {
            stageId: "stage_1_design",
            title: "Stage 1: Interface & Scope Design",
            coreObjective: `Inspect existing architecture and establish contracts before editing ${primaryArtifact}.`,
            boundCapabilities: {
              extensions: [],
              skills: discoveredSkills.slice(0, 1).map(s => s.name),
              prompts: [],
            },
            expectedArtifact: primaryArtifact,
            expectedArtifacts: [primaryArtifact],
            targetPatterns: commonTargetPatterns,
            artifactContract: `Interfaces and module boundaries for ${primaryArtifact} are cleanly defined.`,
            allowedTools: [...BASELINE_TOOLS, ...(llmArtifactPlan?.stageHeavyTools?.stage1 ?? [])],
          },
          {
            stageId: "stage_2_implement",
            title: "Stage 2: Modular Implementation & Tests",
            dependsOn: ["stage_1_design"],
            coreObjective: `Implement "${task}" across ${primaryArtifact} and add deterministic coverage in ${primaryTestArtifact}.`,
            boundCapabilities: { extensions: [], skills: [], prompts: [] },
            expectedArtifact: primaryTestArtifact,
            expectedArtifacts: [primaryArtifact, primaryTestArtifact],
            targetPatterns: commonTargetPatterns,
            artifactContract: `Implementation and tests compile and pass (${profile.testCommands.join(" && ")}).`,
            verificationCommands: profile.testCommands,
            allowedTools: [
              ...BASELINE_TOOLS,
              ...(isFrontend ? ["browser_probe_interaction"] : []),
              ...(llmArtifactPlan?.stageHeavyTools?.stage2 ?? []),
            ],
          },
          {
            stageId: "stage_3_review",
            title: "Stage 3: Read-Only Diff Review & Gate",
            dependsOn: ["stage_2_implement"],
            coreObjective: "Audit git diff for correctness, security invariants, and clean verification.",
            boundCapabilities: { extensions: [], skills: [], prompts: [] },
            expectedArtifact: primaryTestArtifact,
            expectedArtifacts: [primaryTestArtifact],
            artifactContract: "All verification commands pass with zero unaddressed defects.",
            verificationCommands: profile.testCommands,
            allowedTools: ["read", "grep", "find", "ls", "bash"],
            isReviewStage: true,
            reviewIsolation: {
              enabled: true,
              requireColdStart: true,
              diffOnlyContext: true,
            },
          },
        ];

  for (const stage of stages) {
    bindDeepEcosystemToStage(stage, availableMcpServers, discoveredSkills);
  }

  const dagResult = planDAGWaves(stages);
  const activatedExtensions = new Set<string>();
  const activatedSkills = new Set<string>();
  const activatedPrompts = new Set<string>();

  for (const stage of dagResult.sortedStages) {
    for (const ext of stage.boundCapabilities.extensions ?? []) activatedExtensions.add(ext);
    for (const sk of stage.boundCapabilities.skills ?? []) activatedSkills.add(sk);
    for (const pr of stage.boundCapabilities.prompts ?? []) activatedPrompts.add(pr);
  }

  return {
    blueprintId: `bp_${Date.now().toString(36)}`,
    task,
    createdAt: Date.now(),
    projectFingerprint: fp,
    userChoices: userDecisions,
    activatedCapabilities: {
      extensions: Array.from(activatedExtensions),
      skills: Array.from(activatedSkills),
      prompts: Array.from(activatedPrompts),
    },
    tokenEfficiencySummary: `Stage-scoped tool pruning active across ${dagResult.sortedStages.length} stage(s)`,
    stages: dagResult.sortedStages,
    dagWaves: dagResult.waves,
    dynamicGoals: diagnosis.dynamicGoals,
    customRequirements,
  };
}

export function generateStageActionPrompt(
  stage: BlueprintStage,
  blueprint: Blueprint,
  stageIndex: number
): string {
  const totalStages = blueprint.stages.length;
  const header = `[ToolFlow Stage ${stageIndex + 1}/${totalStages}: ${stage.title}]`;
  const lines: string[] = [
    header,
    `Task: ${blueprint.task}`,
    `Objective: ${stage.coreObjective}`,
    `Expected Artifact: ${stage.expectedArtifact}`,
    `Acceptance Contract: ${stage.artifactContract}`,
  ];

  if (stage.verificationCommands && stage.verificationCommands.length > 0) {
    lines.push(`Verification Commands: ${stage.verificationCommands.join(" && ")}`);
  }

  if (blueprint.customRequirements && blueprint.customRequirements.length > 0) {
    lines.push(`Custom Constraints: ${blueprint.customRequirements.join(" | ")}`);
  }

  if (stage.skillContract) {
    const sc = stage.skillContract;
    const directives = [...sc.rules, ...sc.checkpoints, ...sc.directives].slice(0, 4);
    if (directives.length > 0) {
      lines.push(`Skill Contract (${sc.skillName}): ${directives.join(" ; ")}`);
    }
  }

  if (stage.mcpToolBindings && stage.mcpToolBindings.length > 0) {
    lines.push(
      `MCP Bindings: ${stage.mcpToolBindings.map(b => `${b.server}.${b.tool} -> ${b.template}`).join(" | ")}`
    );
  }

  if (stage.isReviewStage) {
    lines.push("Review Mode: Read-only verification only. Inspect diffs and run checks without mutating code.");
  }

  return lines.join("\n");
}
