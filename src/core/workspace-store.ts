import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";
import type {
  ArtifactRecord,
  Blueprint,
  SessionPlanState,
  StageSnapshot,
} from "./types.js";
import {
  atomicWriteFileSync,
  cleanupStaleTempFiles,
  normalizeWorkspaceKey,
} from "./atomic-fs.js";

export const BASELINE_TOOLS: readonly string[] = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
];

export interface ToolRegistryHost {
  getActiveTools?: () => unknown;
  getAllTools?: () => unknown;
  setActiveTools?: (tools: string[]) => void;
}

export function createEmptySessionState(): SessionPlanState {
  return {
    currentBlueprint: null,
    currentStageIndex: 0,
    stepByStepGate: true,
    status: "idle",
    artifactLedger: {},
    snapshots: {},
    dynamicTargetFiles: [],
    retryCount: 0,
  };
}

export function computeFileSha256(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch {
    return "";
  }
}

export function getGitChangedFiles(cwd: string = process.cwd()): {
  isGit: boolean;
  changedFiles: string[];
  untrackedFiles: string[];
} {
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 2000,
    });
    const statusOutput = execSync("git status --porcelain", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 2000,
    });
    const changedFiles: string[] = [];
    const untrackedFiles: string[] = [];
    for (const rawLine of statusOutput.split(/\r?\n/)) {
      if (!rawLine || rawLine.length < 4) continue;
      const code = rawLine.slice(0, 2);
      const filePart = rawLine.slice(3).trim();
      const normalized = (
        filePart.includes(" -> ") ? filePart.split(" -> ").pop()!.trim() : filePart
      ).replace(/\\/g, "/");
      if (normalized === ".pi" || normalized.startsWith(".pi/")) continue;
      if (code === "??") {
        untrackedFiles.push(normalized);
      } else {
        changedFiles.push(normalized);
      }
    }
    return { isGit: true, changedFiles, untrackedFiles };
  } catch {
    return { isGit: false, changedFiles: [], untrackedFiles: [] };
  }
}

function extractToolNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      names.push(item);
    } else if (item && typeof item === "object" && "name" in item && typeof item.name === "string") {
      names.push(item.name);
    }
  }
  return names;
}

function cloneState(src: SessionPlanState): SessionPlanState {
  return {
    ...src,
    artifactLedger: { ...src.artifactLedger },
    snapshots: src.snapshots ? { ...src.snapshots } : {},
    dynamicTargetFiles: src.dynamicTargetFiles ? [...src.dynamicTargetFiles] : [],
    changedFiles: src.changedFiles ? [...src.changedFiles] : [],
    customDirectives: src.customDirectives ? [...src.customDirectives] : undefined,
  };
}

function hydrateStateFromJson(rawJson: string): SessionPlanState | null {
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (!parsed || typeof parsed !== "object" || !("currentBlueprint" in parsed)) {
      return null;
    }
    const obj = parsed as Partial<SessionPlanState>;
    if (!obj.currentBlueprint) return null;
    return {
      currentBlueprint: obj.currentBlueprint,
      currentStageIndex: typeof obj.currentStageIndex === "number" ? obj.currentStageIndex : 0,
      stepByStepGate: typeof obj.stepByStepGate === "boolean" ? obj.stepByStepGate : true,
      status: obj.status ?? "idle",
      artifactLedger: obj.artifactLedger ?? {},
      snapshots: obj.snapshots ?? {},
      dynamicTargetFiles: Array.isArray(obj.dynamicTargetFiles) ? obj.dynamicTargetFiles : [],
      changedFiles: Array.isArray(obj.changedFiles) ? obj.changedFiles : [],
      retryCount: typeof obj.retryCount === "number" ? obj.retryCount : 0,
      shadowHeadCommit: obj.shadowHeadCommit,
      shadowCommitHash: obj.shadowCommitHash,
      customDirectives: Array.isArray(obj.customDirectives) ? obj.customDirectives : undefined,
    };
  } catch {
    return null;
  }
}

