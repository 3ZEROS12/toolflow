export type LayerType = "L1_UTILITY" | "L2_PERCEPTION" | "L3_ORCHESTRATION" | "L4_REVIEW_GUARD";

export interface McpToolBinding {
  server: string;
  tool: string;
  reason: string;
  template: string; // 标准调用示例，如 mcp({ server: "playwright", tool: "screenshot", args: { path: "preview.png" } })
}

export interface DistilledSkillContract {
  skillName: string;
  filePath?: string;
  directives: string[];
  sopSteps: string[];
  rules: string[];
  checkpoints: string[];
}

export interface CapabilityItem {
  id: string;
  name: string;
  kind: "extension" | "skill" | "prompt" | "mcp" | "tool";
  layer: LayerType;
  description: string;
  tokenImpact: "minimal" | "low" | "medium" | "high";
  triggerWhen: string;
  summary?: string;
  tags?: string[];
  costLevel?: "$0" | "$1" | "$2" | "$3";
  bindingReason?: string;
  filePath?: string; // 物理路径 (针对 SKILL.md 或 prompt 模板)
  methods?: string[]; // 暴露的具体方法/命令列表 (针对 MCP Server 或插件)
}

export type ProjectType =
  | "node"
  | "rust"
  | "python"
  | "go"
  | "cpp"
  | "java"
  | "bun"
  | "deno"
  | "csharp"
  | "ruby"
  | "php"
  | "swift"
  | "kotlin"
  | "monorepo"
  | "generic_doc"
  | "unknown";

export interface ProjectFingerprint {
  projectType: ProjectType;
  mainFramework?: string;
  packageManager:
    | "npm"
    | "pnpm"
    | "yarn"
    | "bun"
    | "deno"
    | "cargo"
    | "pip"
    | "uv"
    | "poetry"
    | "go"
    | "cmake"
    | "gradle"
    | "maven"
    | "dotnet"
    | "unknown";
  hasGit: boolean;
  isClean: boolean;
  topLevelDirs: string[];
  coreDependencies: string[];
  gitBranch?: string;
  activeModifiedPaths?: string[]; // Git 变更集中度与受影响模块
  language?: string;
}

export interface EcosystemTaxonomy {
  installedFingerprint: string;
  projectFingerprint?: ProjectFingerprint;
  updatedAt: number | string;
  extensions: CapabilityItem[];
  skills: CapabilityItem[];
  prompts: CapabilityItem[];
  mcps?: CapabilityItem[];
  tools?: CapabilityItem[];
  availableToolNames?: string[]; // 真实存在且注册的工具名称清单 (来自 pi.getAllTools)
  summaryByLayer: Record<LayerType, number>;
}

export interface TradeOffDimension {
  name: string;
  scoreA: number; // 1-5
  scoreB: number; // 1-5
  commentary: string;
}

export interface ABMatrix {
  planA: {
    name: string;
    description: string;
    pros: string[];
    cons: string[];
    tokenOverhead: "minimal" | "low" | "medium" | "high";
    pipelineStagesCount?: number;
  };
  planB: {
    name: string;
    description: string;
    pros: string[];
    cons: string[];
    tokenOverhead: "minimal" | "low" | "medium" | "high";
    pipelineStagesCount?: number;
  };
  dimensions: TradeOffDimension[];
  recommendation: "A" | "B";
  rationale: string;
}

export interface TradeOffPlan {
  id: string;
  title: string;
  summary: string;
  matrix: ABMatrix;
}

export interface TaskRequirementChoice {
  id: string;
  label: string;
  description: string;
  isRecommended?: boolean;
  tradeOffAnalysis?: {
    pros: string[];
    cons: string[];
  };
  recommendedEcosystem: {
    extensions: string[];
    skills?: string[];
    prompts?: string[];
    reason: string;
    tokenSavingAdvice?: string;
  };
}

export interface TaskRequirementSlot {
  slotId: string;
  title: string;
  question: string;
  category?: "scope" | "design" | "storage" | "interaction" | "architecture" | "gate" | "general" | "ecosystem";
  options: TaskRequirementChoice[];
}

export interface TaskDiagnosis {
  taskDescription?: string;
  domain?: string;
  technicalStack?: string[];
  difficulty?: string;
  recommendedExtensions?: string[];
  recommendedSkills?: string[];
  researchSummary?: string;
  requirementSlots: TaskRequirementSlot[];
  decisionSlots?: TaskRequirementSlot[]; // alias for compatibility
  tradeOff?: TradeOffPlan;
  dynamicGoals?: string[];
  architectSparks?: Array<{
    id: string;
    title: string;
    description: string;
    impact: string;
    isAcceptedByDefault?: boolean;
  }>;
}

export type StageExecutionMode = "sequential" | "subagent_parallel" | "subagent_council" | "interactive_gate";

