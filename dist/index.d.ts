import { ExtensionAPI } from '@earendil-works/pi-coding-agent';

type LayerType = "L1_UTILITY" | "L2_PERCEPTION" | "L3_ORCHESTRATION" | "L4_REVIEW_GUARD";
interface McpToolBinding {
    server: string;
    tool: string;
    reason: string;
    template: string;
}
interface DistilledSkillContract {
    skillName: string;
    filePath?: string;
    directives: string[];
    sopSteps: string[];
    rules: string[];
    checkpoints: string[];
}
interface CapabilityItem {
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
interface EcosystemTaxonomy {
    version: string;
    scannedAt: number;
    projectFingerprint?: ProjectFingerprint;
    extensions: CapabilityItem[];
    skills: CapabilityItem[];
    prompts: CapabilityItem[];
    tools: CapabilityItem[];
}
type ProjectType = "node" | "python" | "rust" | "go" | "cpp" | "monorepo" | "web" | "unknown";
interface ProjectFingerprint {
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
interface ProjectArtifactProfile {
    srcPath: string;
    testPath: string;
    summaryPath: string;
    testCommands: string[];
    buildCommands: string[];
    previewCommands: string[];
}
interface TaskRouteDecision {
    mode: "fast" | "blueprint";
    reason: string;
    estimatedComplexity: "low" | "medium" | "high";
}
interface TaskRequirementChoice {
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
interface TaskRequirementSlot {
    slotId: string;
    title: string;
    category: "scope" | "design" | "capability" | "verification" | "general";
    question: string;
    options: TaskRequirementChoice[];
}
interface TradeOffPlan {
    id: "A" | "B";
    title: string;
    tagline: string;
    pros: string[];
    cons: string[];
    estimatedEffort: string;
    recommendedFor: string;
}
interface ABMatrix {
    planA: TradeOffPlan;
    planB: TradeOffPlan;
    recommendedPlan: "A" | "B";
    rationale: string;
}
interface ArchitectSpark {
    id: string;
    title: string;
    description: string;
    impact: string;
    isAcceptedByDefault?: boolean;
}
interface TaskDiagnosis {
    taskDescription: string;
    researchSummary: string;
    requirementSlots: TaskRequirementSlot[];
    dynamicGoals: string[];
    tradeOff?: ABMatrix;
    architectSparks?: ArchitectSpark[];
}
interface BlueprintStage {
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
interface DAGWave {
    waveIndex: number;
    stages: BlueprintStage[];
    isParallel: boolean;
}
interface DAGPlanResult {
    sortedStages: BlueprintStage[];
    waves: DAGWave[];
    hasCycles: boolean;
    cycleNodes?: string[];
}
interface Blueprint {
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
interface ArtifactRecord {
    path: string;
    sha256: string;
    sizeBytes: number;
    verifiedAt: number;
    gitStatus?: "unmodified" | "modified" | "created" | "untracked";
}
interface StageSnapshot {
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
interface StageVerificationResult {
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
interface SessionPlanState {
    currentBlueprint: Blueprint | null;
    currentStageIndex: number;
    stepByStepGate: boolean;
    status: "idle" | "awaiting_user_decisions" | "in_progress" | "stage_completed" | "completed" | "paused" | "healing_failed_circuit_break";
    artifactLedger: Record<string, ArtifactRecord>;
    snapshots?: Record<number, StageSnapshot>;
    dynamicTargetFiles?: string[];
    changedFiles?: string[];
    retryCount?: number;
    shadowHeadCommit?: string;
    shadowCommitHash?: string;
    customDirectives?: string[];
}
interface RecommendedPackageItem {
    name: string;
    source: string;
    description: string;
    leverageReason: string;
    stars?: number;
    official?: boolean;
}
interface EcosystemBundlePlan {
    id: string;
    title: string;
    description: string;
    packages: RecommendedPackageItem[];
    isRecommended?: boolean;
}
type DecisionSlot = TaskRequirementSlot;
type ArchitectNavigatorResult = {
    kind: "task_input";
    task: string;
} | {
    kind: "prompt_invoke";
    command: string;
    filePath?: string;
} | {
    kind: "resume_blueprint";
} | {
    kind: "custom_ui_unavailable";
} | {
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
} | null;

/**
 * Normalizes a workspace root path into a stable map key.
 * On Windows, lowercases the resolved path to avoid drive-letter case fragmentation.
 */
declare function normalizeWorkspaceKey(cwd?: string): string;
/**
 * Checks whether `targetPath` resolves inside `workspaceRoot` (case-insensitive on Windows).
 */
declare function isPathInsideWorkspace(targetPath: string, workspaceRoot?: string): boolean;
/**
 * Non-spinning synchronous sleep using Atomics.wait.
 */
declare function sleepSync(ms: number): void;
/**
 * Atomically writes UTF-8 content to `filePath` via temp-file + rename with Windows lock backoff.
 */
declare function atomicWriteFileSync(filePath: string, content: string, options?: {
    backup?: boolean;
}): boolean;
/**
 * Removes leftover atomic temp files matching any of the given filename prefixes.
 */
declare function cleanupStaleTempFiles(dirPath: string, prefixes: string[]): void;

/**
 * Extracts a JSON object from LLM text output.
 *
 * Strategy:
 * 1. Prefer the first fenced ```json ... ``` (or ``` ... ```) block.
 * 2. Fall back to balanced-brace scanning across the raw text while respecting
 *    string literals and escape sequences.
 */
declare function extractValidJsonObject(raw: string): Record<string, unknown>;

/**
 * Unified English UI chrome and runtime notice dictionary for ToolFlow.
 * Task options and stage details generated by the active LLM adapt to the user's prompt language.
 */
declare const t: {
    readonly analyzingTask: (task: string) => string;
    readonly cancelled: "Task execution cancelled.";
    readonly noDecision: "No option selected. Exited.";
    readonly resetSuccess: "[OK] Cleared active task state and caches.";
    readonly exportNoBlueprint: "No active plan to export. Run `/toolflow <task>` first.";
    readonly exportSuccess: (fileName: string) => string;
    readonly rollbackNothing: "No active blueprint or rollback point available.";
    readonly rollbackSuccess: (stageNum: number, restoredCount: number, deletedCount: number) => string;
    readonly promptInserted: (cmd: string) => string;
    readonly blueprintStart: (stageCount: number, title: string) => string;
    readonly fastStart: (title: string) => string;
    readonly allCompleted: (task: string) => string;
    readonly stageVerified: (stageNum: number, artifact: string, shaPrefix: string) => string;
    readonly circuitBroken: (stageNum: number, artifact: string) => string;
    readonly contextDehydrated: "Context compacted and stage logs archived.";
    readonly noInteractiveUi: "Interactive UI unavailable. Use `/toolflow <task description>` directly.";
    readonly helpBanner: string;
    readonly toolOutputDehydrated: (toolName: string, lines: number, savedTokens: number) => string;
    readonly readCacheHitNotice: (file: string, tokens: number) => string;
    readonly compactNotice: (tokensSaved?: number) => string;
};

declare const BASELINE_TOOLS: readonly string[];
interface ToolRegistryHost {
    getActiveTools?: () => unknown;
    getAllTools?: () => unknown;
    setActiveTools?: (tools: string[]) => void;
}
declare function createEmptySessionState(): SessionPlanState;
declare function computeFileSha256(filePath: string): string;
declare function getGitChangedFiles(cwd?: string): {
    isGit: boolean;
    changedFiles: string[];
    untrackedFiles: string[];
};
declare class WorkspaceStateStore {
    readonly cwd: string;
    private state;
    private originalActiveToolsSnapshot;
    constructor(cwd?: string);
    getPersistFilePath(): string;
    getState(): Readonly<SessionPlanState>;
    updateState(mutator: (state: SessionPlanState) => void): void;
    setStatus(status: SessionPlanState["status"]): void;
    recordArtifact(artifactPath: string, record: ArtifactRecord): void;
    incrementRetry(): number;
    resetRetry(): void;
    addCustomDirective(directive: string): void;
    save(): boolean;
    /**
     * Lazily loads persisted blueprint state from disk if present.
     * Never creates `.pi/` or touches disk when no persisted file exists.
     */
    load(): SessionPlanState | null;
    clearMemory(): void;
    reset(): void;
    scanChangedFiles(): string[];
    captureStageSnapshot(stageIndex: number, stageId: string, blueprint: Blueprint): StageSnapshot;
    startBlueprintExecution(blueprint: Blueprint): void;
    advanceStage(): boolean;
    rollbackStage(targetStageIndex?: number): {
        success: boolean;
        rolledBackToStage: number;
        restoredFiles: string[];
        deletedFiles: string[];
        message: string;
    };
    recordInitialActiveTools(host: ToolRegistryHost | undefined): void;
    restoreInitialActiveTools(host: ToolRegistryHost | undefined): void;
    computeStageTools(stageAllowedTools?: string[]): string[];
    applyToolScoping(allowedTools: string[], host: ToolRegistryHost | undefined): void;
}
declare function getWorkspaceStore(cwd?: string): WorkspaceStateStore;
declare function clearAllWorkspaceStores(): void;

interface ToolFlowStats {
    totalTokensSaved: number;
    dehydratedLogsCount: number;
    readCacheHitsCount: number;
    blastRadiusBlocksCount: number;
    lastUpdated: number;
}
declare function emptyStats(): ToolFlowStats;
/** Compact the ledger back into a single snapshot once it grows past this. */
declare const STATS_COMPACT_BYTES: number;
interface StatsDelta {
    tokensSaved?: number;
    dehydratedLogs?: number;
    readCacheHits?: number;
    blastRadiusBlocks?: number;
}
/**
 * Append-only JSONL token-savings ledger with mtime+size memoization and
 * automatic atomic compaction.
 */
declare class StatsManager {
    private readonly statsFilePath;
    private cached;
    constructor(cwd?: string);
    getStats(): ToolFlowStats;
    recordSavings(delta: StatsDelta): ToolFlowStats;
    getFormattedSavings(): string;
    /** Absolute path of the append-only JSONL ledger backing these counters. */
    getLedgerPath(): string;
    /**
     * One-line status-bar fragment sized for the Pi footer and parsed by
     * pi-tui-status-beautifier (`~1.4k saved` / `N guarded`).
     * Zero-count counters are dropped so the badge stays short on narrow terminals.
     */
    getCompactBadge(): string;
    getSavingsSummary(baselineTokens?: number): {
        stats: ToolFlowStats;
        estimatedRatioPercent: number;
    };
    private aggregate;
    private compactIfNeeded;
}
declare function getStatsManager(cwd?: string): StatsManager;
declare function clearAllStatsManagers(): void;

interface ToolCallSecurityEvent {
    toolName: string;
    input?: Record<string, unknown>;
}
interface SecurityVerificationResult {
    block: boolean;
    reason?: string;
    escalationCandidate?: {
        filePath: string;
        absolutePath: string;
    };
}
/**
 * Workspace accident guard: enforces CWD containment, protects `.git`/`.env`/lockfiles,
 * blocks destructive shell patterns, and optionally checks active stage file scope.
 */
declare class BlastRadiusGuard {
    private allowedScope;
    private isScopeEnforced;
    configureStageScope(stage: BlueprintStage | null, additionalTargets?: string[]): void;
    grantDynamicScope(filePath: string): void;
    clearScope(): void;
    private normalizeRel;
    private extractTargetPath;
    private extractBashCommand;
    isCriticalFile(relPath: string): boolean;
    private matchesScope;
    verifyToolCall(event: ToolCallSecurityEvent, cwd?: string): SecurityVerificationResult;
}

interface ReadToolInput {
    path: string;
    offset?: number;
    limit?: number;
}
interface CacheCheckResult {
    isDuplicate: boolean;
    notice?: string;
    savedLines?: number;
    savedTokens?: number;
    bypassReason?: "targeted_window" | "recent_edit_failure" | "small_file" | "command_dirty" | "not_cached";
}
/**
 * Extracts a compact top-level symbol outline with line numbers for cache hit reminders.
 */
declare function extractSymbolOutline(fileContent: string, maxItems?: number): string[];
/**
 * Workspace-scoped file read cache with 6 penetration gates so targeted slices,
 * small files, command-dirtied files, and post-edit-failure re-reads always pass through.
 */
declare class ReadCacheManager {
    private readonly cwd;
    private readonly cache;
    private readonly recentEditFailurePaths;
    private isWorkspaceDirtyByCommand;
    private readonly minLineThreshold;
    constructor(cwd?: string);
    private resolveTarget;
    private computeHashAndStats;
    recordRead(input: ReadToolInput): void;
    markFileDirty(targetPath: string): void;
    markEditFailure(targetPath: string): void;
    markWorkspaceDirtyByCommand(): void;
    checkRead(input: ReadToolInput, autoRecord?: boolean): CacheCheckResult;
    private formatCacheHit;
    clear(): void;
    getCachedCount(): number;
}
declare function getReadCache(cwd?: string): ReadCacheManager;
declare function clearAllReadCaches(): void;

interface DehydratedStageHandoff {
    stageId: string;
    stageTitle: string;
    verifiedArtifacts: ArtifactRecord[];
    contractSummary: string;
    rawLogFilePath: string;
    tokenSavingsRatio: string;
    timestamp: number;
    topologyHints?: {
        importedFiles: string[];
        exportedSymbols: string[];
    };
}
interface ToolDehydrationResult {
    dehydrated: boolean;
    text: string;
    logFilePath?: string;
    originalLines: number;
    originalBytes: number;
    tokensSaved: number;
    loopBusterTriggered?: boolean;
}
interface FailureStreak {
    lastFailureHash: string;
    consecutiveIdenticalFailures: number;
}
/**
 * Compacts oversized bash/grep/find logs to `.pi/toolflow/runs/`, extracts semantic error frames,
 * triggers Loop Buster on repeated identical failures, and enforces disk quota hygiene.
 */
declare class ContextDehydrator {
    private readonly cwd;
    private readonly runsBaseDir;
    private lastFailedCommandHash;
    private consecutiveIdenticalFailures;
    private static readonly latestLogPaths;
    private static readonly protectedPathPools;
    constructor(cwd?: string);
    private static workspaceKey;
    static setProtectedPaths(paths: string[], cwd?: string): void;
    static getProtectedPaths(cwd?: string): Set<string>;
    static clearProtectedPaths(cwd?: string): void;
    static getLatestLogPath(cwd?: string): string | null;
    static setLatestLogPath(filePath: string, cwd?: string): void;
    static clearLatestLogPaths(): void;
    getDirectorySizeBytes(dirPath?: string): number;
    pruneOldRuns(maxAgeHours?: number, maxTotalBytes?: number): number;
    extractTopologyHints(stageText: string): {
        importedFiles: string[];
        exportedSymbols: string[];
    };
    extractSemanticErrors(lines: string[], isError: boolean): string[];
    getFailureStreak(): FailureStreak;
    dehydrateToolOutput(toolName: string, rawText: string, isError?: boolean, stageId?: string): ToolDehydrationResult;
    dehydrateStageLog(params: {
        stageId: string;
        stageTitle: string;
        rawStageOutput: string;
        verifiedArtifacts: ArtifactRecord[];
        contractSummary: string;
    }): DehydratedStageHandoff;
}
declare function getDehydrator(cwd?: string): ContextDehydrator;
declare function clearAllDehydrators(): void;

interface ProviderToolEntry {
    name?: string;
    [key: string]: unknown;
}
interface ContextSlimmingMessage {
    role?: string;
    toolName?: string;
    content?: unknown;
    [key: string]: unknown;
}
interface ContextSlimmingEvent {
    tools?: ProviderToolEntry[];
    messages?: ContextSlimmingMessage[];
}
declare function isHeavyTool(name: string): boolean;
/**
 * Prunes heavy external MCP, browser, and subagent tool schemas from the LLM context
 * unless explicitly permitted by the active blueprint stage.
 */
declare function pruneHeavyProviderTools(event: ContextSlimmingEvent, cwd?: string): void;
/**
 * Folds verbose historical tool results and `write`/`edit` argument echoes in the older half
 * of the transcript. Recent messages and anchor-protected contracts stay byte-identical.
 * Returns the estimated tokens released by this pass (0 when nothing was folded); the ledger
 * already holds the accumulated total, so callers use this only for per-turn reporting.
 */
declare function slimHistoricalContextMessages(event: ContextSlimmingEvent, cwd?: string): number;

/**
 * Unified LLM call bridge for Pi extensions.
 * Uses `ctx.modelRegistry.streamSimple(ctx.model, ...)` in real Pi hosts,
 * and falls back to `ctx.complete(...)` when provided by test doubles.
 */
interface LlmModelRuntime {
    model?: unknown;
    modelRegistry?: {
        streamSimple?: (model: unknown, payload: {
            systemPrompt?: string;
            messages: Array<{
                role: "user";
                content: Array<{
                    type: "text";
                    text: string;
                }>;
                timestamp: number;
            }>;
        }, options?: Record<string, unknown>) => AsyncIterable<unknown> & {
            result?: () => Promise<unknown>;
        };
    };
    complete?: (model: unknown, prompt: string, opts?: Record<string, unknown>) => Promise<unknown>;
}
declare function callExtensionLlm(ctx: LlmModelRuntime | undefined, systemPrompt: string, userPrompt: string, maxTokens?: number, timeoutMs?: number): Promise<string | null>;

declare function cleanName(rawName: string): string;
declare function generateCapabilityCompactDigest(item: Partial<CapabilityItem>): string;
declare function sniffProjectFingerprint(cwd?: string): ProjectFingerprint;
declare function discoverEcosystemTaxonomy(cwd?: string, runtimeTools?: unknown[]): EcosystemTaxonomy;
declare function loadOrRefreshTaxonomy(cwd?: string, runtimeTools?: unknown[]): EcosystemTaxonomy;
declare function reflectEnvironmentContext(ctx?: {
    getAllTools?: () => unknown;
}, cwd?: string): EcosystemTaxonomy;
declare function deepAnalyzeTaxonomyWithLLM(taxonomy: EcosystemTaxonomy, ctx?: LlmModelRuntime): Promise<EcosystemTaxonomy>;

declare class DeepSkillsDistiller {
    static distillFromFile(skillName: string, filePath: string): DistilledSkillContract;
}
declare class McpMethodRegistry {
    static resolveBindingsForStage(availableMcpServers: string[], stageObjective: string, isReviewStage?: boolean): McpToolBinding[];
}
declare function bindDeepEcosystemToStage(stage: BlueprintStage, availableMcpServers: string[], discoveredSkills: Array<{
    name: string;
    filePath?: string;
}>): void;
declare class EcosystemRadar {
    static scanCatalog(task: string, existingPackages?: string[]): EcosystemBundlePlan[];
    static resolvePiCliCommand(): string;
    static installEcosystemPackages(packages: RecommendedPackageItem[]): Promise<{
        success: boolean;
        installed: string[];
        failed: string[];
        log: string;
    }>;
}

/**
 * Computes topological execution waves using Kahn's algorithm and flags dependency cycles.
 */
declare function planDAGWaves(stages: BlueprintStage[]): DAGPlanResult;
type DegradationTier = "TIER_1_NATIVE" | "TIER_2_GENERIC" | "TIER_3_FALLBACK";
interface ToolCapabilityResolution {
    capability: string;
    selectedTool: string;
    fallbackTool: string;
    tier: DegradationTier;
    instruction: string;
}
/**
 * Resolves stage tool needs against currently registered Pi tools with 3-tier graceful fallback.
 */
declare class GracefulDegradationMatrix {
    private readonly availableTools;
    constructor(taxonomyOrTools?: EcosystemTaxonomy | string[]);
    hasTool(name: string): boolean;
    resolveCapability(capabilityType: "web_search" | "browser" | "subagent" | "lsp" | "mcp"): ToolCapabilityResolution;
    computeAdaptiveTools(stageAllowedTools?: string[]): {
        mergedTools: string[];
        degradedWarnings: string[];
    };
}

/**
 * Classifies whether a task needs a multi-stage blueprint or lightweight fast execution.
 */
declare function diagnoseTaskExecutionMode(task: string, fp?: ProjectFingerprint, userExplicitMode?: "fast" | "blueprint"): TaskRouteDecision;
/**
 * Maps a project's detected language/framework to realistic source, test, and verification commands.
 */
declare function inferArtifactProfile(fp?: ProjectFingerprint, cwd?: string): ProjectArtifactProfile;
declare function generateABTradeOffMatrix(task: string, fp?: ProjectFingerprint): ABMatrix;
declare function generateUniversalMetaSlots(task: string, _tax: EcosystemTaxonomy, fp: ProjectFingerprint, tradeOff: ABMatrix): TaskDiagnosis;
declare function diagnoseTaskRequirements(task: string, taxonomy: EcosystemTaxonomy, ctx?: LlmModelRuntime, providedFp?: ProjectFingerprint, cwd?: string): Promise<TaskDiagnosis>;

interface LlmArtifactPlan {
    primaryArtifact: string;
    targetLanguage: string;
    isFrontend: boolean;
    stageHeavyTools?: {
        stage1?: string[];
        stage2?: string[];
        stage3?: string[];
    };
}
declare function synthesizeBlueprintPlanWithLLM(task: string, taxonomy: EcosystemTaxonomy, ctx?: LlmModelRuntime, cwd?: string): Promise<LlmArtifactPlan>;
declare function synthesizeBlueprint(task: string, diagnosis: TaskDiagnosis, userDecisions: Record<string, string>, taxonomy: EcosystemTaxonomy, selectedPlan?: "A" | "B", customRequirements?: string[], llmArtifactPlan?: Partial<LlmArtifactPlan>, cwd?: string): Blueprint;
declare function generateStageActionPrompt(stage: BlueprintStage, blueprint: Blueprint, stageIndex: number): string;

interface ReviewSnapshot {
    baseSha?: string;
    headSha?: string;
    diffSummary: string;
    detailedDiff: string;
    changedFiles: string[];
    hasChanges?: boolean;
}
interface ReviewIsolationResult {
    isIsolated: boolean;
    isolationMode: "fresh_subagent" | "context_stripped_turn";
    snapshot: ReviewSnapshot;
    isolatedSystemPrompt: string;
    isolatedUserPrompt: string;
}
declare function captureReviewSnapshot(cwd?: string): ReviewSnapshot;
declare function buildReviewIsolationPrompt(stage: BlueprintStage, taskDescription: string, cwd?: string, hasSubagentTool?: boolean): ReviewIsolationResult;
/**
 * Blocks file-mutating tool calls during read-only review stages.
 */
declare class ReviewIsolationGuard {
    private active;
    activate(): void;
    deactivate(): void;
    isActive(): boolean;
    isToolAllowedInReview(toolName: string): boolean;
}
/**
 * Verifies stage artifacts on disk, executes verification commands, records SHA-256 ledger entries,
 * and drives the 3-attempt remediation circuit breaker.
 */
declare function verifyStageArtifacts(stage: BlueprintStage, cwd?: string, rawStageOutput?: string): StageVerificationResult;

interface PromptItemInfo {
    command: string;
    name: string;
    description: string;
    scope: "global" | "project" | "package";
    category: "user" | "system";
    filePath: string;
    updatedAt: number;
    lastUsedAt?: number;
}
declare class PromptsManager {
    private static getAgentDir;
    private static getMruFilePath;
    static loadMruMap(): Record<string, number>;
    static recordPromptUsage(command: string): void;
    static getRecentPrompts(prompts: PromptItemInfo[], limit?: number): PromptItemInfo[];
    static scanAllPrompts(cwd?: string): PromptItemInfo[];
    static addUserPrompt(name: string, description: string, content: string): PromptItemInfo;
    static deleteUserPrompt(filePath: string): boolean;
    static getPromptPreviewLines(filePath: string, maxLines?: number): string[];
    static autoTagPromptWithLLM(content: string, ctx?: LlmModelRuntime): Promise<{
        name: string;
        description: string;
    }>;
}

interface ArchitecturalLesson {
    id: string;
    topic: string;
    rule: string;
    rationale: string;
    tags: string[];
    timestamp: number;
}
interface CodebaseMemoryStore {
    version: "1.0.0";
    codebaseId: string;
    updatedAt: number;
    conventions: string[];
    lessons: ArchitecturalLesson[];
}
declare class CodebaseMemoryManager {
    private readonly memoryFilePath;
    private readonly workspaceRoot;
    constructor(cwd?: string);
    loadMemory(): CodebaseMemoryStore;
    private saveMemory;
    recordLesson(topic: string, rule: string, rationale: string, tags?: string[]): boolean;
    recordConvention(convention: string): boolean;
    getRelevantLessonsPrompt(taskKeywords?: string[]): string;
}
declare function getCodebaseMemory(cwd?: string): CodebaseMemoryManager;
declare function clearAllCodebaseMemories(): void;

interface AnchorStateEntry {
    id?: string | number;
    title?: string;
    cwd?: string;
    project?: string;
    status?: string;
    files?: unknown;
}
/**
 * Returns the file paths and titles of active anchors bound to the workspace.
 * Follows the Playbook 7 handshake (anchor -> toolflow): tolerant of missing or partial state.
 */
declare function loadActiveAnchorFiles(cwd?: string): string[];
/**
 * Builds the compact "Active Anchors" line injected into planning prompts.
 * Returns an empty string when no anchor matches the workspace.
 */
declare function formatActiveAnchorHint(cwd?: string): string;
/**
 * True when a message must never be folded: machine contracts, anchor focus, or anchored files.
 */
declare function isProtectedAnchorText(text: string, anchorFiles?: string[]): boolean;

interface UiThemeLike {
    bold: (s: string) => string;
    fg: (color: string, s: string) => string;
    bg?: (color: string, s: string) => string;
}
/**
 * Single-line CJK-safe input viewport helper using UAX #11 visible column width.
 */
declare function renderCJKSafeInputBox(prefix: string, text: string, windowWidth: number, theme: Pick<UiThemeLike, "fg">, showCursor?: boolean, emitHardwareCursor?: boolean): string;
declare function padToVisibleWidth(content: string, targetWidth: number): string;
declare function renderValueReceipt(metrics: {
    task: string;
    blueprintId: string;
    stageCount: number;
    verifiedFiles: string[];
    totalDurationSec?: number;
    durationSec?: number;
    tokenSavingsRatio?: string;
    tokensSavedPct?: number;
}): string[];
declare function renderExecutionPipelineCard(params: {
    blueprintId: string;
    task: string;
    currentStageIndex: number;
    stages: BlueprintStage[];
    activeWorkers?: Array<{
        name: string;
        tool: string;
        status: string;
    }>;
    verifiedArtifactCount: number;
}): string;
declare function renderUnicodeDAG(stages: BlueprintStage[], options?: {
    currentStageIndex?: number;
    width?: number;
    theme?: UiThemeLike;
}): string[];
declare function renderSavingsLedger(metrics: {
    stats: {
        totalTokensSaved: number;
        dehydratedLogsCount: number;
        readCacheHitsCount: number;
        blastRadiusBlocksCount: number;
        lastUpdated: number;
    };
    estimatedRatioPercent?: number;
    ledgerPath?: string;
}): string;
declare function renderCompactEcosystemOverview(tax: EcosystemTaxonomy): string;
declare function renderBlueprintSummary(bp: Blueprint): string;

interface CustomUiTheme {
    fg: (color: string, text: string) => string;
    bg?: (color: string, text: string) => string;
    bold: (text: string) => string;
}
interface CustomUiTui {
    terminal?: {
        rows: number;
        columns: number;
    };
    requestRender: () => void;
}
interface CustomUiHost {
    custom: <T>(factory: (tui: CustomUiTui, theme: CustomUiTheme, keybindings: unknown, done: (result: T) => void) => {
        focused: boolean;
        invalidate: () => void;
        render: (width: number) => string[];
        handleInput: (data: string) => void;
    }) => Promise<T>;
}
/**
 * Interactive Prompt Workbench & Staged Blueprint Decision Navigator (`ctx.ui.custom`).
 */
declare function openArchitectNavigator(ui: CustomUiHost, _taxonomy: EcosystemTaxonomy, initialTask?: string, slots?: DecisionSlot[], diagnosis?: TaskDiagnosis, ctx?: LlmModelRuntime & {
    cwd?: string;
}): Promise<ArchitectNavigatorResult>;

/**
 * ToolFlow Pi Coding Agent Extension entrypoint.
 * Initializes lazily with zero filesystem side effects until session hooks or commands execute.
 */
declare function toolflow(pi: ExtensionAPI): void;

export { type ABMatrix, type AnchorStateEntry, type ArchitectNavigatorResult, type ArchitectSpark, type ArchitecturalLesson, type ArtifactRecord, BASELINE_TOOLS, BlastRadiusGuard, type Blueprint, type BlueprintStage, type CacheCheckResult, type CapabilityItem, CodebaseMemoryManager, type CodebaseMemoryStore, ContextDehydrator, type ContextSlimmingEvent, type ContextSlimmingMessage, type CustomUiHost, type DAGPlanResult, type DAGWave, type DecisionSlot, DeepSkillsDistiller, type DegradationTier, type DehydratedStageHandoff, type DistilledSkillContract, type EcosystemBundlePlan, EcosystemRadar, type EcosystemTaxonomy, GracefulDegradationMatrix, type LayerType, type LlmArtifactPlan, type LlmModelRuntime, McpMethodRegistry, type McpToolBinding, type ProjectArtifactProfile, type ProjectFingerprint, type ProjectType, type PromptItemInfo, PromptsManager, type ProviderToolEntry, ReadCacheManager, type ReadToolInput, type RecommendedPackageItem, ReviewIsolationGuard, type ReviewIsolationResult, type ReviewSnapshot, STATS_COMPACT_BYTES, type SecurityVerificationResult, type SessionPlanState, type StageSnapshot, type StageVerificationResult, StatsManager, type TaskDiagnosis, type TaskRequirementChoice, type TaskRequirementSlot, type TaskRouteDecision, type ToolCallSecurityEvent, type ToolCapabilityResolution, type ToolDehydrationResult, type ToolFlowStats, type ToolRegistryHost, type TradeOffPlan, type UiThemeLike, WorkspaceStateStore, atomicWriteFileSync, bindDeepEcosystemToStage, buildReviewIsolationPrompt, callExtensionLlm, captureReviewSnapshot, cleanName, cleanupStaleTempFiles, clearAllCodebaseMemories, clearAllDehydrators, clearAllReadCaches, clearAllStatsManagers, clearAllWorkspaceStores, computeFileSha256, createEmptySessionState, deepAnalyzeTaxonomyWithLLM, toolflow as default, diagnoseTaskExecutionMode, diagnoseTaskRequirements, discoverEcosystemTaxonomy, emptyStats, extractSymbolOutline, extractValidJsonObject, formatActiveAnchorHint, generateABTradeOffMatrix, generateCapabilityCompactDigest, generateStageActionPrompt, generateUniversalMetaSlots, getCodebaseMemory, getDehydrator, getGitChangedFiles, getReadCache, getStatsManager, getWorkspaceStore, inferArtifactProfile, isHeavyTool, isPathInsideWorkspace, isProtectedAnchorText, loadActiveAnchorFiles, loadOrRefreshTaxonomy, normalizeWorkspaceKey, openArchitectNavigator, padToVisibleWidth, planDAGWaves, pruneHeavyProviderTools, reflectEnvironmentContext, renderBlueprintSummary, renderCJKSafeInputBox, renderCompactEcosystemOverview, renderExecutionPipelineCard, renderSavingsLedger, renderUnicodeDAG, renderValueReceipt, sleepSync, slimHistoricalContextMessages, sniffProjectFingerprint, synthesizeBlueprint, synthesizeBlueprintPlanWithLLM, t, verifyStageArtifacts };