export class WorkspaceStateStore {
  public readonly cwd: string;
  private state: SessionPlanState = createEmptySessionState();
  private originalActiveToolsSnapshot: string[] | null = null;

  constructor(cwd: string = process.cwd()) {
    this.cwd = path.resolve(cwd || process.cwd());
  }

  public getPersistFilePath(): string {
    return path.join(this.cwd, ".pi", "blueprint_state.json");
  }

  public getState(): Readonly<SessionPlanState> {
    return cloneState(this.state);
  }

  public updateState(mutator: (state: SessionPlanState) => void): void {
    mutator(this.state);
    this.save();
  }

  public setStatus(status: SessionPlanState["status"]): void {
    this.state.status = status;
    this.save();
  }

  public recordArtifact(artifactPath: string, record: ArtifactRecord): void {
    this.state.artifactLedger[artifactPath] = record;
    this.save();
  }

  public incrementRetry(): number {
    this.state.retryCount = (this.state.retryCount ?? 0) + 1;
    if (this.state.retryCount >= 3) {
      this.state.status = "healing_failed_circuit_break";
    }
    this.save();
    return this.state.retryCount;
  }

  public resetRetry(): void {
    this.state.retryCount = 0;
  }

  public addCustomDirective(directive: string): void {
    const trimmed = directive.trim();
    if (!trimmed) return;
    if (!this.state.customDirectives) this.state.customDirectives = [];
    if (!this.state.customDirectives.includes(trimmed)) {
      this.state.customDirectives.push(trimmed);
      this.save();
    }
  }

  public save(): boolean {
    try {
      const filePath = this.getPersistFilePath();
      return atomicWriteFileSync(filePath, JSON.stringify(this.state, null, 2), { backup: true });
    } catch {
      return false;
    }
  }

  /**
   * Lazily loads persisted blueprint state from disk if present.
   * Never creates `.pi/` or touches disk when no persisted file exists.
   */
  public load(): SessionPlanState | null {
    const filePath = this.getPersistFilePath();
    const bakPath = `${filePath}.bak`;

    if (!fs.existsSync(filePath) && !fs.existsSync(bakPath)) {
      return null;
    }

    if (fs.existsSync(filePath)) {
      try {
        const hydrated = hydrateStateFromJson(fs.readFileSync(filePath, "utf-8"));
        if (hydrated) {
          this.state = hydrated;
          return this.getState();
        }
      } catch {
        // Fall through to .bak recovery
      }
    }

    if (fs.existsSync(bakPath)) {
      try {
        const hydrated = hydrateStateFromJson(fs.readFileSync(bakPath, "utf-8"));
        if (hydrated) {
          this.state = hydrated;
          return this.getState();
        }
      } catch {
        // Corrupted backup ignored
      }
    }

    return null;
  }

  public clearMemory(): void {
    this.state = createEmptySessionState();
  }

