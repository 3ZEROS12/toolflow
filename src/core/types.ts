export type LayerType = "L1_UTILITY" | "L2_PERCEPTION" | "L3_ORCHESTRATION" | "L4_REVIEW_GUARD";

export interface McpToolBinding {
  server: string;
  tool: string;
  reason: string;
  template: string;
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
  cleanName: string;
  type: "extension" | "skill" | "prompt" | "tool";
  layer?: LayerType;
  layerReason?: string;
  description: string;
  compactDigest: string;
  filePath?: string;
  mcpServers?: string[];
}

export interface EcosystemTaxonomy {
  version: string;
  scannedAt: number;
  projectFingerprint?: ProjectFingerprint;
  extensions: CapabilityItem[];
  skills: CapabilityItem[];
  prompts: CapabilityItem[];
  tools: CapabilityItem[];
}

export type ProjectType = "node" | "python" | "rust" | "go" | "cpp" | "monorepo" | "web" | "unknown";

export interface ProjectFingerprint {
  projectType: ProjectType;
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "pip" | "uv" | "poetry" | "cargo" | "go" | "cmake" | "unknown";
  mainFramework?: string;
  sourceDir: string;
  testDir: string;
  hasGit: boolean;
  isDirty: boolean;
  changedModules: string[];
  keyConfigFiles: string[];
}

export interface ProjectArtifactProfile {
  srcPath: string;
  testPath: string;
  summaryPath: string;
  testCommands: string[];
  buildCommands: string[];
  previewCommands: string[];
}

export interface TaskRouteDecision {
  mode: "fast" | "blueprint";
  reason: string;
  estimatedComplexity: "low" | "medium" | "high";
}

export interface TaskRequirementChoice {
  id: string;
  label: string;
  description: string;
  isRecommended?: boolean;
  recommendedEcosystem: {
    extensions?: string[];
    skills?: string[];
    prompts?: string[];
    reason: string;
  };
}

export interface TaskRequirementSlot {
  slotId: string;
  title: string;
  category: "scope" | "design" | "capability" | "verification" | "general";
  question: string;
  options: TaskRequirementChoice[];
}

export interface TradeOffPlan {
  id: "A" | "B";
  title: string;
  tagline: string;
  pros: string[];
  cons: string[];
  estimatedEffort: string;
  recommendedFor: string;
}

export interface ABMatrix {
  planA: TradeOffPlan;
  planB: TradeOffPlan;
  recommendedPlan: "A" | "B";
  rationale: string;
}

export interface ArchitectSpark {
  id: string;
  title: string;
  description: string;
  impact: string;
  isAcceptedByDefault?: boolean;
}

export interface TaskDiagnosis {
  taskDescription: string;
  researchSummary: string;
  requirementSlots: TaskRequirementSlot[];
  dynamicGoals: string[];
  tradeOff?: ABMatrix;
  architectSparks?: ArchitectSpark[];
}

export interface BlueprintStage {
  stageId: string;
  title: string;
  dependsOn?: string[];
  coreObjective: string;
  boundCapabilities: {
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
  isReviewStage?: boolean;
  reviewIsolation?: {
    enabled: boolean;
    requireColdStart?: boolean;
    diffOnlyContext?: boolean;
  };
  mcpToolBindings?: McpToolBinding[];
  skillContract?: DistilledSkillContract;
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
  missingExpected?: string;
  heuristicReason?: string;
}

export interface SessionPlanState {
  currentBlueprint: Blueprint | null;
  currentStageIndex: number;
  stepByStepGate: boolean;
  status:
    | "idle"
    | "awaiting_user_decisions"
    | "in_progress"
    | "stage_completed"
    | "completed"
    | "paused"
    | "healing_failed_circuit_break";
  artifactLedger: Record<string, ArtifactRecord>;
  snapshots?: Record<number, StageSnapshot>;
  dynamicTargetFiles?: string[];
  changedFiles?: string[];
  retryCount?: number;
  shadowHeadCommit?: string;
  shadowCommitHash?: string;
  customDirectives?: string[];
}

export interface RecommendedPackageItem {
  name: string;
  source: string;
  description: string;
  leverageReason: string;
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
  | { kind: "custom_ui_unavailable" }
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
      autoProceed?: boolean;
    }
  | null;