export interface BlueprintStage {
  stageId: string;
  title: string;
  roleProfile: string;
  coreObjective: string;
  mode?: StageExecutionMode;
  dependsOn?: string[]; // DAG 依赖前置阶段 ID 列表
  subagentDispatch?: {
    enabled?: boolean;
    agentName?: string;
    agentType?: string;
    task?: string;
    concurrency?: number;
    promptFlow?: string;
  };
  boundCapabilities?: {
    extensions?: string[];
    skills?: string[];
    prompts?: string[];
  };
  expectedArtifact: string;
  expectedArtifacts?: string[];
  targetPatterns?: string[];
  artifactContract: string;
  verificationCommands?: string[];
  allowedTools: string[];
  tokenCostNotice?: string;
  isInteractiveCoCreation?: boolean;
  proactiveInquiryPrompt?: string;
  previewUrl?: string;
  previewCommand?: string;
  isReviewStage?: boolean; // 是否属于独立审查/验收阶段 (触发冷启动审阅与 Diff 物理隔离)
  reviewIsolation?: {
    enabled: boolean;
    requireColdStart?: boolean;
    diffOnlyContext?: boolean;
  };
  mcpToolBindings?: McpToolBinding[]; // 深度方法级 MCP 绑定与调用模版
  skillContract?: DistilledSkillContract; // 深度蒸馏的 Skill SOP 契约
}

export interface DAGWave {
  waveIndex: number;
  stages: BlueprintStage[];
  isParallel: boolean;
}

export interface DAGPlanResult {
  sortedStages: BlueprintStage[];
  waves: DAGWave[];
  hasCycles: boolean;
  cycleNodes?: string[];
}

export interface Blueprint {
  blueprintId: string;
  task: string;
  createdAt: number;
  projectFingerprint?: ProjectFingerprint;
  userChoices: Record<string, string>;
  activatedCapabilities: {
    extensions: string[];
    skills: string[];
    prompts: string[];
  };
  tokenEfficiencySummary: string;
  stages: BlueprintStage[];
  dagWaves?: DAGWave[];
  dynamicGoals?: string[];
  customRequirements?: string[];
}

export interface ArtifactRecord {
  path: string;
  sha256: string;
  sizeBytes: number;
  verifiedAt: number;
  gitStatus?: "unmodified" | "modified" | "created" | "untracked";
}

export interface StageSnapshot {
  stageIndex: number;
  stageId: string;
  timestamp: number;
  fileHashes: Record<string, string>;
  fileContents?: Record<string, string>;
  changedFiles?: string[];
  gitTracked?: boolean;
  shadowCommitHash?: string;
  shadowRef?: string;
}

export interface StageVerificationResult {
  valid: boolean;
  artifactPath: string;
  record?: ArtifactRecord;
  changedFiles?: string[];
  remediationGuidance?: string;
  verificationCommands?: string[];
  exitCode?: number;
  isPrimaryMissing?: boolean;
  healingAttempt?: number;
  retryCount?: number;
  isCircuitBroken?: boolean;
  isExploring?: boolean;
  reason?: string;
  stderrOutput?: string;
}

export interface SessionPlanState {
  currentBlueprint: Blueprint | null;
  currentStageIndex: number;
  stepByStepGate: boolean;
  status: "idle" | "awaiting_user_decisions" | "in_progress" | "stage_completed" | "completed" | "paused" | "healing_failed_circuit_break";
  artifactLedger: Record<string, ArtifactRecord>;
  snapshots?: Record<number, StageSnapshot>;
  dynamicTargetFiles?: string[];
  changedFiles?: string[];
  retryCount?: number; // 当前阶段自愈重试计数 (0..3)
  shadowHeadCommit?: string; // 初始/阶段影子快照
  shadowCommitHash?: string;
  customDirectives?: string[]; // 用户动态追加的最高优先级需求
}

export interface RecommendedPackageItem {
  name: string;
  source: string; // e.g. "npm:@community/pi-git-guard" or "git:github.com/user/repo"
  description: string;
  leverageReason: string; // 为什么推荐它，能帮用户省下什么
  stars?: number;
  official?: boolean;
}

export interface EcosystemBundlePlan {
  id: string;
  title: string;
  description: string;
  packages: RecommendedPackageItem[];
  isRecommended?: boolean;
}

export type DecisionSlot = TaskRequirementSlot;

export type ArchitectNavigatorResult =
  | { kind: "task_input"; task: string }
  | { kind: "prompt_invoke"; command: string; filePath?: string }
  | { kind: "resume_blueprint" }
  | {
      kind: "decisions";
      decisions: Record<string, string>;
      task: string;
      customEcosystem?: {
        enabledExtensions?: string[];
        enabledSkills?: string[];
        enabledPrompts?: string[];
      };
      selectedPlan?: "A" | "B";
      customRequirements?: string[];
      autoProceed?: boolean; // 是否一键极速开工
    }
  | null;