  public reset(): void {
    this.clearMemory();
    const gitInfo = getGitChangedFiles(this.cwd);
    this.state.changedFiles = [...gitInfo.changedFiles, ...gitInfo.untrackedFiles];

    const filePath = this.getPersistFilePath();
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // Ignore unlink failure
    }
    try {
      if (fs.existsSync(`${filePath}.bak`)) fs.unlinkSync(`${filePath}.bak`);
    } catch {
      // Ignore unlink failure
    }
    cleanupStaleTempFiles(path.dirname(filePath), ["blueprint_state.json.tmp.", "stats.json.tmp."]);
  }

  public scanChangedFiles(): string[] {
    const targets: string[] = [];
    if (this.state.currentBlueprint) {
      for (const stage of this.state.currentBlueprint.stages) {
        if (stage.expectedArtifact && !targets.includes(stage.expectedArtifact)) {
          targets.push(stage.expectedArtifact);
        }
        for (const extra of stage.expectedArtifacts ?? []) {
          if (extra && !targets.includes(extra)) targets.push(extra);
        }
      }
    }

    const gitInfo = getGitChangedFiles(this.cwd);
    if (gitInfo.isGit) {
      const merged = Array.from(
        new Set([...gitInfo.changedFiles, ...gitInfo.untrackedFiles, ...targets])
      );
      this.state.changedFiles = merged;
      return merged;
    }

    const ignored: Record<string, true> = {
      node_modules: true,
      ".git": true,
      ".pi": true,
      dist: true,
      build: true,
      ".next": true,
      target: true,
    };
    const files: string[] = [...targets];
    const walk = (dir: string, depth: number): void => {
      if (depth > 3 || files.length >= 60) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= 60) break;
        if (ignored[entry.name] || entry.name.startsWith(".")) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile()) {
          const rel = path.relative(this.cwd, full).replace(/\\/g, "/");
          if (!files.includes(rel)) files.push(rel);
        }
      }
    };
    walk(this.cwd, 0);
    this.state.changedFiles = files;
    return files;
  }

  public captureStageSnapshot(stageIndex: number, stageId: string, blueprint: Blueprint): StageSnapshot {
    const fileHashes: Record<string, string> = {};
    const fileContents: Record<string, string> = {};

    const candidates = new Set<string>(this.scanChangedFiles());
    for (const stage of blueprint.stages) {
      if (stage.expectedArtifact) candidates.add(stage.expectedArtifact);
      for (const art of stage.expectedArtifacts ?? []) {
        if (art) candidates.add(art);
      }
    }

    const resolvedCwd = path.resolve(this.cwd);
    for (const relPath of candidates) {
      const fullPath = path.resolve(resolvedCwd, relPath);
      if (fullPath !== resolvedCwd && !fullPath.startsWith(resolvedCwd + path.sep)) continue;
      if (!fs.existsSync(fullPath)) continue;
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          fileHashes[relPath] = computeFileSha256(fullPath);
          if (stat.size <= 512 * 1024) {
            fileContents[relPath] = fs.readFileSync(fullPath, "utf-8");
          }
        }
      } catch {
        // Ignore unreadable snapshot candidate
      }
    }

    let gitTracked = false;
    let shadowCommitHash: string | undefined;
    let shadowRef: string | undefined;

    try {
      const gitInfo = getGitChangedFiles(this.cwd);
      if (gitInfo.isGit) {
        gitTracked = true;
        try {
          shadowCommitHash = execSync("git rev-parse HEAD", {
            cwd: this.cwd,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "ignore"],
            timeout: 2000,
          }).trim();
        } catch {
          shadowCommitHash = undefined;
        }
        try {
          const stashSha = execSync("git stash create", {
            cwd: this.cwd,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "ignore"],
            timeout: 4000,
          }).trim();
          if (stashSha) {
            shadowRef = `refs/toolflow-shadows/stage_${stageIndex}_${Date.now()}`;
            execSync(`git update-ref "${shadowRef}" ${stashSha}`, {
              cwd: this.cwd,
              stdio: "ignore",
              timeout: 2000,
            });
          }
        } catch {
          // Empty diff or detached repo
        }
      }
    } catch {
      gitTracked = false;
    }

    const snapshot: StageSnapshot = {
      stageIndex,
      stageId,
      timestamp: Date.now(),
      fileHashes,
      fileContents,
      changedFiles: Array.from(candidates),
      gitTracked,
      shadowCommitHash,
      shadowRef,
    };

    if (!this.state.snapshots) this.state.snapshots = {};
    this.state.snapshots[stageIndex] = snapshot;
    this.save();
    return snapshot;
  }

  public startBlueprintExecution(blueprint: Blueprint): void {
    this.state.currentBlueprint = blueprint;
    this.state.currentStageIndex = 0;
    this.state.stepByStepGate = true;
    this.state.status = "in_progress";
    this.state.artifactLedger = {};
    this.state.snapshots = {};
    this.state.dynamicTargetFiles = [];
    this.state.retryCount = 0;
    this.state.customDirectives = blueprint.customRequirements ? [...blueprint.customRequirements] : [];

    for (const stage of blueprint.stages) {
      if (stage.expectedArtifact && !this.state.dynamicTargetFiles.includes(stage.expectedArtifact)) {
        this.state.dynamicTargetFiles.push(stage.expectedArtifact);
      }
      for (const art of stage.expectedArtifacts ?? []) {
        if (art && !this.state.dynamicTargetFiles.includes(art)) {
          this.state.dynamicTargetFiles.push(art);
        }
      }
    }

    const firstStage = blueprint.stages[0];
    if (firstStage) {
      this.captureStageSnapshot(0, firstStage.stageId, blueprint);
    }
    this.save();
  }

  public advanceStage(): boolean {
    if (!this.state.currentBlueprint) return false;
    const nextIdx = this.state.currentStageIndex + 1;
    this.state.retryCount = 0;

    if (nextIdx < this.state.currentBlueprint.stages.length) {
      this.state.currentStageIndex = nextIdx;
      this.state.status = "in_progress";
      const nextStage = this.state.currentBlueprint.stages[nextIdx];
      if (nextStage) {
        this.captureStageSnapshot(nextIdx, nextStage.stageId, this.state.currentBlueprint);
      }
      this.save();
      return true;
    }

    this.state.status = "completed";
    this.save();
    return false;
  }

  public rollbackStage(targetStageIndex?: number): {
    success: boolean;
    rolledBackToStage: number;
    restoredFiles: string[];
    deletedFiles: string[];
    message: string;
  } {
    if (!this.state.currentBlueprint || !this.state.snapshots) {
      return {
        success: false,
        rolledBackToStage: this.state.currentStageIndex,
        restoredFiles: [],
        deletedFiles: [],
        message: "No active blueprint or snapshot available for rollback.",
      };
    }

    const rollbackIdx =
      targetStageIndex !== undefined
        ? Math.max(0, Math.min(targetStageIndex, this.state.currentStageIndex))
        : this.state.currentStageIndex;

    const snapshot = this.state.snapshots[rollbackIdx];
    if (!snapshot) {
      return {
        success: false,
        rolledBackToStage: this.state.currentStageIndex,
        restoredFiles: [],
        deletedFiles: [],
        message: `Snapshot for stage ${rollbackIdx + 1} was not found.`,
      };
    }

    const restoredFiles: string[] = [];
    const deletedFiles: string[] = [];
    const resolvedCwd = path.resolve(this.cwd);

    // 1. Restore tracked/untracked files from shadow commit/ref when present
    if (snapshot.shadowRef) {
      try {
        execSync(`git checkout "${snapshot.shadowRef}" -- .`, {
          cwd: this.cwd,
          stdio: "ignore",
          timeout: 5000,
        });
        execSync(`git reset HEAD`, { cwd: this.cwd, stdio: "ignore", timeout: 3000 });
      } catch {
        // Fall through to file-content restoration
      }
    } else if (snapshot.shadowCommitHash) {
      try {
        execSync(`git checkout ${snapshot.shadowCommitHash} -- .`, {
          cwd: this.cwd,
          stdio: "ignore",
          timeout: 5000,
        });
      } catch {
        // Fall through to file-content restoration
      }
    }

    // 2. Restore exact file contents from snapshot
    for (const [relPath, content] of Object.entries(snapshot.fileContents ?? {})) {
      const fullPath = path.resolve(resolvedCwd, relPath);
      if (fullPath !== resolvedCwd && !fullPath.startsWith(resolvedCwd + path.sep)) continue;
      try {
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fullPath, content, "utf-8");
        restoredFiles.push(relPath);
      } catch {
        // Ignore locked target
      }
    }

    // 3. Remove artifacts introduced in later stages that did not exist in the target snapshot
    for (let i = rollbackIdx; i < this.state.currentBlueprint.stages.length; i++) {
      const stage = this.state.currentBlueprint.stages[i];
      if (!stage) continue;
      const candidates = [stage.expectedArtifact, ...(stage.expectedArtifacts ?? [])].filter(
        (v): v is string => Boolean(v)
      );
      for (const relPath of candidates) {
        if (snapshot.fileHashes[relPath] !== undefined) continue;
        const fullPath = path.resolve(resolvedCwd, relPath);
        if (fullPath !== resolvedCwd && !fullPath.startsWith(resolvedCwd + path.sep)) continue;
        if (fs.existsSync(fullPath)) {
          try {
            fs.unlinkSync(fullPath);
            deletedFiles.push(relPath);
          } catch {
            // Ignore locked file
          }
        }
        delete this.state.artifactLedger[relPath];
      }
    }

    this.state.currentStageIndex = rollbackIdx;
    this.state.status = "in_progress";
    this.state.retryCount = 0;
    this.save();

    return {
      success: true,
      rolledBackToStage: rollbackIdx,
      restoredFiles,
      deletedFiles,
      message: `Rolled back to Stage ${rollbackIdx + 1} (${snapshot.stageId}). Restored ${restoredFiles.length}, removed ${deletedFiles.length} file(s).`,
    };
  }

  public recordInitialActiveTools(host: ToolRegistryHost | undefined): void {
    if (this.originalActiveToolsSnapshot !== null) return;
    if (!host) return;
    if (typeof host.getActiveTools === "function") {
      const active = extractToolNames(host.getActiveTools());
      if (active.length > 0) {
        this.originalActiveToolsSnapshot = active;
        return;
      }
    }
    if (typeof host.getAllTools === "function") {
      const all = extractToolNames(host.getAllTools());
      if (all.length > 0) {
        this.originalActiveToolsSnapshot = all;
      }
    }
  }

  public restoreInitialActiveTools(host: ToolRegistryHost | undefined): void {
    if (!host || typeof host.setActiveTools !== "function") return;
    if (this.originalActiveToolsSnapshot && this.originalActiveToolsSnapshot.length > 0) {
      host.setActiveTools(this.originalActiveToolsSnapshot);
      return;
    }
    if (typeof host.getAllTools === "function") {
      const all = extractToolNames(host.getAllTools());
      if (all.length > 0) {
        host.setActiveTools(all);
        return;
      }
    }
    host.setActiveTools([...BASELINE_TOOLS]);
  }

  public computeStageTools(stageAllowedTools: string[] = []): string[] {
    return Array.from(new Set([...BASELINE_TOOLS, ...stageAllowedTools]));
  }

  public applyToolScoping(allowedTools: string[], host: ToolRegistryHost | undefined): void {
    this.recordInitialActiveTools(host);
    const merged = this.computeStageTools(allowedTools);
    if (!host || typeof host.setActiveTools !== "function") return;

    if (typeof host.getAllTools === "function") {
      const registered = new Set(extractToolNames(host.getAllTools()));
      if (registered.size > 0) {
        const safeMerged = merged.filter(tool => registered.has(tool));
        host.setActiveTools(safeMerged.length > 0 ? safeMerged : Array.from(registered));
        return;
      }
    }
    host.setActiveTools(merged);
  }
}

const workspaceStorePool = new Map<string, WorkspaceStateStore>();

export function getWorkspaceStore(cwd: string = process.cwd()): WorkspaceStateStore {
  const key = normalizeWorkspaceKey(cwd);
  let store = workspaceStorePool.get(key);
  if (!store) {
    store = new WorkspaceStateStore(cwd);
    workspaceStorePool.set(key, store);
  }
  return store;
}

export function clearAllWorkspaceStores(): void {
  for (const store of workspaceStorePool.values()) {
    store.clearMemory();
  }
  workspaceStorePool.clear();
}
