// src/extension/commands.ts
import * as fs11 from "fs";
import * as path12 from "path";
import { truncateToWidth as truncateToWidth2 } from "@earendil-works/pi-tui";

// src/core/messages.ts
var t = {
  analyzingTask: (task) => `Analyzing "${task}" and generating stage plan...`,
  cancelled: "Task execution cancelled.",
  noDecision: "No option selected. Exited.",
  resetSuccess: "[OK] Cleared active task state and caches.",
  exportNoBlueprint: "No active plan to export. Run `/toolflow <task>` first.",
  exportSuccess: (fileName) => `[OK] Exported blueprint to ${fileName}`,
  rollbackNothing: "No active blueprint or rollback point available.",
  rollbackSuccess: (stageNum, restoredCount, deletedCount) => `[OK] Rolled back to Stage ${stageNum} (restored ${restoredCount}, removed ${deletedCount} file(s)).`,
  promptInserted: (cmd) => `Inserted prompt ${cmd} into editor.`,
  blueprintStart: (stageCount, title) => `Plan ready (${stageCount} stages) -> Starting Stage 1: ${title}`,
  fastStart: (title) => `Fast track active -> ${title}`,
  allCompleted: (task) => `All stages completed for "${task}".`,
  stageVerified: (stageNum, artifact, shaPrefix) => `Stage ${stageNum} verified: ${artifact} (${shaPrefix})`,
  circuitBroken: (stageNum, artifact) => `Stage ${stageNum} paused after 3 remediation retries (${artifact}). Run \`/toolflow rollback\` or update manually.`,
  contextDehydrated: "Context compacted and stage logs archived.",
  noInteractiveUi: "Interactive UI unavailable. Use `/toolflow <task description>` directly.",
  helpBanner: "ToolFlow Commands:\n  /toolflow                 - Open interactive Prompt Workbench & Blueprint Navigator\n  /toolflow <task>          - Analyze task and run fast track or staged blueprint\n  /toolflow fast <task>     - Force lightweight single-stage execution\n  /toolflow status          - Show active blueprint stage and verification status\n  /toolflow dashboard       - Full dashboard: stage pipeline plus savings ledger\n  /toolflow stats           - Show token savings ledger (dehydration, cache, guards)\n  /toolflow rollback [n]    - Revert workspace changes to stage snapshot\n  /toolflow export          - Export current blueprint to TOOLFLOW_BLUEPRINT.md\n  /toolflow reset           - Clear active blueprint state and read caches",
  toolOutputDehydrated: (toolName, lines, savedTokens) => `[Dehydrated] ${toolName} (${lines} lines -> ~${savedTokens} tokens saved)`,
  readCacheHitNotice: (file, tokens) => `[Read Cache] ${file} unchanged, ~${tokens} tokens saved`,
  compactNotice: (tokensSaved) => tokensSaved ? `[ToolFlow] Stage history compacted (~${tokensSaved} tokens released)` : "[ToolFlow] Stage history compacted"
};

// src/core/workspace-store.ts
import * as fs2 from "fs";
import * as path2 from "path";
import * as crypto from "crypto";
import { execSync, execFileSync } from "child_process";

// src/core/atomic-fs.ts
import * as fs from "fs";
import * as path from "path";
var sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
function normalizeWorkspaceKey(cwd = process.cwd()) {
  const resolved = path.resolve(cwd || process.cwd());
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function isPathInsideWorkspace(targetPath, workspaceRoot = process.cwd()) {
  const normRoot = normalizeWorkspaceKey(workspaceRoot);
  const normTarget = normalizeWorkspaceKey(
    path.isAbsolute(targetPath) ? targetPath : path.resolve(workspaceRoot, targetPath)
  );
  return normTarget === normRoot || normTarget.startsWith(normRoot + path.sep);
}
function sleepSync(ms) {
  if (ms <= 0) return;
  try {
    Atomics.wait(sleepBuffer, 0, 0, Math.floor(ms));
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
    }
  }
}
function atomicWriteFileSync(filePath, content, options = {}) {
  const rand = Math.random().toString(36).slice(2, 8);
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${rand}`;
  let success = false;
  try {
    const parentDir = path.dirname(filePath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }
    fs.writeFileSync(tempPath, content, "utf-8");
    let renamed = false;
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        fs.renameSync(tempPath, filePath);
        renamed = true;
        break;
      } catch (err) {
        const code = err && typeof err === "object" && "code" in err && typeof err.code === "string" ? err.code : void 0;
        if ((code === "EBUSY" || code === "EPERM" || code === "EACCES") && attempt < 6) {
          sleepSync(Math.floor(attempt * 15 + Math.random() * 10));
          continue;
        }
        break;
      }
    }
    if (!renamed) {
      try {
        fs.copyFileSync(tempPath, filePath);
        renamed = true;
      } catch {
        renamed = false;
      }
    }
    if (renamed) {
      if (options.backup) {
        try {
          fs.copyFileSync(filePath, `${filePath}.bak`);
        } catch {
        }
      }
      success = true;
    }
  } catch {
    success = false;
  } finally {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
    }
  }
  return success;
}
function cleanupStaleTempFiles(dirPath, prefixes) {
  try {
    if (!fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath);
    for (const entry of entries) {
      if (prefixes.some((prefix) => entry.startsWith(prefix))) {
        try {
          fs.unlinkSync(path.join(dirPath, entry));
        } catch {
        }
      }
    }
  } catch {
  }
}

// src/core/workspace-store.ts
var BASELINE_TOOLS = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls"
];
function createEmptySessionState() {
  return {
    currentBlueprint: null,
    currentStageIndex: 0,
    stepByStepGate: true,
    status: "idle",
    artifactLedger: {},
    snapshots: {},
    dynamicTargetFiles: [],
    retryCount: 0
  };
}
function computeFileSha256(filePath) {
  try {
    const content = fs2.readFileSync(filePath);
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch {
    return "";
  }
}
var SNAPSHOT_CONTENT_LIMIT_BYTES = 512 * 1024;
function isBinaryBuffer(buffer) {
  const probe = buffer.subarray(0, 8192);
  return probe.includes(0);
}
function getGitChangedFiles(cwd = process.cwd()) {
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 2e3
    });
    const statusOutput = execSync("git status --porcelain", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 2e3
    });
    const changedFiles = [];
    const untrackedFiles = [];
    for (const rawLine of statusOutput.split(/\r?\n/)) {
      if (!rawLine || rawLine.length < 4) continue;
      const code = rawLine.slice(0, 2);
      const filePart = rawLine.slice(3).trim();
      const normalized = (filePart.includes(" -> ") ? filePart.split(" -> ").pop().trim() : filePart).replace(/\\/g, "/");
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
function extractToolNames(raw) {
  if (!Array.isArray(raw)) return [];
  const names = [];
  for (const item of raw) {
    if (typeof item === "string") {
      names.push(item);
    } else if (item && typeof item === "object" && "name" in item && typeof item.name === "string") {
      names.push(item.name);
    }
  }
  return names;
}
function cloneState(src) {
  return {
    ...src,
    artifactLedger: { ...src.artifactLedger },
    snapshots: src.snapshots ? { ...src.snapshots } : {},
    dynamicTargetFiles: src.dynamicTargetFiles ? [...src.dynamicTargetFiles] : [],
    changedFiles: src.changedFiles ? [...src.changedFiles] : [],
    customDirectives: src.customDirectives ? [...src.customDirectives] : void 0
  };
}
var SESSION_STATUSES = /* @__PURE__ */ new Set([
  "idle",
  "awaiting_user_decisions",
  "in_progress",
  "stage_completed",
  "completed",
  "paused",
  "healing_failed_circuit_break"
]);
function coerceStatus(value) {
  return typeof value === "string" && SESSION_STATUSES.has(value) ? value : "idle";
}
function hydrateStateFromJson(rawJson) {
  try {
    const parsed = JSON.parse(rawJson);
    if (!parsed || typeof parsed !== "object" || !("currentBlueprint" in parsed)) {
      return null;
    }
    const obj = parsed;
    if (!obj.currentBlueprint) return null;
    return {
      currentBlueprint: obj.currentBlueprint,
      currentStageIndex: typeof obj.currentStageIndex === "number" ? obj.currentStageIndex : 0,
      stepByStepGate: typeof obj.stepByStepGate === "boolean" ? obj.stepByStepGate : true,
      status: coerceStatus(obj.status),
      artifactLedger: obj.artifactLedger ?? {},
      snapshots: obj.snapshots ?? {},
      dynamicTargetFiles: Array.isArray(obj.dynamicTargetFiles) ? obj.dynamicTargetFiles : [],
      changedFiles: Array.isArray(obj.changedFiles) ? obj.changedFiles : [],
      retryCount: typeof obj.retryCount === "number" ? obj.retryCount : 0,
      shadowHeadCommit: obj.shadowHeadCommit,
      shadowCommitHash: obj.shadowCommitHash,
      customDirectives: Array.isArray(obj.customDirectives) ? obj.customDirectives : void 0
    };
  } catch {
    return null;
  }
}
var WorkspaceStateStore = class {
  cwd;
  state = createEmptySessionState();
  originalActiveToolsSnapshot = null;
  constructor(cwd = process.cwd()) {
    this.cwd = path2.resolve(cwd || process.cwd());
  }
  getPersistFilePath() {
    return path2.join(this.cwd, ".pi", "blueprint_state.json");
  }
  getState() {
    return cloneState(this.state);
  }
  updateState(mutator) {
    mutator(this.state);
    this.save();
  }
  setStatus(status) {
    this.state.status = status;
    this.save();
  }
  recordArtifact(artifactPath, record) {
    this.state.artifactLedger[artifactPath] = record;
    this.save();
  }
  incrementRetry() {
    this.state.retryCount = (this.state.retryCount ?? 0) + 1;
    if (this.state.retryCount >= 3) {
      this.state.status = "healing_failed_circuit_break";
    }
    this.save();
    return this.state.retryCount;
  }
  resetRetry() {
    this.state.retryCount = 0;
    this.save();
  }
  addCustomDirective(directive) {
    const trimmed = directive.trim();
    if (!trimmed) return;
    if (!this.state.customDirectives) this.state.customDirectives = [];
    if (!this.state.customDirectives.includes(trimmed)) {
      this.state.customDirectives.push(trimmed);
      this.save();
    }
  }
  save() {
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
  load() {
    const filePath = this.getPersistFilePath();
    const bakPath = `${filePath}.bak`;
    if (!fs2.existsSync(filePath) && !fs2.existsSync(bakPath)) {
      return null;
    }
    if (fs2.existsSync(filePath)) {
      try {
        const hydrated = hydrateStateFromJson(fs2.readFileSync(filePath, "utf-8"));
        if (hydrated) {
          this.state = hydrated;
          return this.getState();
        }
      } catch {
      }
    }
    if (fs2.existsSync(bakPath)) {
      try {
        const hydrated = hydrateStateFromJson(fs2.readFileSync(bakPath, "utf-8"));
        if (hydrated) {
          this.state = hydrated;
          return this.getState();
        }
      } catch {
      }
    }
    return null;
  }
  clearMemory() {
    this.state = createEmptySessionState();
  }
  reset() {
    this.clearMemory();
    const gitInfo = getGitChangedFiles(this.cwd);
    this.state.changedFiles = [...gitInfo.changedFiles, ...gitInfo.untrackedFiles];
    const filePath = this.getPersistFilePath();
    try {
      if (fs2.existsSync(filePath)) fs2.unlinkSync(filePath);
    } catch {
    }
    try {
      if (fs2.existsSync(`${filePath}.bak`)) fs2.unlinkSync(`${filePath}.bak`);
    } catch {
    }
    cleanupStaleTempFiles(path2.dirname(filePath), ["blueprint_state.json.tmp.", "stats.json.tmp."]);
  }
  scanChangedFiles() {
    const targets = [];
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
        /* @__PURE__ */ new Set([...gitInfo.changedFiles, ...gitInfo.untrackedFiles, ...targets])
      );
      this.state.changedFiles = merged;
      return merged;
    }
    const ignored = {
      node_modules: true,
      ".git": true,
      ".pi": true,
      dist: true,
      build: true,
      ".next": true,
      target: true
    };
    const files = [...targets];
    const walk = (dir, depth) => {
      if (depth > 3 || files.length >= 60) return;
      let entries;
      try {
        entries = fs2.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= 60) break;
        if (ignored[entry.name] || entry.name.startsWith(".")) continue;
        const full = path2.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.isFile()) {
          const rel = path2.relative(this.cwd, full).replace(/\\/g, "/");
          if (!files.includes(rel)) files.push(rel);
        }
      }
    };
    walk(this.cwd, 0);
    this.state.changedFiles = files;
    return files;
  }
  captureStageSnapshot(stageIndex, stageId, blueprint) {
    const fileHashes = {};
    const fileContents = {};
    const fileBinaries = {};
    const candidates = new Set(this.scanChangedFiles());
    for (const stage of blueprint.stages) {
      if (stage.expectedArtifact) candidates.add(stage.expectedArtifact);
      for (const art of stage.expectedArtifacts ?? []) {
        if (art) candidates.add(art);
      }
    }
    const resolvedCwd = path2.resolve(this.cwd);
    for (const relPath of candidates) {
      const fullPath = path2.resolve(resolvedCwd, relPath);
      if (fullPath !== resolvedCwd && !fullPath.startsWith(resolvedCwd + path2.sep)) continue;
      if (!fs2.existsSync(fullPath)) continue;
      try {
        const stat = fs2.statSync(fullPath);
        if (stat.isFile()) {
          fileHashes[relPath] = computeFileSha256(fullPath);
          if (stat.size <= SNAPSHOT_CONTENT_LIMIT_BYTES) {
            const buffer = fs2.readFileSync(fullPath);
            if (isBinaryBuffer(buffer)) {
              fileBinaries[relPath] = buffer.toString("base64");
            } else {
              fileContents[relPath] = buffer.toString("utf-8");
            }
          }
        }
      } catch {
      }
    }
    let gitTracked = false;
    let shadowCommitHash;
    let shadowRef;
    try {
      const gitInfo = getGitChangedFiles(this.cwd);
      if (gitInfo.isGit) {
        gitTracked = true;
        try {
          shadowCommitHash = execSync("git rev-parse HEAD", {
            cwd: this.cwd,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "ignore"],
            timeout: 2e3
          }).trim();
        } catch {
          shadowCommitHash = void 0;
        }
        try {
          const stashSha = execSync("git stash create", {
            cwd: this.cwd,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "ignore"],
            timeout: 4e3
          }).trim();
          if (stashSha) {
            shadowRef = `refs/toolflow-shadows/stage_${stageIndex}_${Date.now()}`;
            execSync(`git update-ref "${shadowRef}" ${stashSha}`, {
              cwd: this.cwd,
              stdio: "ignore",
              timeout: 2e3
            });
          }
        } catch {
        }
      }
    } catch {
      gitTracked = false;
    }
    const snapshot = {
      stageIndex,
      stageId,
      timestamp: Date.now(),
      fileHashes,
      fileContents,
      ...Object.keys(fileBinaries).length > 0 ? { fileBinaries } : {},
      changedFiles: Array.from(candidates),
      gitTracked,
      shadowCommitHash,
      shadowRef
    };
    if (!this.state.snapshots) this.state.snapshots = {};
    this.state.snapshots[stageIndex] = snapshot;
    this.save();
    return snapshot;
  }
  startBlueprintExecution(blueprint) {
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
  advanceStage() {
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
  /**
   * Replays the shadow tree into the working copy without touching the user's index.
   *
   * The previous implementation ran `git checkout <ref> -- .` followed by a bare
   * `git reset HEAD`, which unstaged every file the user had staged before the rollback.
   * `git restore --worktree` restores only the working copy; older gits fall back to
   * checkout with the reset narrowed to the snapshot's own paths.
   */
  restoreWorktreeFromShadow(ref) {
    const run = (args, timeout = 5e3) => {
      try {
        execFileSync("git", args, { cwd: this.cwd, stdio: "ignore", timeout });
        return true;
      } catch {
        return false;
      }
    };
    if (run(["restore", `--source=${ref}`, "--worktree", "--", "."])) return true;
    if (!run(["checkout", ref, "--", "."])) return false;
    let indexClean = true;
    try {
      execSync("git diff --cached --quiet", { cwd: this.cwd, stdio: "ignore", timeout: 3e3 });
    } catch {
      indexClean = false;
    }
    if (indexClean) {
      run(["reset", "HEAD"], 3e3);
    }
    return true;
  }
  rollbackStage(targetStageIndex) {
    if (!this.state.currentBlueprint || !this.state.snapshots) {
      return {
        success: false,
        rolledBackToStage: this.state.currentStageIndex,
        restoredFiles: [],
        deletedFiles: [],
        message: "No active blueprint or snapshot available for rollback."
      };
    }
    const rollbackIdx = targetStageIndex !== void 0 ? Math.max(0, Math.min(targetStageIndex, this.state.currentStageIndex)) : this.state.currentStageIndex;
    const snapshot = this.state.snapshots[rollbackIdx];
    if (!snapshot) {
      return {
        success: false,
        rolledBackToStage: this.state.currentStageIndex,
        restoredFiles: [],
        deletedFiles: [],
        message: `Snapshot for stage ${rollbackIdx + 1} was not found.`
      };
    }
    const restoredFiles = [];
    const deletedFiles = [];
    const resolvedCwd = path2.resolve(this.cwd);
    const shadowTarget = snapshot.shadowRef ?? snapshot.shadowCommitHash;
    if (shadowTarget) {
      this.restoreWorktreeFromShadow(shadowTarget);
    }
    for (const [relPath, content] of Object.entries(snapshot.fileContents ?? {})) {
      const fullPath = path2.resolve(resolvedCwd, relPath);
      if (fullPath !== resolvedCwd && !fullPath.startsWith(resolvedCwd + path2.sep)) continue;
      try {
        const dir = path2.dirname(fullPath);
        if (!fs2.existsSync(dir)) fs2.mkdirSync(dir, { recursive: true });
        fs2.writeFileSync(fullPath, content, "utf-8");
        restoredFiles.push(relPath);
      } catch {
      }
    }
    for (const [relPath, base64] of Object.entries(snapshot.fileBinaries ?? {})) {
      const fullPath = path2.resolve(resolvedCwd, relPath);
      if (fullPath !== resolvedCwd && !fullPath.startsWith(resolvedCwd + path2.sep)) continue;
      try {
        const dir = path2.dirname(fullPath);
        if (!fs2.existsSync(dir)) fs2.mkdirSync(dir, { recursive: true });
        fs2.writeFileSync(fullPath, Buffer.from(base64, "base64"));
        restoredFiles.push(relPath);
      } catch {
      }
    }
    for (let i = rollbackIdx; i < this.state.currentBlueprint.stages.length; i++) {
      const stage = this.state.currentBlueprint.stages[i];
      if (!stage) continue;
      const candidates = [stage.expectedArtifact, ...stage.expectedArtifacts ?? []].filter(
        (v) => Boolean(v)
      );
      for (const relPath of candidates) {
        if (snapshot.fileHashes[relPath] !== void 0) continue;
        const fullPath = path2.resolve(resolvedCwd, relPath);
        if (fullPath !== resolvedCwd && !fullPath.startsWith(resolvedCwd + path2.sep)) continue;
        if (fs2.existsSync(fullPath)) {
          try {
            fs2.unlinkSync(fullPath);
            deletedFiles.push(relPath);
          } catch {
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
      message: `Rolled back to Stage ${rollbackIdx + 1} (${snapshot.stageId}). Restored ${restoredFiles.length}, removed ${deletedFiles.length} file(s).`
    };
  }
  recordInitialActiveTools(host) {
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
  restoreInitialActiveTools(host) {
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
  computeStageTools(stageAllowedTools = []) {
    return Array.from(/* @__PURE__ */ new Set([...BASELINE_TOOLS, ...stageAllowedTools]));
  }
  applyToolScoping(allowedTools, host) {
    this.recordInitialActiveTools(host);
    const merged = this.computeStageTools(allowedTools);
    if (!host || typeof host.setActiveTools !== "function") return;
    if (typeof host.getAllTools === "function") {
      const registered = new Set(extractToolNames(host.getAllTools()));
      if (registered.size > 0) {
        const safeMerged = merged.filter((tool) => registered.has(tool));
        host.setActiveTools(safeMerged.length > 0 ? safeMerged : Array.from(registered));
        return;
      }
    }
    host.setActiveTools(merged);
  }
};
var workspaceStorePool = /* @__PURE__ */ new Map();
function getWorkspaceStore(cwd = process.cwd()) {
  const key = normalizeWorkspaceKey(cwd);
  let store = workspaceStorePool.get(key);
  if (!store) {
    store = new WorkspaceStateStore(cwd);
    workspaceStorePool.set(key, store);
  }
  return store;
}
function clearAllWorkspaceStores() {
  for (const store of workspaceStorePool.values()) {
    store.clearMemory();
  }
  workspaceStorePool.clear();
}

// src/optimizer/stats.ts
import * as fs3 from "fs";
import * as path3 from "path";
function emptyStats() {
  return {
    totalTokensSaved: 0,
    dehydratedLogsCount: 0,
    readCacheHitsCount: 0,
    blastRadiusBlocksCount: 0,
    lastUpdated: Date.now()
  };
}
var STATS_COMPACT_BYTES = 256 * 1024;
var StatsManager = class {
  statsFilePath;
  cached = null;
  constructor(cwd = process.cwd()) {
    this.statsFilePath = path3.join(cwd, ".pi", "toolflow", "stats.jsonl");
  }
  getStats() {
    try {
      const st = fs3.statSync(this.statsFilePath);
      if (this.cached && this.cached.size === st.size && this.cached.mtimeMs === st.mtimeMs) {
        return { ...this.cached.stats };
      }
      const raw = fs3.readFileSync(this.statsFilePath, "utf-8");
      const stats = this.aggregate(raw);
      this.cached = { size: st.size, mtimeMs: st.mtimeMs, stats };
      return { ...stats };
    } catch {
      return emptyStats();
    }
  }
  recordSavings(delta) {
    const entry = {
      t: delta.tokensSaved ?? 0,
      d: delta.dehydratedLogs ?? 0,
      r: delta.readCacheHits ?? 0,
      b: delta.blastRadiusBlocks ?? 0,
      ts: Date.now()
    };
    try {
      fs3.mkdirSync(path3.dirname(this.statsFilePath), { recursive: true });
      fs3.appendFileSync(this.statsFilePath, JSON.stringify(entry) + "\n", "utf-8");
      this.cached = null;
      this.compactIfNeeded();
    } catch {
    }
    return this.getStats();
  }
  getFormattedSavings() {
    const s = this.getStats();
    if (s.totalTokensSaved === 0 && s.dehydratedLogsCount === 0 && s.readCacheHitsCount === 0) {
      return "ToolFlow: 0 tokens saved yet";
    }
    const kSaved = s.totalTokensSaved >= 1e3 ? `${(s.totalTokensSaved / 1e3).toFixed(1)}k` : `${s.totalTokensSaved}`;
    return `ToolFlow Saved: ~${kSaved} tokens (${s.dehydratedLogsCount} dehydrated, ${s.readCacheHitsCount} cache hits)`;
  }
  /**
   * Delete the on-disk ledger and its compaction backup. `/toolflow reset` used to clear only
   * the in-memory pool, so the next getStatsManager() re-read the old counters and the card's
   * "Counters reset with /toolflow reset" promise was false.
   */
  resetLedger() {
    for (const file of [this.statsFilePath, `${this.statsFilePath}.bak`]) {
      try {
        fs3.rmSync(file, { force: true });
      } catch {
      }
    }
    this.cached = null;
  }
  /** Absolute path of the append-only JSONL ledger backing these counters. */
  getLedgerPath() {
    return this.statsFilePath;
  }
  /**
   * One-line status-bar fragment sized for the Pi footer and parsed by
   * pi-tui-status-beautifier (`~1.4k saved` / `N guarded`).
   * Zero-count counters are dropped so the badge stays short on narrow terminals.
   */
  getCompactBadge() {
    const s = this.getStats();
    const kSaved = s.totalTokensSaved >= 1e3 ? `${(s.totalTokensSaved / 1e3).toFixed(1)}k` : `${s.totalTokensSaved}`;
    const parts = [`~${kSaved} saved`];
    if (s.dehydratedLogsCount > 0) parts.push(`${s.dehydratedLogsCount} logs`);
    if (s.readCacheHitsCount > 0) parts.push(`${s.readCacheHitsCount} hits`);
    if (s.blastRadiusBlocksCount > 0) parts.push(`${s.blastRadiusBlocksCount} guarded`);
    return parts.join(" \xB7 ");
  }
  getSavingsSummary(baselineTokens = 25e3) {
    const stats = this.getStats();
    const denom = Math.max(1, baselineTokens + stats.totalTokensSaved);
    const ratio = Math.min(98, Math.round(stats.totalTokensSaved / denom * 100));
    return { stats, estimatedRatioPercent: ratio };
  }
  aggregate(raw) {
    const stats = emptyStats();
    stats.lastUpdated = 0;
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object") continue;
      if ("snap" in parsed && typeof parsed.snap === "number") {
        const snap = parsed;
        stats.totalTokensSaved = snap.snap;
        stats.dehydratedLogsCount = typeof snap.d === "number" ? snap.d : 0;
        stats.readCacheHitsCount = typeof snap.r === "number" ? snap.r : 0;
        stats.blastRadiusBlocksCount = typeof snap.b === "number" ? snap.b : 0;
        stats.lastUpdated = typeof snap.ts === "number" ? snap.ts : 0;
        continue;
      }
      const row = parsed;
      if (typeof row.t === "number") stats.totalTokensSaved += row.t;
      if (typeof row.d === "number") stats.dehydratedLogsCount += row.d;
      if (typeof row.r === "number") stats.readCacheHitsCount += row.r;
      if (typeof row.b === "number") stats.blastRadiusBlocksCount += row.b;
      if (typeof row.ts === "number" && row.ts > stats.lastUpdated) {
        stats.lastUpdated = row.ts;
      }
    }
    return stats;
  }
  compactIfNeeded() {
    try {
      const st = fs3.statSync(this.statsFilePath);
      if (st.size <= STATS_COMPACT_BYTES) return;
      const raw = fs3.readFileSync(this.statsFilePath, "utf-8");
      if (raw.trim() === "") return;
      const stats = this.aggregate(raw);
      const snapshot = {
        snap: stats.totalTokensSaved,
        d: stats.dehydratedLogsCount,
        r: stats.readCacheHitsCount,
        b: stats.blastRadiusBlocksCount,
        ts: stats.lastUpdated
      };
      atomicWriteFileSync(this.statsFilePath, JSON.stringify(snapshot) + "\n");
      this.cached = null;
    } catch {
    }
  }
};
var statsPool = /* @__PURE__ */ new Map();
function getStatsManager(cwd = process.cwd()) {
  const key = normalizeWorkspaceKey(cwd);
  let instance = statsPool.get(key);
  if (!instance) {
    instance = new StatsManager(cwd);
    statsPool.set(key, instance);
  }
  return instance;
}
function clearAllStatsManagers() {
  statsPool.clear();
}

// src/optimizer/read-cache.ts
import * as fs4 from "fs";
import * as path4 from "path";
import * as crypto2 from "crypto";
var TS_JS_DECL_REGEX = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|enum)\s+([a-zA-Z0-9_$]+)/;
var PYTHON_DECL_REGEX = /^\s*(?:async\s+)?(?:def|class)\s+([a-zA-Z0-9_]+)/;
var RUST_GO_DECL_REGEX = /^\s*(?:pub\s+)?(?:async\s+)?(?:fn|struct|enum|impl|trait|func|type)\s+([a-zA-Z0-9_]+)/;
function extractSymbolOutline(fileContent, maxItems = 12) {
  if (!fileContent || typeof fileContent !== "string") return [];
  const lines = fileContent.split(/\r?\n/);
  const outline = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (TS_JS_DECL_REGEX.test(line) || PYTHON_DECL_REGEX.test(line) || RUST_GO_DECL_REGEX.test(line)) {
      const compact = line.trim().replace(/\s*\{.*$/, "").slice(0, 56);
      outline.push(`L${i + 1}: ${compact}`);
      if (outline.length >= maxItems) break;
    }
  }
  return outline;
}
var ReadCacheManager = class {
  cwd;
  cache = /* @__PURE__ */ new Map();
  recentEditFailurePaths = /* @__PURE__ */ new Set();
  isWorkspaceDirtyByCommand = false;
  minLineThreshold = 30;
  constructor(cwd = process.cwd()) {
    this.cwd = path4.resolve(cwd);
  }
  resolveTarget(targetPath) {
    return path4.isAbsolute(targetPath) ? path4.resolve(targetPath) : path4.resolve(this.cwd, targetPath);
  }
  computeHashAndStats(fullPath) {
    try {
      if (!fs4.existsSync(fullPath)) return null;
      const stat = fs4.statSync(fullPath);
      if (!stat.isFile()) return null;
      const content = fs4.readFileSync(fullPath, "utf-8");
      const hash = crypto2.createHash("sha256").update(content).digest("hex");
      const lines = content.split(/\r?\n/).length;
      const tokens = Math.round(content.length / 4);
      const symbolOutline = extractSymbolOutline(content);
      return { hash, mtimeMs: stat.mtimeMs, size: stat.size, lines, tokens, symbolOutline };
    } catch {
      return null;
    }
  }
  recordRead(input) {
    if (!input || !input.path) return;
    if (input.offset !== void 0 || input.limit !== void 0) return;
    const fullPath = this.resolveTarget(input.path);
    const info = this.computeHashAndStats(fullPath);
    if (!info) return;
    this.cache.set(fullPath, {
      hash: info.hash,
      mtimeMs: info.mtimeMs,
      size: info.size,
      lines: info.lines,
      estimatedTokens: info.tokens,
      symbolOutline: info.symbolOutline,
      lastReadAt: Date.now()
    });
    this.recentEditFailurePaths.delete(fullPath);
    this.isWorkspaceDirtyByCommand = false;
  }
  markFileDirty(targetPath) {
    if (!targetPath) return;
    const fullPath = this.resolveTarget(targetPath);
    this.cache.delete(fullPath);
  }
  markEditFailure(targetPath) {
    if (!targetPath) return;
    const fullPath = this.resolveTarget(targetPath);
    this.recentEditFailurePaths.add(fullPath);
    this.cache.delete(fullPath);
  }
  markWorkspaceDirtyByCommand() {
    this.isWorkspaceDirtyByCommand = true;
  }
  checkRead(input, autoRecord = true) {
    if (!input || !input.path) return { isDuplicate: false, bypassReason: "not_cached" };
    if (input.offset !== void 0 || input.limit !== void 0) {
      return { isDuplicate: false, bypassReason: "targeted_window" };
    }
    const fullPath = this.resolveTarget(input.path);
    if (this.recentEditFailurePaths.has(fullPath)) {
      this.recentEditFailurePaths.delete(fullPath);
      if (autoRecord) this.recordRead(input);
      return { isDuplicate: false, bypassReason: "recent_edit_failure" };
    }
    if (this.isWorkspaceDirtyByCommand) {
      this.isWorkspaceDirtyByCommand = false;
      this.cache.clear();
      if (autoRecord) this.recordRead(input);
      return { isDuplicate: false, bypassReason: "command_dirty" };
    }
    const cached = this.cache.get(fullPath);
    if (!cached) {
      if (autoRecord) this.recordRead(input);
      return { isDuplicate: false, bypassReason: "not_cached" };
    }
    if (cached.lines < this.minLineThreshold) {
      return { isDuplicate: false, bypassReason: "small_file" };
    }
    try {
      if (!fs4.existsSync(fullPath)) {
        this.cache.delete(fullPath);
        return { isDuplicate: false, bypassReason: "not_cached" };
      }
      const stat = fs4.statSync(fullPath);
      if (stat.mtimeMs === cached.mtimeMs && stat.size === cached.size) {
        return this.formatCacheHit(input.path, cached);
      }
      const info = this.computeHashAndStats(fullPath);
      if (!info) {
        this.cache.delete(fullPath);
        return { isDuplicate: false, bypassReason: "not_cached" };
      }
      if (info.hash === cached.hash) {
        cached.mtimeMs = info.mtimeMs;
        cached.lastReadAt = Date.now();
        return this.formatCacheHit(input.path, cached);
      }
      this.cache.set(fullPath, {
        hash: info.hash,
        mtimeMs: info.mtimeMs,
        size: info.size,
        lines: info.lines,
        estimatedTokens: info.tokens,
        symbolOutline: info.symbolOutline,
        lastReadAt: Date.now()
      });
      return { isDuplicate: false, bypassReason: "not_cached" };
    } catch {
      return { isDuplicate: false, bypassReason: "not_cached" };
    }
  }
  formatCacheHit(displayPath, cached) {
    const savedTokens = Math.max(0, cached.estimatedTokens - 45);
    if (savedTokens > 0) {
      getStatsManager(this.cwd).recordSavings({
        tokensSaved: savedTokens,
        readCacheHits: 1
      });
    }
    const outlineBlock = cached.symbolOutline.length > 0 ? `
Symbol outline (use offset/limit for targeted slices):
  ${cached.symbolOutline.join(" | ")}` : "";
    const notice = `[ToolFlow Read Cache Hit] "${displayPath}" is unchanged since your last full read (${cached.lines} lines, SHA-256: ${cached.hash.slice(0, 8)}; saved ~${savedTokens} tokens). Reuse existing context or pass \`offset\` + \`limit\` to inspect a specific slice.${outlineBlock}`;
    return {
      isDuplicate: true,
      notice,
      savedLines: cached.lines,
      savedTokens
    };
  }
  clear() {
    this.cache.clear();
    this.recentEditFailurePaths.clear();
    this.isWorkspaceDirtyByCommand = false;
  }
  getCachedCount() {
    return this.cache.size;
  }
};
var readCachePool = /* @__PURE__ */ new Map();
function getReadCache(cwd = process.cwd()) {
  const key = normalizeWorkspaceKey(cwd);
  let instance = readCachePool.get(key);
  if (!instance) {
    instance = new ReadCacheManager(cwd);
    readCachePool.set(key, instance);
  }
  return instance;
}
function clearAllReadCaches() {
  for (const cache of readCachePool.values()) {
    cache.clear();
  }
  readCachePool.clear();
}

// src/optimizer/dehydrator.ts
import * as fs5 from "fs";
import * as path5 from "path";
import * as crypto3 from "crypto";
var MAX_RUNS_DISK_QUOTA_BYTES = 50 * 1024 * 1024;
var MAX_LINE_THRESHOLD = 40;
var MAX_BYTE_THRESHOLD = 4096;
var logSeqCounter = 0;
var ContextDehydrator = class _ContextDehydrator {
  cwd;
  runsBaseDir;
  lastFailedCommandHash = "";
  consecutiveIdenticalFailures = 0;
  static latestLogPaths = /* @__PURE__ */ new Map();
  constructor(cwd = process.cwd()) {
    this.cwd = path5.resolve(cwd);
    this.runsBaseDir = path5.join(this.cwd, ".pi", "toolflow", "runs");
  }
  static workspaceKey(cwd) {
    return normalizeWorkspaceKey(cwd);
  }
  static getLatestLogPath(cwd) {
    if (cwd) {
      return _ContextDehydrator.latestLogPaths.get(_ContextDehydrator.workspaceKey(cwd)) ?? null;
    }
    let last = null;
    for (const value of _ContextDehydrator.latestLogPaths.values()) last = value;
    return last;
  }
  static setLatestLogPath(filePath, cwd = process.cwd()) {
    _ContextDehydrator.latestLogPaths.set(_ContextDehydrator.workspaceKey(cwd), filePath);
  }
  static clearLatestLogPaths() {
    _ContextDehydrator.latestLogPaths.clear();
  }
  /**
   * Newest run log is never evicted: `toolflow_inspect` reads it back, so deleting it under
   * quota pressure left the tool with nothing to show. (The old `setProtectedPaths` pool had
   * no caller and only ever compared paths outside the runs directory, so it was inert.)
   */
  protectedRunFiles() {
    const key = _ContextDehydrator.workspaceKey(this.cwd);
    const latest = _ContextDehydrator.latestLogPaths.get(key);
    return latest ? /* @__PURE__ */ new Set([path5.resolve(this.cwd, latest)]) : /* @__PURE__ */ new Set();
  }
  pruneOldRuns(maxAgeHours = 24, maxTotalBytes = MAX_RUNS_DISK_QUOTA_BYTES) {
    let deletedCount = 0;
    try {
      if (!fs5.existsSync(this.runsBaseDir)) return 0;
      const cutoffMs = Date.now() - maxAgeHours * 60 * 60 * 1e3;
      const allFiles = [];
      const protectedSet = this.protectedRunFiles();
      const walk = (dir) => {
        for (const entry of fs5.readdirSync(dir, { withFileTypes: true })) {
          const full = path5.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
          } else if (entry.isFile()) {
            try {
              const stat = fs5.statSync(full);
              allFiles.push({ path: full, mtimeMs: stat.mtimeMs, size: stat.size });
            } catch {
            }
          }
        }
      };
      walk(this.runsBaseDir);
      allFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);
      let currentTotal = allFiles.reduce((acc, f) => acc + f.size, 0);
      for (const file of allFiles) {
        const isProtected = protectedSet.has(path5.resolve(file.path));
        const expired = file.mtimeMs < cutoffMs;
        const overQuota = currentTotal > maxTotalBytes;
        if (!isProtected && (expired || overQuota)) {
          try {
            fs5.unlinkSync(file.path);
            currentTotal -= file.size;
            deletedCount++;
          } catch {
          }
        }
      }
      for (const entry of fs5.readdirSync(this.runsBaseDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const stageDir = path5.join(this.runsBaseDir, entry.name);
        try {
          if (fs5.readdirSync(stageDir).length === 0) {
            fs5.rmdirSync(stageDir);
          }
        } catch {
        }
      }
    } catch {
    }
    return deletedCount;
  }
  extractTopologyHints(stageText) {
    const importedFiles = /* @__PURE__ */ new Set();
    const exportedSymbols = /* @__PURE__ */ new Set();
    const importRegex = /(?:import|from|require\()\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(stageText)) !== null) {
      if (match[1]) importedFiles.add(match[1]);
      if (importedFiles.size >= 15) break;
    }
    const exportRegex = /export\s+(?:async\s+)?(?:function|class|const|interface|type|enum)\s+([a-zA-Z0-9_]+)/g;
    while ((match = exportRegex.exec(stageText)) !== null) {
      if (match[1]) exportedSymbols.add(match[1]);
      if (exportedSymbols.size >= 20) break;
    }
    return {
      importedFiles: Array.from(importedFiles),
      exportedSymbols: Array.from(exportedSymbols)
    };
  }
  extractSemanticErrors(lines, isError) {
    if (!isError && lines.length === 0) return [];
    const highlights = [];
    const seen = /* @__PURE__ */ new Set();
    const errorMatchers = [
      /\berror\s+TS\d+:/i,
      /\bTypeError:|ReferenceError:|SyntaxError:|RangeError:|AssertionError/i,
      /\bERR![^\n]+/,
      /\berror\[E\d+\]:/i,
      /\bpanicked at\b/i,
      /\bTraceback \(most recent call last\):/i,
      /\b[A-Za-z]+Error:\s+.+/,
      /\bFAIL\s+[^\s]+/,
      /\bAssertionFailed|Expected.*to equal/i,
      /\.go:\d+:\d+:/,
      /\bat\s+[^\n]+\([^)]+:\d+:\d+\)/,
      /^\s*-->\s+[^:]+:\d+:\d+/
    ];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line.length > 500) continue;
      if (errorMatchers.some((rx) => rx.test(line))) {
        const trimmed = line.trim();
        if (!seen.has(trimmed)) {
          seen.add(trimmed);
          highlights.push(trimmed);
          const nextLine = lines[i + 1]?.trim();
          if (nextLine && nextLine.length < 240 && !seen.has(nextLine)) {
            if (/^(\^|~+|\s*\||at\s+|Expected|Received)/.test(nextLine)) {
              seen.add(nextLine);
              highlights.push(`  ${nextLine}`);
            }
          }
        }
      }
      if (highlights.length >= 16) break;
    }
    return highlights;
  }
  getFailureStreak() {
    return {
      lastFailureHash: this.lastFailedCommandHash,
      consecutiveIdenticalFailures: this.consecutiveIdenticalFailures
    };
  }
  dehydrateToolOutput(toolName, rawText, isError = false, stageId = "default") {
    const safeText = typeof rawText === "string" ? rawText : String(rawText ?? "");
    const lines = safeText.split(/\r?\n/);
    const originalLines = lines.length;
    const originalBytes = Buffer.byteLength(safeText, "utf-8");
    let loopBusterTriggered = false;
    if (isError) {
      const errorSignature = safeText.slice(0, 600).replace(/\d{10,}/g, "<TS>");
      const errHash = crypto3.createHash("md5").update(`${toolName}:${errorSignature}`).digest("hex");
      if (errHash === this.lastFailedCommandHash) {
        this.consecutiveIdenticalFailures++;
        if (this.consecutiveIdenticalFailures >= 2) {
          loopBusterTriggered = true;
        }
      } else {
        this.lastFailedCommandHash = errHash;
        this.consecutiveIdenticalFailures = 1;
      }
    } else {
      this.lastFailedCommandHash = "";
      this.consecutiveIdenticalFailures = 0;
    }
    if (originalLines <= MAX_LINE_THRESHOLD && originalBytes <= MAX_BYTE_THRESHOLD) {
      if (loopBusterTriggered) {
        const loopWarning = `[ToolFlow Loop Buster] Tool "${toolName}" failed identically ${this.consecutiveIdenticalFailures} times in a row. Stop repeating the same call. Inspect the root cause or switch strategy.

${safeText}`;
        return {
          dehydrated: true,
          text: loopWarning,
          originalLines,
          originalBytes,
          tokensSaved: 0,
          loopBusterTriggered: true
        };
      }
      return {
        dehydrated: false,
        text: safeText,
        originalLines,
        originalBytes,
        tokensSaved: 0,
        loopBusterTriggered: false
      };
    }
    const safeStageId = stageId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const stageDir = path5.join(this.runsBaseDir, safeStageId);
    const logFileName = `tool_${toolName.replace(/[^a-zA-Z0-9_-]/g, "_")}_${Date.now()}_${++logSeqCounter}.log`;
    const logFilePath = path5.join(stageDir, logFileName);
    const relLogPath = path5.relative(this.cwd, logFilePath).replace(/\\/g, "/");
    try {
      fs5.mkdirSync(stageDir, { recursive: true });
      fs5.writeFileSync(logFilePath, safeText, "utf-8");
      _ContextDehydrator.setLatestLogPath(relLogPath, this.cwd);
      this.pruneOldRuns(24, MAX_RUNS_DISK_QUOTA_BYTES);
    } catch {
      return {
        dehydrated: false,
        text: safeText,
        originalLines,
        originalBytes,
        tokensSaved: 0
      };
    }
    const semanticErrors = this.extractSemanticErrors(lines, isError);
    const headCount = Math.min(8, Math.floor(originalLines / 2));
    const tailCount = isError ? 24 : 14;
    const headSnippet = lines.slice(0, headCount).join("\n");
    const tailSnippet = lines.slice(Math.max(headCount, originalLines - tailCount)).join("\n");
    const sections = [];
    if (loopBusterTriggered) {
      sections.push(
        `[ToolFlow Loop Buster] "${toolName}" failed identically ${this.consecutiveIdenticalFailures} consecutive times. Stop retrying the exact command; inspect "${relLogPath}" or change approach.`
      );
    }
    if (semanticErrors.length > 0) {
      sections.push(
        `--- [Semantic Error Peak (${semanticErrors.length} frames)] ---
${semanticErrors.join("\n")}`
      );
    }
    sections.push(`--- [Head (${headCount} lines)] ---
${headSnippet}`);
    sections.push(`--- [Tail (${Math.min(tailCount, originalLines)} lines)] ---
${tailSnippet}`);
    const summaryText = `[ToolFlow Dehydrated Output | ${toolName}]
Full output (${originalLines} lines, ${(originalBytes / 1024).toFixed(1)} KB) saved to: ${relLogPath}
Use \`toolflow_inspect(mode="grep", pattern="...")\` or \`read(path="${relLogPath}", offset=..., limit=...)\` to inspect details.

` + sections.join("\n\n");
    const tokensSaved = Math.max(0, Math.round((safeText.length - summaryText.length) / 4));
    getStatsManager(this.cwd).recordSavings({
      tokensSaved,
      dehydratedLogs: 1
    });
    return {
      dehydrated: true,
      text: summaryText,
      logFilePath: relLogPath,
      originalLines,
      originalBytes,
      tokensSaved,
      loopBusterTriggered
    };
  }
  dehydrateStageLog(params) {
    const safeStageId = params.stageId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const stageDir = path5.join(this.runsBaseDir, safeStageId);
    const logFileName = `stage_run_${Date.now()}_${++logSeqCounter}.log`;
    const logFilePath = path5.join(stageDir, logFileName);
    const relLogPath = path5.relative(this.cwd, logFilePath).replace(/\\/g, "/");
    try {
      fs5.mkdirSync(stageDir, { recursive: true });
      fs5.writeFileSync(logFilePath, params.rawStageOutput, "utf-8");
      _ContextDehydrator.setLatestLogPath(relLogPath, this.cwd);
      this.pruneOldRuns(24, MAX_RUNS_DISK_QUOTA_BYTES);
    } catch {
    }
    const rawBytes = Buffer.byteLength(params.rawStageOutput || "", "utf-8");
    const compactText = `Stage ${params.stageTitle} completed. Contract: ${params.contractSummary}. Artifacts: ${params.verifiedArtifacts.map((a) => a.path).join(", ")}`;
    const compactBytes = Buffer.byteLength(compactText, "utf-8");
    const ratio = rawBytes > 0 ? `${Math.max(0, Math.round((1 - compactBytes / rawBytes) * 100))}%` : "0%";
    const topologyHints = this.extractTopologyHints(params.rawStageOutput || "");
    return {
      stageId: params.stageId,
      stageTitle: params.stageTitle,
      verifiedArtifacts: params.verifiedArtifacts,
      contractSummary: params.contractSummary,
      rawLogFilePath: relLogPath,
      tokenSavingsRatio: ratio,
      timestamp: Date.now(),
      topologyHints
    };
  }
};
var dehydratorPool = /* @__PURE__ */ new Map();
function getDehydrator(cwd = process.cwd()) {
  const key = normalizeWorkspaceKey(cwd);
  let instance = dehydratorPool.get(key);
  if (!instance) {
    instance = new ContextDehydrator(cwd);
    dehydratorPool.set(key, instance);
  }
  return instance;
}
function clearAllDehydrators() {
  dehydratorPool.clear();
  ContextDehydrator.clearLatestLogPaths();
}

// src/planner/taxonomy.ts
import * as fs6 from "fs";
import * as path7 from "path";
import * as crypto4 from "crypto";

// src/core/agent-dir.ts
import * as os from "os";
import * as path6 from "path";
function getPiAgentDir() {
  return process.env.PI_CODING_AGENT_DIR || process.env.PI_CONFIG_DIR || process.env.PI_AGENT_DIR || path6.join(os.homedir(), ".pi", "agent");
}
function hasExplicitAgentDir() {
  return Boolean(
    process.env.PI_CODING_AGENT_DIR || process.env.PI_CONFIG_DIR || process.env.PI_AGENT_DIR
  );
}

// src/core/json-extract.ts
function extractValidJsonObject(raw) {
  if (!raw || typeof raw !== "string") {
    throw new Error("Invalid raw text for JSON extraction");
  }
  const codeBlockMatch = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
    }
  }
  const firstBrace = raw.indexOf("{");
  if (firstBrace === -1) {
    throw new Error("No JSON object found in text");
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = firstBrace; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const parsed = JSON.parse(raw.slice(firstBrace, i + 1));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed;
        }
        throw new Error("Extracted JSON root is not an object");
      }
    }
  }
  throw new Error("Unbalanced braces in JSON text");
}

// src/planner/llm-client.ts
function extractTextFromResult(result) {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  if ("text" in result && typeof result.text === "string") return result.text;
  if ("content" in result && Array.isArray(result.content)) {
    const parts = [];
    for (const item of result.content) {
      if (item && typeof item === "object" && "type" in item && "text" in item) {
        const block = item;
        if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
      }
    }
    return parts.join("\n");
  }
  return "";
}
async function callExtensionLlm(ctx, systemPrompt, userPrompt, maxTokens = 1e3, timeoutMs = 15e3) {
  if (!ctx?.model) return null;
  if (typeof ctx.complete === "function") {
    try {
      const response = await ctx.complete(ctx.model, `${systemPrompt}

${userPrompt}`, { maxTokens });
      const text = extractTextFromResult(response).trim();
      return text || null;
    } catch {
      return null;
    }
  }
  const streamSimple = ctx.modelRegistry?.streamSimple;
  if (typeof streamSimple !== "function") return null;
  let timer;
  const controller = new AbortController();
  try {
    const stream = streamSimple.call(
      ctx.modelRegistry,
      ctx.model,
      {
        systemPrompt,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userPrompt }],
            timestamp: Date.now()
          }
        ]
      },
      { maxTokens: Math.max(maxTokens, 2e3), reasoning: "minimal", signal: controller.signal }
    );
    const runStream = async () => {
      if (stream && typeof stream.result === "function") {
        const finalMsg = await stream.result();
        const extracted = extractTextFromResult(finalMsg).trim();
        if (extracted) return extracted;
      }
      let buffer = "";
      if (stream && typeof stream[Symbol.asyncIterator] === "function") {
        for await (const ev of stream) {
          if (ev && typeof ev === "object" && "type" in ev && ev.type === "text_delta" && "delta" in ev && typeof ev.delta === "string") {
            buffer += ev.delta;
          }
        }
      }
      return buffer.trim() || null;
    };
    const timeout = Promise.withResolvers();
    timer = setTimeout(() => {
      controller.abort();
      try {
        stream?.abort?.();
      } catch {
      }
      timeout.resolve(null);
    }, timeoutMs);
    return await Promise.race([runStream(), timeout.promise]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// src/planner/taxonomy.ts
function isTestEnvironment() {
  return Boolean(process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === "test" || process.env.VITEST);
}
function getRuntimeTaxonomyCachePath() {
  return path7.join(getPiAgentDir(), "toolflow-taxonomy.json");
}
function cleanName(rawName) {
  let clean = rawName;
  if (clean.includes("/") || clean.includes("\\")) {
    const parts = clean.split(/[\\/]/);
    clean = parts[parts.length - 1] || clean;
  }
  clean = clean.replace(/^pi-/, "");
  clean = clean.replace(/\.ts$|\.js$|\.md$/, "");
  return clean;
}
function generateCapabilityCompactDigest(item) {
  const cName = item.cleanName || cleanName(item.name || item.id || "item");
  const layerTag = item.layer ? item.layer.split("_")[0] : "L1";
  const desc = (item.description || "").trim();
  const shortDesc = desc.length > 42 ? desc.slice(0, 39) + "..." : desc;
  return shortDesc ? `[${layerTag}] ${cName}: ${shortDesc}` : `[${layerTag}] ${cName}`;
}
function sniffProjectFingerprint(cwd = process.cwd()) {
  let projectType = "unknown";
  let packageManager = "unknown";
  let mainFramework;
  let sourceDir = "src";
  let testDir = "tests";
  const keyConfigFiles = [];
  const checkFile = (rel) => {
    const exists = fs6.existsSync(path7.join(cwd, rel));
    if (exists && !keyConfigFiles.includes(rel)) keyConfigFiles.push(rel);
    return exists;
  };
  if (checkFile("package.json")) {
    projectType = "node";
    if (fs6.existsSync(path7.join(cwd, "pnpm-lock.yaml"))) packageManager = "pnpm";
    else if (fs6.existsSync(path7.join(cwd, "yarn.lock"))) packageManager = "yarn";
    else if (fs6.existsSync(path7.join(cwd, "bun.lockb")) || fs6.existsSync(path7.join(cwd, "bun.lock"))) packageManager = "bun";
    else packageManager = "npm";
    try {
      const parsed = JSON.parse(fs6.readFileSync(path7.join(cwd, "package.json"), "utf-8"));
      if (parsed && typeof parsed === "object") {
        const pkg = parsed;
        const allDeps = { ...pkg.dependencies ?? {}, ...pkg.devDependencies ?? {} };
        if (allDeps.next) {
          mainFramework = "Next.js";
          projectType = "web";
        } else if (allDeps.nuxt) {
          mainFramework = "Nuxt";
          projectType = "web";
        } else if (allDeps.react) {
          mainFramework = "React";
          projectType = "web";
        } else if (allDeps.vue) {
          mainFramework = "Vue";
          projectType = "web";
        } else if (allDeps.svelte) {
          mainFramework = "Svelte";
          projectType = "web";
        } else if (allDeps.express || allDeps.fastify || allDeps.hono || allDeps.koa) {
          mainFramework = allDeps.hono ? "Hono" : allDeps.fastify ? "Fastify" : "Express";
        } else if (allDeps.electron) {
          mainFramework = "Electron";
        }
      }
    } catch {
    }
  }
  if (checkFile("Cargo.toml")) {
    projectType = "rust";
    packageManager = "cargo";
    mainFramework = "Cargo";
    testDir = "tests";
    try {
      const cargo = fs6.readFileSync(path7.join(cwd, "Cargo.toml"), "utf-8");
      if (cargo.includes("axum")) mainFramework = "Axum";
      else if (cargo.includes("actix-web")) mainFramework = "Actix-Web";
      else if (cargo.includes("tokio")) mainFramework = "Tokio";
    } catch {
    }
  }
  if (checkFile("pyproject.toml") || checkFile("requirements.txt") || checkFile("setup.py")) {
    if (projectType === "unknown") projectType = "python";
    if (checkFile("uv.lock")) packageManager = "uv";
    else if (checkFile("poetry.lock")) packageManager = "poetry";
    else if (packageManager === "unknown") packageManager = "pip";
    try {
      const pyText = fs6.existsSync(path7.join(cwd, "pyproject.toml")) ? fs6.readFileSync(path7.join(cwd, "pyproject.toml"), "utf-8") : fs6.existsSync(path7.join(cwd, "requirements.txt")) ? fs6.readFileSync(path7.join(cwd, "requirements.txt"), "utf-8") : "";
      if (pyText.includes("fastapi")) mainFramework = "FastAPI";
      else if (pyText.includes("django")) mainFramework = "Django";
      else if (pyText.includes("flask")) mainFramework = "Flask";
      else if (pyText.includes("pytest")) mainFramework = "Pytest";
    } catch {
    }
  }
  if (checkFile("go.mod")) {
    if (projectType === "unknown") projectType = "go";
    if (packageManager === "unknown") packageManager = "go";
    sourceDir = ".";
    testDir = ".";
    try {
      const goMod = fs6.readFileSync(path7.join(cwd, "go.mod"), "utf-8");
      if (goMod.includes("gin-gonic/gin")) mainFramework = "Gin";
      else if (goMod.includes("gofiber/fiber")) mainFramework = "Fiber";
    } catch {
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
    if (fs6.existsSync(path7.join(cwd, "index.html"))) {
      projectType = "web";
      mainFramework = "Vanilla HTML/JS";
    } else if (fs6.existsSync(path7.join(cwd, "src"))) {
      projectType = "node";
    }
  }
  if (fs6.existsSync(path7.join(cwd, "test"))) testDir = "test";
  else if (fs6.existsSync(path7.join(cwd, "__tests__"))) testDir = "__tests__";
  if (!fs6.existsSync(path7.join(cwd, sourceDir)) && fs6.existsSync(path7.join(cwd, "app"))) {
    sourceDir = "app";
  }
  const gitInfo = getGitChangedFiles(cwd);
  const changedModules = [];
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
    keyConfigFiles
  };
}
function classifyByHeuristic(name, description, type) {
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
function scanMarkdownItems(dirs, type, target, seenNames) {
  for (const dir of dirs) {
    if (!fs6.existsSync(dir)) continue;
    try {
      const entries = fs6.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        let mdPath = null;
        if (entry.isDirectory()) {
          const nested = path7.join(dir, entry.name, type === "skill" ? "SKILL.md" : "PROMPT.md");
          if (fs6.existsSync(nested)) mdPath = nested;
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          mdPath = path7.join(dir, entry.name);
        }
        if (!mdPath) continue;
        const baseName = entry.name.replace(/\.md$/, "");
        if (seenNames.has(baseName)) continue;
        seenNames.add(baseName);
        let desc = `${type === "skill" ? "Skill" : "Prompt"} module: ${baseName}`;
        try {
          const content = fs6.readFileSync(mdPath, "utf-8");
          const descMatch = content.match(/description:\s*(.+)/i);
          if (descMatch && descMatch[1]) {
            desc = descMatch[1].trim().replace(/^["']|["']$/g, "");
          } else {
            const heading = content.split("\n").find((l) => l.trim().startsWith("#"));
            if (heading) desc = heading.replace(/^#+\s*/, "").trim();
          }
        } catch {
        }
        const cName = cleanName(baseName);
        const { layer, reason } = classifyByHeuristic(cName, desc, type);
        const item = {
          id: `${type}_${cName}`,
          name: baseName,
          cleanName: cName,
          type,
          layer,
          layerReason: reason,
          description: desc,
          compactDigest: "",
          filePath: mdPath
        };
        item.compactDigest = generateCapabilityCompactDigest(item);
        target.push(item);
      }
    } catch {
    }
  }
}
function discoverEcosystemTaxonomy(cwd = process.cwd(), runtimeTools = []) {
  const agentDir = isTestEnvironment() && !hasExplicitAgentDir() ? "" : getPiAgentDir();
  const agentPaths = (...segments) => agentDir ? [path7.join(agentDir, ...segments)] : [];
  const extensions = [];
  const skills = [];
  const prompts = [];
  const tools = [];
  const extSeen = /* @__PURE__ */ new Set();
  const settingsPath = agentDir ? path7.join(agentDir, "settings.json") : "";
  if (settingsPath && fs6.existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(fs6.readFileSync(settingsPath, "utf-8"));
      if (parsed && typeof parsed === "object" && "packages" in parsed && Array.isArray(parsed.packages)) {
        for (const pkg of parsed.packages) {
          const pkgName = typeof pkg === "string" ? pkg : pkg && typeof pkg === "object" && "name" in pkg && typeof pkg.name === "string" ? pkg.name : "";
          if (!pkgName) continue;
          const cName = cleanName(pkgName.replace(/^npm:/, ""));
          if (extSeen.has(cName)) continue;
          extSeen.add(cName);
          const { layer, reason } = classifyByHeuristic(cName, pkgName, "extension");
          const item = {
            id: `ext_${cName}`,
            name: pkgName,
            cleanName: cName,
            type: "extension",
            layer,
            layerReason: reason,
            description: `Pi extension package (${cName})`,
            compactDigest: ""
          };
          item.compactDigest = generateCapabilityCompactDigest(item);
          extensions.push(item);
        }
      }
    } catch {
    }
  }
  scanMarkdownItems(
    [path7.join(cwd, ".pi", "skills"), ...agentPaths("skills")],
    "skill",
    skills,
    /* @__PURE__ */ new Set()
  );
  scanMarkdownItems(
    [path7.join(cwd, ".pi", "prompts"), ...agentPaths("prompts")],
    "prompt",
    prompts,
    /* @__PURE__ */ new Set()
  );
  const toolSeen = /* @__PURE__ */ new Set();
  for (const rawTool of runtimeTools) {
    const name = typeof rawTool === "string" ? rawTool : rawTool && typeof rawTool === "object" && "name" in rawTool && typeof rawTool.name === "string" ? rawTool.name : "";
    if (!name || toolSeen.has(name)) continue;
    toolSeen.add(name);
    const description = rawTool && typeof rawTool === "object" && "description" in rawTool && typeof rawTool.description === "string" ? rawTool.description : `Runtime tool: ${name}`;
    const cName = cleanName(name);
    const { layer, reason } = classifyByHeuristic(cName, description, "tool");
    const item = {
      id: `tool_${cName}`,
      name,
      cleanName: cName,
      type: "tool",
      layer,
      layerReason: reason,
      description,
      compactDigest: ""
    };
    item.compactDigest = generateCapabilityCompactDigest(item);
    tools.push(item);
  }
  const fingerprint = sniffProjectFingerprint(cwd);
  const hash = crypto4.createHash("md5").update(JSON.stringify({ e: extensions.map((x) => x.id), s: skills.map((x) => x.id), p: prompts.map((x) => x.id), t: tools.map((x) => x.id) })).digest("hex").slice(0, 8);
  return {
    version: hash,
    scannedAt: Date.now(),
    projectFingerprint: fingerprint,
    extensions,
    skills,
    prompts,
    tools
  };
}
function loadOrRefreshTaxonomy(cwd = process.cwd(), runtimeTools = []) {
  const fresh = discoverEcosystemTaxonomy(cwd, runtimeTools);
  try {
    const cachePath = getRuntimeTaxonomyCachePath();
    if (fs6.existsSync(cachePath)) {
      const parsed = JSON.parse(fs6.readFileSync(cachePath, "utf-8"));
      if (parsed && typeof parsed === "object" && "version" in parsed && parsed.version === fresh.version) {
        return {
          ...parsed,
          projectFingerprint: fresh.projectFingerprint
        };
      }
    }
  } catch {
  }
  return fresh;
}
function reflectEnvironmentContext(ctx, cwd = process.cwd()) {
  const tools = ctx && typeof ctx.getAllTools === "function" ? ctx.getAllTools() : [];
  return loadOrRefreshTaxonomy(cwd, Array.isArray(tools) ? tools : []);
}
async function deepAnalyzeTaxonomyWithLLM(taxonomy, ctx) {
  try {
    const items = [...taxonomy.extensions, ...taxonomy.skills, ...taxonomy.prompts].slice(0, 24).map((i) => ({ id: i.id, name: i.cleanName, type: i.type, description: i.description }));
    if (items.length === 0) return taxonomy;
    const rawText = await callExtensionLlm(
      ctx,
      "You classify Pi extensions, skills, and prompts into architectural layers.",
      `Classify these Pi ecosystem capabilities into layers (L1_UTILITY, L2_PERCEPTION, L3_ORCHESTRATION, L4_REVIEW_GUARD) and provide a concise English reason for each. Return strict JSON: {"items":[{"id":"...","layer":"...","reason":"..."}]}.
` + JSON.stringify(items),
      900
    );
    if (!rawText) return taxonomy;
    const parsed = extractValidJsonObject(rawText);
    const classified = Array.isArray(parsed.items) ? parsed.items : [];
    const byId = /* @__PURE__ */ new Map();
    for (const row of classified) {
      if (!row || typeof row !== "object") continue;
      const r = row;
      if (typeof r.id !== "string" || typeof r.layer !== "string") continue;
      if (r.layer === "L1_UTILITY" || r.layer === "L2_PERCEPTION" || r.layer === "L3_ORCHESTRATION" || r.layer === "L4_REVIEW_GUARD") {
        byId.set(r.id, {
          layer: r.layer,
          reason: typeof r.reason === "string" ? r.reason : "Classified by LLM"
        });
      }
    }
    const applyUpdate = (list) => list.map((item) => {
      const hit = byId.get(item.id);
      if (!hit) return item;
      const updated = { ...item, layer: hit.layer, layerReason: hit.reason };
      updated.compactDigest = generateCapabilityCompactDigest(updated);
      return updated;
    });
    const enriched = {
      ...taxonomy,
      extensions: applyUpdate(taxonomy.extensions),
      skills: applyUpdate(taxonomy.skills),
      prompts: applyUpdate(taxonomy.prompts)
    };
    atomicWriteFileSync(getRuntimeTaxonomyCachePath(), JSON.stringify(enriched, null, 2));
    return enriched;
  } catch {
    return taxonomy;
  }
}

// src/planner/deep-ecosystem.ts
import * as fs7 from "fs";
import * as path8 from "path";
import { exec, execSync as execSync2 } from "child_process";
import { promisify } from "util";
var execAsync = promisify(exec);
var CURATED_ECOSYSTEM_CATALOG = [
  {
    name: "pi-control-chrome",
    source: "npm:pi-control-chrome",
    description: "Real Chrome/Edge DevTools automation with live DOM, screenshot, and console error probes.",
    leverageReason: "Enables headless/browser verification and runtime DOM inspection.",
    stars: 420,
    official: true
  },
  {
    name: "pi-subagents",
    source: "npm:pi-subagents",
    description: "Multi-agent coordinator for parallel background workers and fresh-context code review.",
    leverageReason: "Supports isolated review stages and concurrent verification.",
    stars: 380,
    official: true
  },
  {
    name: "pi-web-access",
    source: "npm:pi-web-access",
    description: "Live documentation search and URL content extraction.",
    leverageReason: "Pulls up-to-date framework and API specs without stale memory.",
    stars: 310,
    official: true
  },
  {
    name: "pi-anchor",
    source: "npm:pi-anchor",
    description: "Persistent cross-session task dock with DAG tracking and session teleport.",
    leverageReason: "Retains active progress and pinned constraints across restarts.",
    stars: 260,
    official: true
  }
];
var DeepSkillsDistiller = class {
  static distillFromFile(skillName, filePath) {
    const empty = {
      skillName,
      filePath,
      directives: [],
      sopSteps: [],
      rules: [],
      checkpoints: []
    };
    try {
      if (!filePath || !fs7.existsSync(filePath)) return empty;
      const raw = fs7.readFileSync(filePath, "utf-8");
      const lines = raw.split(/\r?\n/);
      let section = "none";
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith("#")) {
          const lower = line.toLowerCase();
          if (lower.includes("sop") || lower.includes("workflow") || lower.includes("step")) {
            section = "sop";
          } else if (lower.includes("rule") || lower.includes("constraint") || lower.includes("invariant")) {
            section = "rules";
          } else if (lower.includes("check") || lower.includes("gate") || lower.includes("verify")) {
            section = "checkpoints";
          } else {
            section = "none";
          }
          continue;
        }
        const bullet = line.replace(/^[-*+]\s+|^\d+\.\s+/, "").trim();
        if (!bullet) continue;
        if (section === "sop" && empty.sopSteps.length < 6) {
          empty.sopSteps.push(bullet);
        } else if (section === "rules" && empty.rules.length < 6) {
          empty.rules.push(bullet);
        } else if (section === "checkpoints" && empty.checkpoints.length < 6) {
          empty.checkpoints.push(bullet);
        } else if ((line.startsWith("-") || line.startsWith("*") || /^\d+\./.test(line)) && empty.directives.length < 8) {
          empty.directives.push(bullet);
        }
      }
      return empty;
    } catch {
      return empty;
    }
  }
};
var McpMethodRegistry = class {
  static resolveBindingsForStage(availableMcpServers, stageObjective, isReviewStage = false) {
    if (!availableMcpServers || availableMcpServers.length === 0) return [];
    const bindings = [];
    const lowerObj = (stageObjective || "").toLowerCase();
    for (const server of availableMcpServers) {
      const lowerSrv = server.toLowerCase();
      if (lowerSrv.includes("playwright") || lowerSrv.includes("chrome") || lowerSrv.includes("puppeteer")) {
        if (isReviewStage || /ui|web|preview|screenshot|render|dom|browser/.test(lowerObj)) {
          bindings.push({
            server,
            tool: "screenshot",
            reason: "Capture visual preview and verify DOM layout without guesswork",
            template: `mcp({ server: "${server}", tool: "screenshot", args: { path: "preview.png" } })`
          });
        }
      } else if (lowerSrv.includes("context7") || lowerSrv.includes("docs") || lowerSrv.includes("fetch")) {
        bindings.push({
          server,
          tool: "query-docs",
          reason: "Verify current API signatures before implementation",
          template: `mcp({ server: "${server}", tool: "query-docs", args: { query: "..." } })`
        });
      } else if (lowerSrv.includes("postgres") || lowerSrv.includes("sqlite") || lowerSrv.includes("db")) {
        bindings.push({
          server,
          tool: "query",
          reason: "Inspect live schema constraints cleanly",
          template: `mcp({ server: "${server}", tool: "query", args: { sql: "SELECT 1" } })`
        });
      }
    }
    return bindings;
  }
};
function bindDeepEcosystemToStage(stage, availableMcpServers, discoveredSkills) {
  if (availableMcpServers && availableMcpServers.length > 0) {
    const mcpBindings = McpMethodRegistry.resolveBindingsForStage(
      availableMcpServers,
      stage.coreObjective,
      Boolean(stage.isReviewStage)
    );
    if (mcpBindings.length > 0) {
      stage.mcpToolBindings = mcpBindings;
    }
  }
  const stageSkillNames = stage.boundCapabilities?.skills ?? [];
  if (stageSkillNames.length > 0) {
    const targetSkillName = stageSkillNames[0];
    const matched = discoveredSkills.find(
      (s) => s.name === targetSkillName || s.name.includes(targetSkillName)
    );
    if (matched?.filePath && fs7.existsSync(matched.filePath)) {
      stage.skillContract = DeepSkillsDistiller.distillFromFile(targetSkillName, matched.filePath);
    } else {
      stage.skillContract = {
        skillName: targetSkillName,
        directives: [`Strictly apply ${targetSkillName} conventions during this stage.`],
        sopSteps: [],
        rules: [`Do not deviate from ${targetSkillName} constraints.`],
        checkpoints: [`Verify ${targetSkillName} acceptance criteria.`]
      };
    }
  }
}
var EcosystemRadar = class _EcosystemRadar {
  static scanCatalog(task, existingPackages = []) {
    const lowerTask = task.toLowerCase();
    const isWebOrUi = /web|ui|frontend|html|css|react|vue|svelte|browser|dom|page|dashboard|preview/.test(lowerTask);
    const isComplex = /refactor|architect|multi|pipeline|orchestr|agent|test|audit|review/.test(lowerTask);
    const missing = CURATED_ECOSYSTEM_CATALOG.filter(
      (pkg) => !existingPackages.some((e) => e.toLowerCase().includes(pkg.name.toLowerCase()))
    );
    const recommended = missing.filter((pkg) => {
      if (pkg.name === "pi-control-chrome") return isWebOrUi;
      if (pkg.name === "pi-subagents") return isComplex;
      return true;
    });
    const bundles = [];
    if (recommended.length > 0) {
      bundles.push({
        id: "bundle_recommended",
        title: "[Recommended] Task-Matched Extension Pack",
        description: `Add ${recommended.length} missing capability package(s) suited to this task.`,
        packages: recommended,
        isRecommended: true
      });
    }
    bundles.push({
      id: "bundle_vanilla",
      title: "[Zero Dependencies] Standalone Built-In Mode",
      description: "Proceed using only already-installed Pi tools and extensions.",
      packages: [],
      isRecommended: recommended.length === 0
    });
    return bundles;
  }
  static resolvePiCliCommand() {
    const localAppData = process.env.LOCALAPPDATA || "";
    const appData = process.env.APPDATA || "";
    const candidates = [
      path8.join(appData, "npm", "pi.cmd"),
      path8.join(appData, "npm", "pi"),
      path8.join(localAppData, "pnpm", "pi.cmd"),
      "pi"
    ];
    for (const candidate of candidates) {
      if (candidate === "pi") return "pi";
      if (fs7.existsSync(candidate)) return `"${candidate}"`;
    }
    try {
      const cmd = process.platform === "win32" ? "where pi" : "which pi";
      const out = execSync2(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim();
      const firstLine = out.split(/\r?\n/)[0]?.trim();
      if (firstLine) return `"${firstLine}"`;
    } catch {
    }
    return "pi";
  }
  static async installEcosystemPackages(packages) {
    const installed = [];
    const failed = [];
    const logs = [];
    const piBin = _EcosystemRadar.resolvePiCliCommand();
    for (const pkg of packages) {
      try {
        logs.push(`[ToolFlow] Installing ${pkg.source}...`);
        await execAsync(`${piBin} install ${pkg.source}`, { timeout: 6e4 });
        installed.push(pkg.name);
        logs.push(`[ToolFlow] Installed ${pkg.name}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failed.push(pkg.name);
        logs.push(`[ToolFlow] Failed to install ${pkg.name}: ${msg}`);
      }
    }
    return {
      success: failed.length === 0,
      installed,
      failed,
      log: logs.join("\n")
    };
  }
};

// src/planner/router.ts
import * as fs9 from "fs";
import * as path10 from "path";

// src/planner/anchor-handshake.ts
import * as fs8 from "fs";
import * as os2 from "os";
import * as path9 from "path";
function anchorStatePath() {
  const dir = process.env.ANCHOR_DIR || path9.join(os2.homedir(), ".anchor");
  return path9.join(dir, "state.json");
}
function isTestEnvironment2() {
  return Boolean(
    process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === "test" || process.env.VITEST
  );
}
function readAnchorState() {
  try {
    const file = anchorStatePath();
    if (!fs8.existsSync(file)) return null;
    const parsed = JSON.parse(fs8.readFileSync(file, "utf-8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}
function matchesWorkspace(anchor, cwd) {
  const target = normalizeWorkspaceKey(cwd);
  const targetBase = path9.basename(path9.resolve(cwd)).toLowerCase();
  const anchorCwd = typeof anchor.cwd === "string" && anchor.cwd ? normalizeWorkspaceKey(anchor.cwd) : "";
  const project = typeof anchor.project === "string" ? anchor.project.toLowerCase() : "";
  const matchesCwd = Boolean(
    anchorCwd && (anchorCwd === target || anchorCwd.startsWith(`${target}/`) || target.startsWith(`${anchorCwd}/`))
  );
  const matchesProject = Boolean(
    project && (project === "global" || project === targetBase || project === target)
  );
  if (!anchorCwd && !project) return true;
  return matchesCwd || matchesProject;
}
function loadActiveAnchorFiles(cwd = process.cwd()) {
  if (isTestEnvironment2() && !process.env.ANCHOR_DIR) return [];
  const state = readAnchorState();
  if (!state || !Array.isArray(state.anchors)) return [];
  const collected = /* @__PURE__ */ new Set();
  for (const anchor of state.anchors) {
    if (!anchor || anchor.status !== "active") continue;
    if (!matchesWorkspace(anchor, cwd)) continue;
    if (Array.isArray(anchor.files)) {
      for (const file of anchor.files) {
        if (typeof file === "string" && file.trim()) collected.add(file.trim());
      }
    }
    if (typeof anchor.title === "string" && anchor.title.trim()) {
      collected.add(anchor.title.trim());
    }
  }
  return [...collected];
}
function formatActiveAnchorHint(cwd = process.cwd()) {
  if (isTestEnvironment2() && !process.env.ANCHOR_DIR) return "";
  const state = readAnchorState();
  if (!state || !Array.isArray(state.anchors)) return "";
  const active = state.anchors.filter(
    (anchor) => anchor && anchor.status === "active" && matchesWorkspace(anchor, cwd)
  );
  if (active.length === 0) return "";
  const rows = active.map((anchor) => {
    const id = anchor.id ?? "?";
    const title = typeof anchor.title === "string" && anchor.title.trim() ? anchor.title.trim() : "untitled";
    const files = Array.isArray(anchor.files) && anchor.files.length > 0 ? anchor.files.filter((file) => typeof file === "string").join(", ") : "all workspace files";
    return `[#${id}] "${title}" (Files: ${files})`;
  });
  return `
Active Anchors: ${rows.join("; ")}`;
}
var PROTECTED_MARKERS = [
  "[ARCH_CONTRACT]",
  "[BLUEPRINT_ESTABLISHED]",
  "[FATAL_ERROR]",
  "[Active Anchor Focus]",
  "<sticky-notes",
  "ToolFlow Blueprint",
  "ToolFlow Slimmed History",
  "ToolFlow Dehydrated Output"
];
function isProtectedAnchorText(text, anchorFiles = []) {
  if (!text || typeof text !== "string") return false;
  if (PROTECTED_MARKERS.some((marker) => text.includes(marker))) return true;
  return anchorFiles.some((file) => Boolean(file) && text.includes(file));
}

// src/planner/router.ts
var CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff]/;
function diagnoseTaskExecutionMode(task, fp, userExplicitMode) {
  if (userExplicitMode === "fast") {
    return { mode: "fast", reason: "User explicitly requested fast execution.", estimatedComplexity: "low" };
  }
  if (userExplicitMode === "blueprint") {
    return { mode: "blueprint", reason: "User explicitly requested full blueprint planning.", estimatedComplexity: "high" };
  }
  const trimmed = task.trim();
  const lower = trimmed.toLowerCase();
  const isCjkTask = CJK_PATTERN.test(trimmed);
  const heavyPattern = /refactor|architect|migrate|redesign|pipeline|multi-stage|framework|fullstack|monorepo|end-to-end|system/i;
  if (heavyPattern.test(lower) || isCjkTask && trimmed.length > 26) {
    return {
      mode: "blueprint",
      reason: "Detected architectural, multi-stage, or system-wide task scope.",
      estimatedComplexity: "high"
    };
  }
  const microPattern = /^(fix|rename|typo|format|lint|tweak|add comment|update version|bump|check|explain)/i;
  if (trimmed.length < 48 && microPattern.test(lower) && !lower.includes("and ")) {
    return {
      mode: "fast",
      reason: "Localized single-concern task suited for fast execution.",
      estimatedComplexity: "low"
    };
  }
  if (isCjkTask && trimmed.length <= 10) {
    return {
      mode: "fast",
      reason: "Compact single-goal directive.",
      estimatedComplexity: "low"
    };
  }
  if (fp?.projectType === "monorepo" || fp?.changedModules && fp.changedModules.length >= 3) {
    return {
      mode: "blueprint",
      reason: "Multi-module workspace change benefits from staged DAG verification.",
      estimatedComplexity: "medium"
    };
  }
  if (trimmed.length <= 28 && !/\s/.test(trimmed)) {
    return {
      mode: "fast",
      reason: "Compact single-goal directive.",
      estimatedComplexity: "low"
    };
  }
  return {
    mode: "blueprint",
    reason: "Composite engineering task routed to staged blueprint execution.",
    estimatedComplexity: "medium"
  };
}
function inferArtifactProfile(fp, cwd = process.cwd()) {
  const srcDir = fp?.sourceDir && fp.sourceDir !== "." ? fp.sourceDir : "src";
  const testDir = fp?.testDir && fp.testDir !== "." ? fp.testDir : "tests";
  const pType = fp?.projectType || "unknown";
  const pkgMgr = fp?.packageManager || "npm";
  const reportDir = path10.join(".pi", "toolflow", "reports");
  const summaryPath = path10.join(reportDir, "verification_summary.json").replace(/\\/g, "/");
  switch (pType) {
    case "rust":
      return {
        srcPath: "src/main.rs",
        testPath: "tests/integration_test.rs",
        summaryPath,
        testCommands: ["cargo check", "cargo test"],
        buildCommands: ["cargo build"],
        previewCommands: ["cargo run -- --help"]
      };
    case "python": {
      const runner = pkgMgr === "uv" ? "uv run pytest" : pkgMgr === "poetry" ? "poetry run pytest" : "pytest";
      return {
        srcPath: path10.join(srcDir, "main.py").replace(/\\/g, "/"),
        testPath: path10.join(testDir, "test_main.py").replace(/\\/g, "/"),
        summaryPath,
        testCommands: [runner],
        buildCommands: ["python -m py_compile"],
        previewCommands: ["python -m main --help"]
      };
    }
    case "go":
      return {
        srcPath: "main.go",
        testPath: "main_test.go",
        summaryPath,
        testCommands: ["go test ./..."],
        buildCommands: ["go build ./..."],
        previewCommands: ["go run . --help"]
      };
    case "cpp":
      return {
        srcPath: "src/main.cpp",
        testPath: "tests/test_main.cpp",
        summaryPath,
        testCommands: ["ctest --output-on-failure"],
        buildCommands: ["cmake --build build"],
        previewCommands: ["./build/app --help"]
      };
    case "web": {
      const fw = (fp?.mainFramework || "").toLowerCase();
      const hasPkgJson = fs9.existsSync(path10.join(cwd, "package.json"));
      const srcPath = fw.includes("vue") ? "src/App.vue" : fw.includes("react") || fw.includes("next") ? "src/App.tsx" : hasPkgJson ? path10.join(srcDir, "index.ts").replace(/\\/g, "/") : "index.html";
      const runCmd = pkgMgr === "pnpm" ? "pnpm" : pkgMgr === "yarn" ? "yarn" : pkgMgr === "bun" ? "bun" : "npm";
      return {
        srcPath,
        testPath: hasPkgJson ? path10.join(testDir, "app.test.ts").replace(/\\/g, "/") : "index.test.js",
        summaryPath,
        testCommands: hasPkgJson ? [`${runCmd} test`] : ["node --test"],
        buildCommands: hasPkgJson ? [`${runCmd} run build`] : [],
        previewCommands: hasPkgJson ? [`${runCmd} run dev`] : []
      };
    }
    case "node":
    case "monorepo": {
      const runCmd = pkgMgr === "pnpm" ? "pnpm" : pkgMgr === "yarn" ? "yarn" : pkgMgr === "bun" ? "bun" : "npm";
      let isPlainJs = false;
      const fullSrcDir = path10.join(cwd, srcDir);
      if (!fs9.existsSync(path10.join(cwd, "tsconfig.json")) && fs9.existsSync(fullSrcDir)) {
        try {
          const entries = fs9.readdirSync(fullSrcDir);
          const hasJs = entries.some((e) => /\.(?:c|m)?js$/.test(e));
          const hasTs = entries.some((e) => /\.tsx?$/.test(e));
          if (hasJs && !hasTs) isPlainJs = true;
        } catch {
        }
      }
      const ext = isPlainJs ? "js" : "ts";
      return {
        srcPath: path10.join(srcDir, `index.${ext}`).replace(/\\/g, "/"),
        testPath: path10.join(testDir, `index.test.${ext}`).replace(/\\/g, "/"),
        summaryPath,
        testCommands: [`${runCmd} test`],
        buildCommands: [`${runCmd} run build`],
        previewCommands: [`${runCmd} start`]
      };
    }
    default:
      return {
        srcPath: path10.join(srcDir, "index.ts").replace(/\\/g, "/"),
        testPath: path10.join(testDir, "index.test.ts").replace(/\\/g, "/"),
        summaryPath,
        testCommands: ["npm test"],
        buildCommands: ["npm run build"],
        previewCommands: []
      };
  }
}
function generateABTradeOffMatrix(task, fp) {
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
        "Zero speculative abstractions"
      ],
      cons: ["Follow-up extensions may need light refactoring later"],
      estimatedEffort: "Low-Medium (2 stages)",
      recommendedFor: "Targeted features, bug fixes, and rapid iteration"
    },
    planB: {
      id: "B",
      title: "Modular Decoupled Architecture",
      tagline: "Clear interface boundaries, independent test seams, and review isolation",
      pros: [
        "Clean separation between core logic, adapters, and UI",
        "High long-term maintainability and parallel verification",
        "Isolated diff-only review stage before completion"
      ],
      cons: ["More files touched initially", "Slightly higher planning overhead"],
      estimatedEffort: "Medium-High (3 stages)",
      recommendedFor: "Refactors, cross-module features, and public APIs"
    },
    recommendedPlan: isComplex ? "B" : "A",
    rationale: isComplex ? "Task scope spans architecture or multiple modules; Plan B prevents coupling." : "Task scope is focused; Plan A delivers verified results with minimal churn."
  };
}
function generateUniversalMetaSlots(task, _tax, fp, tradeOff) {
  const slots = [];
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
        recommendedEcosystem: { extensions: [], reason: "Zero extra dependencies" }
      },
      {
        id: "opt_scope_plan_b",
        label: tradeOff.planB.title,
        description: tradeOff.planB.tagline,
        isRecommended: tradeOff.recommendedPlan === "B",
        recommendedEcosystem: { extensions: ["pi-subagents"], reason: "Isolated review stage" }
      }
    ]
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
            reason: "Real DOM and console verification"
          }
        },
        {
          id: "opt_web_headless",
          label: "Build + Unit/DOM Tests Only",
          description: "Verify TypeScript/bundler build and automated DOM/logic tests.",
          isRecommended: false,
          recommendedEcosystem: { extensions: [], reason: "Fast offline verification" }
        }
      ]
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
          recommendedEcosystem: { extensions: [], reason: "Core CLI contract coverage" }
        },
        {
          id: "opt_cli_minimal",
          label: "Direct Working Script",
          description: "Ship core command behavior with smoke execution check.",
          isRecommended: false,
          recommendedEcosystem: { extensions: [], reason: "Minimal setup" }
        }
      ]
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
          recommendedEcosystem: { extensions: ["pi-web-access"], reason: "API spec alignment" }
        },
        {
          id: "opt_backend_fast",
          label: "Lightweight Endpoint",
          description: "Keep handlers lean with focused integration checks.",
          isRecommended: false,
          recommendedEcosystem: { extensions: [], reason: "Low overhead" }
        }
      ]
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
          recommendedEcosystem: { extensions: [], reason: "High reliability" }
        },
        {
          id: "opt_verify_smoke",
          label: "Fast Smoke Check",
          description: "Verify compilation and primary execution path quickly.",
          isRecommended: false,
          recommendedEcosystem: { extensions: [], reason: "Fast iteration" }
        }
      ]
    });
  }
  const dynamicGoals = [
    `Align implementation with ${fp.mainFramework || fp.projectType} project conventions`,
    "Deliver verifiable artifacts with passing typecheck/tests and zero leftover temp files"
  ];
  const architectSparks = [
    {
      id: "spark_zero_regression",
      title: "Backward Compatibility Guard",
      description: "Preserve existing public exports and CLI/command signatures unless explicitly changed.",
      impact: "Prevents downstream breakage",
      isAcceptedByDefault: true
    },
    {
      id: "spark_isolated_tests",
      title: "Workspace-Isolated Tests",
      description: "Run tests in temporary directories without touching real user configuration.",
      impact: "Deterministic CI & local runs",
      isAcceptedByDefault: true
    }
  ];
  return {
    taskDescription: task,
    researchSummary: `Analyzed ${fp.projectType} workspace (${fp.packageManager}) and synthesized decision slots.`,
    requirementSlots: slots,
    dynamicGoals,
    tradeOff,
    architectSparks
  };
}
async function diagnoseTaskRequirements(task, taxonomy, ctx, providedFp, cwd = process.cwd()) {
  const fp = providedFp || taxonomy.projectFingerprint || sniffProjectFingerprint(cwd);
  const tradeOff = generateABTradeOffMatrix(task, fp);
  const fallback = generateUniversalMetaSlots(task, taxonomy, fp, tradeOff);
  try {
    const extNames = taxonomy.extensions.map((e) => e.cleanName).slice(0, 12).join(", ");
    const userPrompt = `Analyze the user's task and workspace (${fp.projectType}, ${fp.mainFramework || fp.packageManager}).
IMPORTANT: Write all user-facing labels, descriptions, and goals in the SAME language as the user's task ("${task}").
Available extensions: ${extNames || "core tools only"}.${formatActiveAnchorHint(cwd)}
Return strict JSON matching:
{"researchSummary":"...","dynamicGoals":["..."],"requirementSlots":[{"slotId":"slot_1","title":"...","category":"scope|design|verification","question":"...","options":[{"id":"opt_1","label":"...","description":"...","isRecommended":true}]}]}`;
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
    const slots = parsedSlots.filter((s) => Boolean(s && typeof s === "object")).slice(0, 4).map((s, idx) => {
      const rawOpts = Array.isArray(s.options) ? s.options : [];
      return {
        slotId: typeof s.slotId === "string" ? s.slotId : `slot_${idx + 1}`,
        title: typeof s.title === "string" ? s.title : `Decision ${idx + 1}`,
        category: normalizeSlotCategory(s.category),
        question: typeof s.question === "string" ? s.question : "Select an option:",
        options: rawOpts.filter((o) => Boolean(o && typeof o === "object")).slice(0, 4).map((o, oIdx) => ({
          id: typeof o.id === "string" ? o.id : `opt_${idx}_${oIdx}`,
          label: typeof o.label === "string" ? o.label : `Option ${oIdx + 1}`,
          description: typeof o.description === "string" ? o.description : "",
          isRecommended: Boolean(o.isRecommended),
          recommendedEcosystem: { extensions: [], reason: "LLM matched" }
        }))
      };
    }).filter((s) => s.options.length > 0);
    if (slots.length === 0) return fallback;
    const dynamicGoals = Array.isArray(parsed.dynamicGoals) ? parsed.dynamicGoals.filter((g) => typeof g === "string" && g.trim().length > 0).slice(0, 4) : fallback.dynamicGoals;
    return {
      taskDescription: task,
      researchSummary: typeof parsed.researchSummary === "string" && parsed.researchSummary.trim() ? parsed.researchSummary : fallback.researchSummary,
      requirementSlots: slots,
      dynamicGoals: dynamicGoals.length > 0 ? dynamicGoals : fallback.dynamicGoals,
      tradeOff,
      architectSparks: fallback.architectSparks
    };
  } catch {
    return fallback;
  }
}
function normalizeSlotCategory(value) {
  if (value === "scope" || value === "design" || value === "capability" || value === "verification") {
    return value;
  }
  return "general";
}

// src/core/text.ts
var CJK_PATTERN2 = /[\u3400-\u4dbf\u4e00-\u9fff]/;
function isCjkText(text) {
  return typeof text === "string" && CJK_PATTERN2.test(text);
}

// src/planner/dag.ts
function planDAGWaves(stages) {
  if (!stages || stages.length === 0) {
    return { sortedStages: [], waves: [], hasCycles: false };
  }
  const stageMap = /* @__PURE__ */ new Map();
  const inDegree = /* @__PURE__ */ new Map();
  const adjList = /* @__PURE__ */ new Map();
  for (const stage of stages) {
    stageMap.set(stage.stageId, stage);
    inDegree.set(stage.stageId, 0);
    adjList.set(stage.stageId, []);
  }
  for (const stage of stages) {
    for (const depId of stage.dependsOn ?? []) {
      if (!stageMap.has(depId)) continue;
      if (depId === stage.stageId) {
        return {
          sortedStages: stages,
          waves: [],
          hasCycles: true,
          cycleNodes: [stage.stageId]
        };
      }
      adjList.get(depId).push(stage.stageId);
      inDegree.set(stage.stageId, (inDegree.get(stage.stageId) ?? 0) + 1);
    }
  }
  let currentFrontier = [];
  for (const [stageId, deg] of inDegree.entries()) {
    if (deg === 0) currentFrontier.push(stageId);
  }
  const waves = [];
  const sortedStages = [];
  let waveIndex = 1;
  while (currentFrontier.length > 0) {
    const waveStages = [];
    const nextFrontier = [];
    for (const id of currentFrontier) {
      const stage = stageMap.get(id);
      waveStages.push(stage);
      sortedStages.push(stage);
      for (const nextId of adjList.get(id) ?? []) {
        const nextDeg = (inDegree.get(nextId) ?? 0) - 1;
        inDegree.set(nextId, nextDeg);
        if (nextDeg === 0) nextFrontier.push(nextId);
      }
    }
    waves.push({
      waveIndex,
      stages: waveStages,
      isParallel: waveStages.length > 1
    });
    currentFrontier = nextFrontier;
    waveIndex++;
  }
  if (sortedStages.length < stages.length) {
    const visited = new Set(sortedStages.map((s) => s.stageId));
    const cycleNodes = stages.filter((s) => !visited.has(s.stageId)).map((s) => s.stageId);
    return {
      sortedStages,
      waves,
      hasCycles: true,
      cycleNodes
    };
  }
  return { sortedStages, waves, hasCycles: false };
}
var CORE_DEFAULTS = ["read", "write", "edit", "bash", "grep", "find", "ls"];
var GracefulDegradationMatrix = class {
  availableTools;
  constructor(taxonomyOrTools) {
    this.availableTools = /* @__PURE__ */ new Set();
    if (Array.isArray(taxonomyOrTools)) {
      for (const t2 of taxonomyOrTools) {
        if (t2) this.availableTools.add(t2);
      }
    } else if (taxonomyOrTools) {
      for (const item of taxonomyOrTools.tools ?? []) {
        if (item.name) this.availableTools.add(item.name);
        if (item.cleanName) this.availableTools.add(item.cleanName);
      }
    }
    for (const core of CORE_DEFAULTS) this.availableTools.add(core);
  }
  hasTool(name) {
    if (this.availableTools.has(name)) return true;
    for (const t2 of this.availableTools) {
      if (t2.toLowerCase().includes(name.toLowerCase())) return true;
    }
    return false;
  }
  resolveCapability(capabilityType) {
    switch (capabilityType) {
      case "web_search":
        if (this.hasTool("web_search")) {
          return {
            capability: "web_search",
            selectedTool: "web_search",
            fallbackTool: "bash",
            tier: "TIER_1_NATIVE",
            instruction: "Use `web_search` to verify official APIs and documentation."
          };
        }
        return {
          capability: "web_search",
          selectedTool: "bash",
          fallbackTool: "read",
          tier: "TIER_2_GENERIC",
          instruction: "`web_search` unavailable; fall back to `bash` (`curl`) or local docs."
        };
      case "browser":
        if (this.hasTool("browser_probe_interaction")) {
          return {
            capability: "browser",
            selectedTool: "browser_probe_interaction",
            fallbackTool: "bash",
            tier: "TIER_1_NATIVE",
            instruction: "Use `browser_probe_interaction` to verify live DOM and console output."
          };
        }
        if (this.hasTool("playwright") || this.hasTool("mcp")) {
          return {
            capability: "browser",
            selectedTool: "mcp",
            fallbackTool: "bash",
            tier: "TIER_2_GENERIC",
            instruction: "Use MCP browser automation or headless verification scripts."
          };
        }
        return {
          capability: "browser",
          selectedTool: "bash",
          fallbackTool: "read",
          tier: "TIER_3_FALLBACK",
          instruction: "Browser controller unavailable; verify build and DOM invariants via headless CLI/tests."
        };
      case "subagent":
        if (this.hasTool("subagent")) {
          return {
            capability: "subagent",
            selectedTool: "subagent",
            fallbackTool: "read",
            tier: "TIER_1_NATIVE",
            instruction: "Delegate isolated review or parallel sub-tasks via `subagent`."
          };
        }
        return {
          capability: "subagent",
          selectedTool: "read",
          fallbackTool: "grep",
          tier: "TIER_3_FALLBACK",
          instruction: "`subagent` unavailable; execute isolated diff-only self-review in place."
        };
      case "lsp":
        if (this.hasTool("lsp")) {
          return {
            capability: "lsp",
            selectedTool: "lsp",
            fallbackTool: "grep",
            tier: "TIER_1_NATIVE",
            instruction: "Use `lsp` for definition/reference checks."
          };
        }
        return {
          capability: "lsp",
          selectedTool: "grep",
          fallbackTool: "find",
          tier: "TIER_2_GENERIC",
          instruction: "`lsp` unavailable; use `grep` and `find` for symbol tracing."
        };
      case "mcp":
        if (this.hasTool("mcp")) {
          return {
            capability: "mcp",
            selectedTool: "mcp",
            fallbackTool: "bash",
            tier: "TIER_1_NATIVE",
            instruction: "Use configured MCP tool bindings."
          };
        }
        return {
          capability: "mcp",
          selectedTool: "bash",
          fallbackTool: "read",
          tier: "TIER_3_FALLBACK",
          instruction: "MCP unavailable; use direct CLI/file tools."
        };
    }
  }
  computeAdaptiveTools(stageAllowedTools = []) {
    const warnings = [];
    const effective = new Set(CORE_DEFAULTS);
    for (const tool of stageAllowedTools) {
      if (this.hasTool(tool)) {
        effective.add(tool);
      } else {
        if (tool.includes("browser")) {
          const res = this.resolveCapability("browser");
          effective.add(res.selectedTool);
          warnings.push(res.instruction);
        } else if (tool.includes("web_search")) {
          const res = this.resolveCapability("web_search");
          effective.add(res.selectedTool);
          warnings.push(res.instruction);
        } else if (tool.includes("subagent")) {
          const res = this.resolveCapability("subagent");
          effective.add(res.selectedTool);
          warnings.push(res.instruction);
        } else {
          effective.add(tool);
        }
      }
    }
    return {
      mergedTools: Array.from(effective),
      degradedWarnings: warnings
    };
  }
};

// src/planner/synthesizer.ts
async function synthesizeBlueprintPlanWithLLM(task, taxonomy, ctx, cwd = process.cwd()) {
  const fp = taxonomy.projectFingerprint || sniffProjectFingerprint(cwd);
  const profile = inferArtifactProfile(fp, cwd);
  const fallback = {
    primaryArtifact: profile.srcPath,
    targetLanguage: fp.projectType,
    isFrontend: fp.projectType === "web"
  };
  try {
    const rawText = await callExtensionLlm(
      ctx,
      "Determine primary workspace deliverables cleanly as JSON.",
      `Determine the primary deliverable artifact path, language, and whether this is a frontend/web task.
Workspace: ${fp.projectType} (${fp.mainFramework || fp.packageManager}), sourceDir=${fp.sourceDir}.
Task: "${task}"
Return strict JSON: {"primaryArtifact":"path/to/file","targetLanguage":"ts|py|rs|go|html|...","isFrontend":false}`,
      300
    );
    if (!rawText) return fallback;
    const parsed = extractValidJsonObject(rawText);
    return {
      primaryArtifact: typeof parsed.primaryArtifact === "string" && parsed.primaryArtifact.trim() ? parsed.primaryArtifact.trim() : fallback.primaryArtifact,
      targetLanguage: typeof parsed.targetLanguage === "string" && parsed.targetLanguage.trim() ? parsed.targetLanguage.trim() : fallback.targetLanguage,
      isFrontend: typeof parsed.isFrontend === "boolean" ? parsed.isFrontend : fallback.isFrontend
    };
  } catch {
    return fallback;
  }
}
function synthesizeBlueprint(task, diagnosis, userDecisions, taxonomy, selectedPlan, customRequirements, llmArtifactPlan, cwd = process.cwd()) {
  const fp = taxonomy.projectFingerprint || sniffProjectFingerprint(cwd);
  const profile = inferArtifactProfile(fp, cwd);
  const isAgile = selectedPlan === "A" || Object.values(userDecisions).some((v) => v.includes("plan_a") || v.includes("minimal"));
  const isMicroTask = Object.values(userDecisions).some((v) => v.includes("fast")) || /^(fix|rename|typo|format|lint|tweak|check)/i.test(task.trim()) && task.trim().length < 48 || isCjkText(task) && task.trim().length <= 8;
  const mentionedPaths = Array.from(
    new Set(
      (task.match(/(?:[a-zA-Z0-9_.-]+\/)+[a-zA-Z0-9_.-]+\.[a-zA-Z0-9]+/g) ?? []).map(
        (p) => p.replace(/^\.\//, "")
      )
    )
  );
  const mentionedTests = mentionedPaths.filter((p) => /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\./i.test(p));
  const mentionedSources = mentionedPaths.filter((p) => !mentionedTests.includes(p));
  const primaryArtifact = mentionedSources[0] || llmArtifactPlan?.primaryArtifact || profile.srcPath;
  const primaryTestArtifact = mentionedTests[0] || profile.testPath;
  const isFrontend = llmArtifactPlan?.isFrontend ?? fp.projectType === "web";
  const availableMcpServers = taxonomy.tools.filter((t2) => t2.name.startsWith("mcp") || t2.cleanName.includes("playwright") || t2.cleanName.includes("chrome")).map((t2) => t2.cleanName);
  const discoveredSkills = taxonomy.skills.map((s) => ({
    name: s.cleanName,
    filePath: s.filePath
  }));
  const commonTargetPatterns = Array.from(
    /* @__PURE__ */ new Set([primaryArtifact, primaryTestArtifact, "src/**", "tests/**", "test/**", "__tests__/**"])
  );
  const stages = isMicroTask ? [
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
      allowedTools: [...BASELINE_TOOLS]
    }
  ] : isAgile ? [
    {
      stageId: "stage_1_implement",
      title: "Stage 1: Core Implementation",
      coreObjective: `Implement "${task}" cleanly in ${primaryArtifact} following existing conventions.`,
      boundCapabilities: {
        extensions: [],
        skills: discoveredSkills.slice(0, 1).map((s) => s.name),
        prompts: []
      },
      expectedArtifact: primaryArtifact,
      expectedArtifacts: [primaryArtifact],
      targetPatterns: commonTargetPatterns,
      artifactContract: `${primaryArtifact} exists, compiles, and implements the core requirement.`,
      allowedTools: [...BASELINE_TOOLS, ...llmArtifactPlan?.stageHeavyTools?.stage1 ?? []]
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
        ...isFrontend ? ["browser_probe_interaction"] : [],
        ...llmArtifactPlan?.stageHeavyTools?.stage2 ?? []
      ]
    }
  ] : [
    {
      stageId: "stage_1_design",
      title: "Stage 1: Interface & Scope Design",
      coreObjective: `Inspect existing architecture and establish contracts before editing ${primaryArtifact}.`,
      boundCapabilities: {
        extensions: [],
        skills: discoveredSkills.slice(0, 1).map((s) => s.name),
        prompts: []
      },
      expectedArtifact: primaryArtifact,
      expectedArtifacts: [primaryArtifact],
      targetPatterns: commonTargetPatterns,
      artifactContract: `Interfaces and module boundaries for ${primaryArtifact} are cleanly defined.`,
      allowedTools: [...BASELINE_TOOLS, ...llmArtifactPlan?.stageHeavyTools?.stage1 ?? []]
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
        ...isFrontend ? ["browser_probe_interaction"] : [],
        ...llmArtifactPlan?.stageHeavyTools?.stage2 ?? []
      ]
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
        diffOnlyContext: true
      }
    }
  ];
  for (const stage of stages) {
    bindDeepEcosystemToStage(stage, availableMcpServers, discoveredSkills);
  }
  const dagResult = planDAGWaves(stages);
  const activatedExtensions = /* @__PURE__ */ new Set();
  const activatedSkills = /* @__PURE__ */ new Set();
  const activatedPrompts = /* @__PURE__ */ new Set();
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
      prompts: Array.from(activatedPrompts)
    },
    tokenEfficiencySummary: `Stage-scoped tool pruning active across ${dagResult.sortedStages.length} stage(s)`,
    stages: dagResult.sortedStages,
    dagWaves: dagResult.waves,
    dynamicGoals: diagnosis.dynamicGoals,
    customRequirements
  };
}
function generateStageActionPrompt(stage, blueprint, stageIndex) {
  const totalStages = blueprint.stages.length;
  const header = `[ToolFlow Stage ${stageIndex + 1}/${totalStages}: ${stage.title}]`;
  const lines = [
    header,
    `Task: ${blueprint.task}`,
    `Objective: ${stage.coreObjective}`,
    `Expected Artifact: ${stage.expectedArtifact}`,
    `Acceptance Contract: ${stage.artifactContract}`
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
      `MCP Bindings: ${stage.mcpToolBindings.map((b) => `${b.server}.${b.tool} -> ${b.template}`).join(" | ")}`
    );
  }
  if (stage.isReviewStage) {
    lines.push("Review Mode: Read-only verification only. Inspect diffs and run checks without mutating code.");
  }
  return lines.join("\n");
}

// src/ui/cards.ts
import {
  CURSOR_MARKER,
  sliceByColumn,
  truncateToWidth,
  visibleWidth
} from "@earendil-works/pi-tui";
var DEFAULT_THEME = {
  bold: (s) => `\x1B[1m${s}\x1B[22m`,
  fg: (_color, s) => s
};
function formatCapabilityBadge(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return "";
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}
function formatCompactToolList(tools = [], maxCount = 6) {
  const unique = Array.from(new Set(tools.filter(Boolean)));
  if (unique.length === 0) return "base tools";
  if (unique.length <= maxCount) return unique.join(", ");
  return `${unique.slice(0, maxCount).join(", ")} (+${unique.length - maxCount} more)`;
}
function renderCJKSafeInputBox(prefix, text, windowWidth, theme, showCursor = true, emitHardwareCursor = false) {
  const prefixWidth = visibleWidth(prefix);
  const cursorWidth = showCursor ? 1 : 0;
  const availableWidth = Math.max(10, windowWidth - prefixWidth - cursorWidth);
  const cleanText = text.replace(/[\r\n\t]/g, " ");
  const totalTextWidth = visibleWidth(cleanText);
  let visibleSlice = cleanText;
  if (totalTextWidth > availableWidth) {
    const startCol = totalTextWidth - availableWidth;
    visibleSlice = sliceByColumn(cleanText, startCol, availableWidth, true);
  }
  const currentSliceWidth = visibleWidth(visibleSlice);
  const padCount = Math.max(0, availableWidth - currentSliceWidth);
  const marker = showCursor && emitHardwareCursor ? CURSOR_MARKER : "";
  const cursorChar = showCursor ? `${marker}\x1B[7m${theme.fg("accent", " ")}\x1B[27m` : "";
  return `${prefix}${visibleSlice}${cursorChar}${" ".repeat(padCount)}`;
}
function padToVisibleWidth(content, targetWidth) {
  const truncated = truncateToWidth(content, targetWidth, "", true);
  const visW = visibleWidth(truncated);
  return truncated + " ".repeat(Math.max(0, targetWidth - visW));
}
function renderValueReceipt(metrics) {
  const w = 62;
  const line = "-".repeat(w);
  const rows = [];
  const dur = metrics.totalDurationSec ?? metrics.durationSec ?? 0;
  const saved = metrics.tokenSavingsRatio ?? `${metrics.tokensSavedPct ?? 0}%`;
  rows.push(`+${line}+`);
  rows.push(`| ${padToVisibleWidth("                     VALUE DELIVERY RECEIPT", w - 2)} |`);
  rows.push(`+${line}+`);
  rows.push(`| ${padToVisibleWidth(`Task       : ${metrics.task}`, w - 2)} |`);
  rows.push(`| ${padToVisibleWidth(`Blueprint  : ${metrics.blueprintId}`, w - 2)} |`);
  rows.push(`| ${padToVisibleWidth(`Stages     : ${metrics.stageCount} stages verified`, w - 2)} |`);
  rows.push(`| ${padToVisibleWidth(`Duration   : ${dur}s`, w - 2)} |`);
  rows.push(`| ${padToVisibleWidth(`Efficiency : ~${saved} token overhead saved`, w - 2)} |`);
  rows.push(`+${line}+`);
  rows.push(`| ${padToVisibleWidth("Verified Physical Artifacts (SHA-256):", w - 2)} |`);
  for (const f of metrics.verifiedFiles.slice(0, 4)) {
    rows.push(`| ${padToVisibleWidth(`  [x] ${f}`, w - 2)} |`);
  }
  if (metrics.verifiedFiles.length > 4) {
    const remaining = metrics.verifiedFiles.length - 4;
    rows.push(`| ${padToVisibleWidth(`  ... and ${remaining} more verified artifacts`, w - 2)} |`);
  }
  rows.push(`+${line}+`);
  rows.push(`| ${padToVisibleWidth("Tip: Run [/toolflow export] to export blueprint report", w - 2)} |`);
  rows.push(`+${line}+`);
  return rows;
}
function renderExecutionPipelineCard(params) {
  const completedCount = params.stages.filter((_, idx) => idx < params.currentStageIndex).length;
  const totalCount = params.stages.length;
  const lines = [
    `\u25CF **Pipeline Progress** (${completedCount}/${totalCount})  \`${params.blueprintId}\``,
    `> **${params.task}**`,
    ""
  ];
  params.stages.forEach((stage, idx) => {
    const isLast = idx === params.stages.length - 1;
    const branch = isLast ? "\u2514\u2500" : "\u251C\u2500";
    let symbol = "\u25CB";
    let statusDesc = "Pending";
    if (idx < params.currentStageIndex) {
      symbol = "\u2713";
      statusDesc = "Verified";
    } else if (idx === params.currentStageIndex) {
      symbol = "\u25D0";
      statusDesc = "Running";
    }
    const modeBadge = stage.isReviewStage ? " [review]" : "";
    lines.push(`${branch} ${symbol} **Stage ${idx + 1}**: ${stage.title}${modeBadge} \`(${statusDesc})\``);
    lines.push(`   \u2514 Artifact: \`${stage.expectedArtifact}\` | Tools: \`${formatCompactToolList(stage.allowedTools, 4)}\``);
  });
  if (params.activeWorkers && params.activeWorkers.length > 0) {
    lines.push("");
    lines.push("**Active Workers:**");
    for (const w of params.activeWorkers) {
      lines.push(`- \`${w.name}\` -> Tool: **${w.tool}** (${w.status})`);
    }
  }
  lines.push("");
  lines.push(`- **Artifacts Verified**: ${params.verifiedArtifactCount} / ${params.stages.length}`);
  lines.push("*Tip: Run `/toolflow rollback` to revert current stage changes.*");
  return lines.join("\n");
}
function renderUnicodeDAG(stages, options) {
  if (!stages || stages.length === 0) return [];
  const theme = options?.theme || DEFAULT_THEME;
  const activeIdx = options?.currentStageIndex ?? -1;
  const lines = [];
  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const isCurrent = i === activeIdx;
    const isDone = activeIdx >= 0 && i < activeIdx;
    const statusNode = isDone ? theme.fg("success", "[x]") : isCurrent ? theme.fg("accent", theme.bold("[>]")) : theme.fg("dim", "[ ]");
    const headerTitle = `[Stage ${i + 1}] ${stage.title}`;
    const headerLine = isCurrent ? `${statusNode} ${theme.bold(theme.fg("accent", headerTitle))}` : `${statusNode} ${theme.bold(headerTitle)}`;
    lines.push(headerLine);
    lines.push(`  \u251C\u2500 [Artifact]  ${theme.fg("accent", stage.expectedArtifact)}`);
    if (stage.dependsOn && stage.dependsOn.length > 0) {
      lines.push(`  \u251C\u2500 [Depends]   ${theme.fg("warning", stage.dependsOn.join(", "))}`);
    }
    const boundAll = [
      ...stage.boundCapabilities?.extensions ?? [],
      ...stage.boundCapabilities?.skills ?? [],
      ...stage.boundCapabilities?.prompts ?? []
    ].filter(Boolean);
    const tailLine = boundAll.length > 0 ? `  \u2514\u2500 [Ecosystem] ${theme.fg("success", boundAll.map(formatCapabilityBadge).join(" "))}` : `  \u2514\u2500 [Tools]     ${theme.fg("dim", formatCompactToolList(stage.allowedTools, 6))}`;
    lines.push(tailLine);
    if (i < stages.length - 1) {
      lines.push("  \u2502");
    }
  }
  return lines;
}
function renderSavingsLedger(metrics) {
  const { stats } = metrics;
  const ratio = metrics.estimatedRatioPercent ?? 0;
  const kSaved = stats.totalTokensSaved >= 1e3 ? `${(stats.totalTokensSaved / 1e3).toFixed(1)}k` : `${stats.totalTokensSaved}`;
  const idle = stats.totalTokensSaved === 0 && stats.dehydratedLogsCount === 0 && stats.readCacheHitsCount === 0;
  const updated = stats.lastUpdated > 0 ? new Date(stats.lastUpdated).toISOString().replace("T", " ").slice(0, 19) : "never";
  const rows = [
    "## [ToolFlow Ledger] Context Savings",
    "| Metric | Value |",
    "| :--- | :--- |",
    `| Tokens reclaimed | ~${kSaved} |`,
    `| Log dehydration | ${stats.dehydratedLogsCount} log(s) |`,
    `| Read cache hits | ${stats.readCacheHitsCount} hit(s) |`,
    `| Blast radius blocks | ${stats.blastRadiusBlocksCount} block(s) |`,
    `| Est. overhead avoided | ~${ratio}% |`,
    `| Last update | ${updated} |`
  ];
  if (metrics.ledgerPath) rows.push(`| Ledger | \`${metrics.ledgerPath}\` |`);
  rows.push("> Counters reset with `/toolflow reset`. Run `/toolflow status` for the active stage.");
  if (idle) rows.push("> No savings recorded yet in this workspace.");
  return rows.join("\n");
}
function renderCompactEcosystemOverview(tax) {
  const formatItems = (items) => items.length > 0 ? items.map((i) => `\`${i.name}\``).join(" ") : "none";
  const l1 = formatItems(tax.extensions.filter((e) => e.layer === "L1_UTILITY"));
  const l2 = formatItems(tax.extensions.filter((e) => e.layer === "L2_PERCEPTION"));
  const l3 = formatItems(tax.extensions.filter((e) => e.layer === "L3_ORCHESTRATION"));
  const l4 = formatItems(tax.extensions.filter((e) => e.layer === "L4_REVIEW_GUARD"));
  return [
    "### Installed Ecosystem Capabilities (0-Token Memory Index)",
    `- **Utility Tools**: ${l1}`,
    `- **Search & Perception**: ${l2}`,
    `- **Orchestration**: ${l3}`,
    `- **Quality & Review**: ${l4}`,
    `- **Skills**: ${formatItems(tax.skills)}`,
    `- **Prompt Templates**: ${formatItems(tax.prompts)}`,
    "> Tip: Run `/toolflow <task>` to generate a staged execution blueprint."
  ].join("\n");
}
function renderBlueprintSummary(bp) {
  const lines = [];
  lines.push(`## [Execution Blueprint] ${bp.task}`);
  lines.push(`**Blueprint ID**: \`${bp.blueprintId}\``);
  lines.push("\n### Stage Topology & Physical Artifacts\n");
  const dagLines = renderUnicodeDAG(bp.stages, {
    theme: {
      bold: (s) => s,
      fg: (_color, s) => s
    }
  });
  lines.push("```text");
  lines.push(...dagLines);
  lines.push("```");
  lines.push("\n### Stage Specifications");
  lines.push("| Stage | Capabilities | Expected Artifact | Allowed Tools |");
  lines.push("| :--- | :--- | :--- | :--- |");
  for (let i = 0; i < bp.stages.length; i++) {
    const stage = bp.stages[i];
    const bound = [
      ...stage.boundCapabilities?.extensions ?? [],
      ...stage.boundCapabilities?.skills ?? [],
      ...stage.boundCapabilities?.prompts ?? []
    ].filter(Boolean);
    const boundAll = bound.length > 0 ? bound.map((b) => `\`${formatCapabilityBadge(b)}\``).join(" ") : "`@base`";
    const compactTools = formatCompactToolList(stage.allowedTools, 6);
    lines.push(
      `| **${i + 1}. ${stage.title}** | ${boundAll} | \`${stage.expectedArtifact}\` | \`${compactTools}\` |`
    );
  }
  if (bp.tokenEfficiencySummary && bp.tokenEfficiencySummary.trim()) {
    lines.push("\n### Selected Decisions");
    lines.push(bp.tokenEfficiencySummary);
  }
  return lines.join("\n");
}

// src/ui/navigator.ts
import {
  Editor,
  Key,
  matchesKey,
  parseKey,
  visibleWidth as visibleWidth2,
  wrapTextWithAnsi
} from "@earendil-works/pi-tui";

// src/planner/prompts-manager.ts
import * as fs10 from "fs";
import * as path11 from "path";
var PromptsManager = class {
  static getAgentDir() {
    return getPiAgentDir();
  }
  static getMruFilePath() {
    return path11.join(this.getAgentDir(), "toolflow_prompts_mru.json");
  }
  static loadMruMap() {
    try {
      const file = this.getMruFilePath();
      if (!fs10.existsSync(file)) return {};
      const parsed = JSON.parse(fs10.readFileSync(file, "utf-8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  static recordPromptUsage(command) {
    const mruMap = this.loadMruMap();
    mruMap[command] = Date.now();
    try {
      const file = this.getMruFilePath();
      fs10.mkdirSync(path11.dirname(file), { recursive: true });
      fs10.writeFileSync(file, JSON.stringify(mruMap, null, 2), "utf-8");
    } catch {
    }
  }
  static getRecentPrompts(prompts, limit = 5) {
    const sorted = [...prompts].sort((a, b) => {
      const usedA = a.lastUsedAt ?? 0;
      const usedB = b.lastUsedAt ?? 0;
      if (usedA !== usedB) return usedB - usedA;
      return b.updatedAt - a.updatedAt;
    });
    return sorted.slice(0, limit);
  }
  static scanAllPrompts(cwd = process.cwd()) {
    const agentDir = this.getAgentDir();
    const mruMap = this.loadMruMap();
    const results = [];
    const seen = /* @__PURE__ */ new Set();
    const scanDir = (dir, scope, category) => {
      if (!fs10.existsSync(dir)) return;
      try {
        for (const entry of fs10.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
          const filePath = path11.join(dir, entry.name);
          const name = entry.name.replace(/\.md$/, "");
          const command = `/${name}`;
          if (seen.has(command)) continue;
          seen.add(command);
          let description = "Custom prompt template";
          let updatedAt = 0;
          try {
            const stat = fs10.statSync(filePath);
            updatedAt = stat.mtimeMs;
            const content = fs10.readFileSync(filePath, "utf-8");
            const frontDesc = content.match(/^description:\s*["']?(.+?)["']?\s*$/m);
            if (frontDesc && frontDesc[1]) {
              description = frontDesc[1].trim();
            } else {
              const firstLine = content.split(/\r?\n/).find((l) => l.trim().length > 0 && !l.trim().startsWith("---"));
              if (firstLine) {
                description = firstLine.replace(/^#+\s*/, "").trim().slice(0, 60);
              }
            }
          } catch {
          }
          results.push({
            command,
            name,
            description,
            scope,
            category,
            filePath,
            updatedAt,
            lastUsedAt: mruMap[command]
          });
        }
      } catch {
      }
    };
    scanDir(path11.join(cwd, ".pi", "prompts"), "project", "user");
    scanDir(path11.join(agentDir, "prompts"), "global", "user");
    scanDir(path11.join(agentDir, "packages", "prompts"), "package", "system");
    return results.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  static addUserPrompt(name, description, content) {
    const cleanName2 = name.replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase() || `prompt_${Date.now()}`;
    const promptsDir = path11.join(this.getAgentDir(), "prompts");
    fs10.mkdirSync(promptsDir, { recursive: true });
    const filePath = path11.join(promptsDir, `${cleanName2}.md`);
    const formatted = [
      "---",
      `description: ${description.trim() || "Custom engineering prompt"}`,
      "---",
      "",
      content.trim(),
      ""
    ].join("\n");
    fs10.writeFileSync(filePath, formatted, "utf-8");
    return {
      command: `/${cleanName2}`,
      name: cleanName2,
      description: description.trim() || "Custom engineering prompt",
      scope: "global",
      category: "user",
      filePath,
      updatedAt: Date.now()
    };
  }
  static deleteUserPrompt(filePath) {
    try {
      if (filePath && fs10.existsSync(filePath)) {
        fs10.unlinkSync(filePath);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
  static getPromptPreviewLines(filePath, maxLines = 4) {
    try {
      const content = fs10.readFileSync(filePath, "utf-8");
      const withoutFrontmatter = content.replace(/^---[\s\S]*?---\s*/, "");
      return withoutFrontmatter.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, maxLines);
    } catch {
      return [];
    }
  }
  static async autoTagPromptWithLLM(content, ctx) {
    const words = content.trim().split(/\s+/).slice(0, 3).join("-").replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase();
    const fallbackName = words || `prompt-${Date.now().toString(36).slice(-4)}`;
    const fallbackDesc = content.trim().split(/\r?\n/)[0]?.slice(0, 48) || "Custom prompt";
    try {
      const rawText = await callExtensionLlm(
        ctx,
        "Generate concise command names and descriptions for reusable developer prompts.",
        `Generate a short kebab-case command name (English lowercase letters/digits/hyphens) and a concise description (under 40 chars, matching the prompt's language) for this prompt:
${content.slice(0, 800)}
Return strict JSON: {"name":"short-name","description":"..."}`,
        150
      );
      if (!rawText) return { name: fallbackName, description: fallbackDesc };
      const parsed = extractValidJsonObject(rawText);
      const rawName = typeof parsed.name === "string" ? parsed.name : fallbackName;
      const rawDesc = typeof parsed.description === "string" ? parsed.description : fallbackDesc;
      return {
        name: rawName.replace(/[^a-zA-Z0-9_-]/g, "").toLowerCase() || fallbackName,
        description: rawDesc.trim() || fallbackDesc
      };
    } catch {
      return { name: fallbackName, description: fallbackDesc };
    }
  }
};

// src/ui/navigator.ts
function getOptionEcoItems(opt) {
  const rec = opt.recommendedEcosystem;
  if (!rec) return [];
  const rawList = [...rec.extensions ?? [], ...rec.skills ?? [], ...rec.prompts ?? []];
  return rawList.filter((name) => {
    const trimmed = (name || "").trim();
    return trimmed !== "" && trimmed !== "ecosystem-plugin";
  });
}
function getInitialOptionIndex(slot) {
  if (!slot?.options) return 0;
  const recIdx = slot.options.findIndex((o) => o.isRecommended);
  return recIdx >= 0 ? recIdx : 0;
}
async function openArchitectNavigator(ui, _taxonomy, initialTask = "", slots, diagnosis, ctx) {
  const activeCwd = ctx?.cwd || process.cwd();
  let factoryMounted = false;
  const result = await ui.custom((tui, theme, _keybindings, done) => {
    factoryMounted = true;
    let promptsList = PromptsManager.scanAllPrompts(activeCwd);
    let promptTab = "recent";
    let selectedPromptIdx = 0;
    let newPromptName = "";
    let newPromptDesc = "";
    let newPromptContent = "";
    let state = slots && slots.length > 0 ? "deciding" : initialTask ? "input" : "overview";
    let inputTask = initialTask;
    let customRequirementsText = "";
    let newOptionTitle = "";
    let currentSlotIndex = 0;
    let cachedLines;
    const acceptedSparks = new Set(
      (diagnosis?.architectSparks ?? []).filter((s) => s.isAcceptedByDefault).map((s) => s.id)
    );
    const safeSlots = Array.isArray(slots) ? slots : [];
    let selectedOptionIndex = getInitialOptionIndex(safeSlots[0]);
    const userDecisions = {};
    let selectedPlan = diagnosis?.tradeOff?.recommendedPlan ?? "B";
    const editorTheme = {
      borderColor: (s) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (txt) => theme.fg("accent", txt),
        selectedText: (txt) => theme.fg("accent", txt),
        description: (txt) => theme.fg("muted", txt),
        scrollInfo: (txt) => theme.fg("dim", txt),
        noMatch: (txt) => theme.fg("warning", txt)
      }
    };
    const tuiForEditor = tui.terminal ? tui : { ...tui, terminal: { rows: 24, columns: 80 }, requestRender: () => tui.requestRender() };
    const editor = new Editor(tuiForEditor, editorTheme);
    editor.focused = true;
    if (initialTask) {
      editor.setText(initialTask);
    }
    function rerender() {
      cachedLines = void 0;
      tui.requestRender();
    }
    function enterEditorState(nextState, initialVal = "") {
      state = nextState;
      editor.setText(initialVal);
      editor.focused = true;
      rerender();
    }
    function isEditorActiveState() {
      return state === "input" || state === "add_prompt_content" || state === "add_prompt_name" || state === "add_prompt_desc" || state === "refining" || state === "custom_option_input";
    }
    function getFilteredPrompts() {
      if (promptTab === "recent") {
        return PromptsManager.getRecentPrompts(promptsList, 5);
      }
      if (promptTab === "user") {
        return promptsList.filter((p) => p.category === "user");
      }
      return promptsList.filter((p) => p.category === "system");
    }
    editor.onChange = (val) => {
      if (state === "input") inputTask = val;
      else if (state === "add_prompt_content") newPromptContent = val;
      else if (state === "add_prompt_name") newPromptName = val;
      else if (state === "add_prompt_desc") newPromptDesc = val;
      else if (state === "refining") customRequirementsText = val;
      else if (state === "custom_option_input") newOptionTitle = val;
    };
    editor.onSubmit = (val) => {
      const trimmed = val.trim();
      if (state === "input") {
        if (trimmed) done({ kind: "task_input", task: trimmed });
      } else if (state === "add_prompt_content") {
        newPromptContent = trimmed;
        if (newPromptContent) enterEditorState("add_prompt_name", newPromptName);
      } else if (state === "add_prompt_name") {
        newPromptName = trimmed;
        if (newPromptName) enterEditorState("add_prompt_desc", newPromptDesc);
      } else if (state === "add_prompt_desc") {
        newPromptDesc = trimmed;
        if (newPromptName.trim() && newPromptContent.trim()) {
          PromptsManager.addUserPrompt(
            newPromptName.trim(),
            newPromptDesc || newPromptName.trim(),
            newPromptContent.trim()
          );
          promptsList = PromptsManager.scanAllPrompts(activeCwd);
          selectedPromptIdx = 0;
          state = "overview";
          rerender();
        }
      } else if (state === "refining") {
        customRequirementsText = trimmed;
        state = "deciding";
        rerender();
      } else if (state === "custom_option_input") {
        newOptionTitle = trimmed;
        if (newOptionTitle) {
          const currentSlot = safeSlots[currentSlotIndex];
          if (currentSlot) {
            const newOpt = {
              id: `custom_${Date.now()}`,
              label: `[+] ${newOptionTitle}`,
              description: "",
              isRecommended: false,
              recommendedEcosystem: { extensions: [], reason: "Custom" }
            };
            currentSlot.options.push(newOpt);
            selectedOptionIndex = currentSlot.options.length - 1;
          }
        }
        state = "deciding";
        rerender();
      }
    };
    return {
      focused: true,
      invalidate: () => {
        cachedLines = void 0;
        editor.invalidate();
      },
      render: (width) => {
        if (cachedLines) return cachedLines;
        const lines = [];
        const renderWidth = Math.max(20, width);
        const titleColor = (s) => theme.fg("accent", theme.bold(s));
        const addWrapped = (text) => {
          lines.push(...wrapTextWithAnsi(text, renderWidth));
        };
        const addWrappedWithPrefix = (prefix, text) => {
          const prefixWidth = visibleWidth2(prefix);
          if (prefixWidth >= renderWidth) {
            addWrapped(prefix + text);
            return;
          }
          const wrapped = wrapTextWithAnsi(text, renderWidth - prefixWidth);
          const contPrefix = " ".repeat(prefixWidth);
          for (let i = 0; i < wrapped.length; i++) {
            lines.push(`${i === 0 ? prefix : contPrefix}${wrapped[i]}`);
          }
        };
        const renderEditorBlock = () => {
          for (const line of editor.render(Math.max(10, renderWidth - 2))) {
            lines.push(` ${line}`);
          }
        };
        lines.push(theme.fg("accent", "\u2500".repeat(renderWidth)));
        if (state === "overview") {
          addWrappedWithPrefix(" ", titleColor("ToolFlow Workbench"));
          addWrappedWithPrefix(
            " ",
            `${theme.fg("success", theme.bold("> [Enter / i] Start New Task"))}   ${theme.fg(
              "dim",
              "(or run /toolflow <task>)"
            )}`
          );
          lines.push("");
          const currentFiltered = getFilteredPrompts();
          const tabRecent = promptTab === "recent" ? theme.bg?.("selectedBg", theme.fg("text", " \u25CF Recent ")) ?? theme.fg("text", " \u25CF Recent ") : theme.fg("muted", " \u25CB Recent ");
          const tabUser = promptTab === "user" ? theme.bg?.("selectedBg", theme.fg("text", " \u25CF Custom ")) ?? theme.fg("text", " \u25CF Custom ") : theme.fg("muted", " \u25CB Custom ");
          const tabSystem = promptTab === "system" ? theme.bg?.("selectedBg", theme.fg("text", " \u25CF Built-in ")) ?? theme.fg("text", " \u25CF Built-in ") : theme.fg("muted", " \u25CB Built-in ");
          addWrappedWithPrefix(" ", `${tabRecent} ${tabUser} ${tabSystem} ${theme.fg("dim", "(Tab)")}`);
          lines.push("");
          if (currentFiltered.length === 0) {
            addWrappedWithPrefix("   ", theme.fg("dim", "(empty \u2014 press Tab or +)"));
          } else {
            const windowSize = 5;
            let startIdx = 0;
            if (currentFiltered.length > windowSize) {
              if (selectedPromptIdx < windowSize) {
                startIdx = 0;
              } else if (selectedPromptIdx >= currentFiltered.length - 1) {
                startIdx = currentFiltered.length - windowSize;
              } else {
                startIdx = Math.min(
                  currentFiltered.length - windowSize,
                  selectedPromptIdx - Math.floor(windowSize / 2)
                );
              }
            }
            const visiblePrompts = currentFiltered.slice(startIdx, startIdx + windowSize);
            if (startIdx > 0) addWrappedWithPrefix("   ", theme.fg("dim", `\u25B2 +${startIdx} (\u2191)`));
            visiblePrompts.forEach((p, vIdx) => {
              const actualIdx = startIdx + vIdx;
              const isSel = actualIdx === selectedPromptIdx;
              const cursor = isSel ? theme.fg("accent", "> ") : "  ";
              const cmdPadded = p.command.length < 20 ? p.command + " ".repeat(20 - p.command.length) : p.command;
              const cmdStr = isSel ? theme.bold(theme.fg("accent", cmdPadded)) : theme.fg("text", cmdPadded);
              const tag = p.category === "user" ? p.scope === "project" ? theme.fg("warning", "[proj]") : theme.fg("success", "[user]") : theme.fg("dim", "[sys]");
              const descStr = p.description ? theme.fg("muted", p.description) : "";
              addWrappedWithPrefix(` ${cursor}`, `${cmdStr} ${tag} ${descStr}`);
            });
            if (startIdx + windowSize < currentFiltered.length) {
              addWrappedWithPrefix(
                "   ",
                theme.fg("dim", `\u25BC +${currentFiltered.length - (startIdx + windowSize)} (\u2193)`)
              );
            }
            const selectedItem = currentFiltered[selectedPromptIdx];
            if (selectedItem) {
              lines.push("");
              const previewLines = PromptsManager.getPromptPreviewLines(selectedItem.filePath, 3);
              for (const pl of previewLines) {
                addWrappedWithPrefix("     ", theme.fg("dim", pl));
              }
            }
          }
          lines.push("");
          addWrappedWithPrefix(
            " ",
            theme.fg("dim", "Enter/i new task \u2022 p load template \u2022 + new template \u2022 d delete \u2022 Esc exit")
          );
        } else if (state === "add_prompt_content") {
          addWrappedWithPrefix(" ", titleColor("New Template (1/3): Content"));
          lines.push("");
          renderEditorBlock();
          lines.push("");
          addWrappedWithPrefix(" ", theme.fg("dim", "Enter next \u2022 Ctrl+L AI auto-name \u2022 Esc back"));
        } else if (state === "add_prompt_name") {
          addWrappedWithPrefix(" ", titleColor("New Template (2/3): /command-name"));
          lines.push("");
          renderEditorBlock();
          lines.push("");
          addWrappedWithPrefix(" ", theme.fg("dim", "Enter next \u2022 Esc back"));
        } else if (state === "add_prompt_desc") {
          addWrappedWithPrefix(" ", titleColor(`New Template (3/3): /${newPromptName} Description`));
          lines.push("");
          renderEditorBlock();
          lines.push("");
          addWrappedWithPrefix(" ", theme.fg("dim", "Enter save \u2022 Esc back"));
        } else if (state === "input") {
          addWrappedWithPrefix(" ", titleColor("Task Objective"));
          lines.push("");
          renderEditorBlock();
          lines.push("");
          const taskRoute = diagnoseTaskExecutionMode(inputTask);
          const routeBadge = taskRoute.mode === "fast" ? theme.fg("success", "Fast-Track (1-step)") : theme.fg("accent", "Staged Blueprint");
          addWrappedWithPrefix(" ", `${theme.fg("dim", "Mode:")} ${routeBadge}`);
          addWrappedWithPrefix(" ", theme.fg("dim", "Enter start \u2022 Esc back"));
        } else if (state === "deciding") {
          const currentSlot = safeSlots[currentSlotIndex];
          if (!currentSlot) return [];
          const tabA = selectedPlan === "A" ? theme.bg?.("selectedBg", theme.fg("text", " [A: 2-Stage Agile] ")) ?? theme.fg("text", " [A: 2-Stage Agile] ") : theme.fg("dim", " A: 2-Stage Agile ");
          const tabB = selectedPlan === "B" ? theme.bg?.("selectedBg", theme.fg("text", " [B: 3-Stage Modular] ")) ?? theme.fg("text", " [B: 3-Stage Modular] ") : theme.fg("dim", " B: 3-Stage Modular ");
          addWrappedWithPrefix(
            " ",
            `${theme.fg("accent", theme.bold(inputTask || "Task"))}  ${tabA}${tabB} ${theme.fg("dim", "(Tab)")}`
          );
          lines.push("");
          const slotQuestion = currentSlot.question ? ` \xB7 ${currentSlot.question}` : "";
          addWrappedWithPrefix(
            " ",
            `[${currentSlotIndex + 1}/${safeSlots.length}] ${theme.bold(
              theme.fg("accent", currentSlot.title || "Option")
            )}${theme.fg("muted", slotQuestion)}`
          );
          lines.push("");
          currentSlot.options.forEach((opt, idx) => {
            const isSel = idx === selectedOptionIndex;
            const prefix = isSel ? theme.fg("accent", "> ") : "  ";
            const recMark = opt.isRecommended ? " \u2605" : "";
            addWrappedWithPrefix(` ${prefix}`, theme.fg(isSel ? "accent" : "text", `${idx + 1}. ${opt.label}${recMark}`));
            if (opt.description) {
              addWrappedWithPrefix("      ", theme.fg("muted", opt.description));
            }
            if (isSel) {
              const ecoItems = getOptionEcoItems(opt);
              if (ecoItems.length > 0) {
                addWrappedWithPrefix(
                  "      ",
                  ecoItems.map((n) => theme.fg("accent", `[@${n}]`)).join(" ")
                );
              }
            }
          });
          const sparks = diagnosis?.architectSparks ?? [];
          if (sparks.length > 0) {
            lines.push("");
            for (const spark of sparks) {
              const tag = acceptedSparks.has(spark.id) ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
              addWrappedWithPrefix(
                "   ",
                `${tag} ${theme.bold(spark.title)}: ${theme.fg("muted", spark.description)} ${theme.fg("dim", "(s)")}`
              );
            }
          }
          lines.push("");
          addWrappedWithPrefix(
            " ",
            theme.fg("dim", "\u2191\u2193/1-3 select \u2022 Enter next \u2022 a quick-run \u2022 e note \u2022 + custom \u2022 Esc back")
          );
        } else if (state === "outline_confirm") {
          addWrappedWithPrefix(
            " ",
            titleColor(`Blueprint Ready (${selectedPlan === "A" ? "2-Stage Agile" : "3-Stage Modular"})`)
          );
          lines.push("");
          addWrappedWithPrefix(" ", theme.fg("accent", inputTask || "Task"));
          if (customRequirementsText.trim()) {
            addWrappedWithPrefix(" ", theme.fg("warning", `+ ${customRequirementsText.trim()}`));
          }
          lines.push("");
          if (selectedPlan === "A") {
            addWrappedWithPrefix("   ", "1. Core Implementation");
            addWrappedWithPrefix("   ", "2. Test & Verification Gate");
          } else {
            addWrappedWithPrefix("   ", "1. Interface & Scope Design");
            addWrappedWithPrefix("   ", "2. Modular Implementation & Tests");
            addWrappedWithPrefix("   ", "3. Read-Only Diff Review & Gate");
          }
          lines.push("");
          addWrappedWithPrefix(" ", theme.fg("dim", "Enter launch \u2022 Esc back"));
        } else if (state === "refining") {
          addWrappedWithPrefix(" ", titleColor("Add Note / Constraint"));
          lines.push("");
          renderEditorBlock();
          lines.push("");
          addWrappedWithPrefix(" ", theme.fg("dim", "Enter save \u2022 Esc cancel"));
        } else if (state === "custom_option_input") {
          addWrappedWithPrefix(
            " ",
            titleColor(`Custom Option: ${safeSlots[currentSlotIndex]?.title || ""}`)
          );
          lines.push("");
          renderEditorBlock();
          lines.push("");
          addWrappedWithPrefix(" ", theme.fg("dim", "Enter add \u2022 Esc cancel"));
        }
        lines.push(theme.fg("accent", "\u2500".repeat(renderWidth)));
        cachedLines = lines;
        return lines;
      },
      handleInput: (data) => {
        if (isEditorActiveState()) {
          if (matchesKey(data, Key.escape)) {
            if (state === "input" || state === "add_prompt_content") {
              state = "overview";
            } else if (state === "add_prompt_name") {
              enterEditorState("add_prompt_content", newPromptContent);
              return;
            } else if (state === "add_prompt_desc") {
              enterEditorState("add_prompt_name", newPromptName);
              return;
            } else {
              state = "deciding";
            }
            rerender();
            return;
          }
          if (state === "add_prompt_content" && (data === "\f" || data.charCodeAt(0) === 12)) {
            PromptsManager.autoTagPromptWithLLM(newPromptContent, ctx).then((res) => {
              newPromptName = res.name;
              newPromptDesc = res.description;
              enterEditorState("add_prompt_desc", newPromptDesc);
            });
            return;
          }
          editor.handleInput(data);
          rerender();
          return;
        }
        const parsed = parseKey(data);
        const isUp = matchesKey(data, Key.up) || parsed === "up";
        const isDown = matchesKey(data, Key.down) || parsed === "down";
        const isEnter = matchesKey(data, Key.enter) || parsed === "enter" || data === "\r" || data === "\n";
        const isEscape = matchesKey(data, Key.escape) || parsed === "escape";
        const isTab = matchesKey(data, Key.tab) || parsed === "tab" || data === "	";
        const key = data.toLowerCase();
        if (state === "overview") {
          const currentFiltered = getFilteredPrompts();
          if (isTab) {
            promptTab = promptTab === "recent" ? "user" : promptTab === "user" ? "system" : "recent";
            selectedPromptIdx = 0;
            rerender();
          } else if (isUp && selectedPromptIdx > 0) {
            selectedPromptIdx--;
            rerender();
          } else if (isDown && selectedPromptIdx < currentFiltered.length - 1) {
            selectedPromptIdx++;
            rerender();
          } else if (key === "d" || key === "delete") {
            const sel = currentFiltered[selectedPromptIdx];
            if (sel && sel.category === "user" && PromptsManager.deleteUserPrompt(sel.filePath)) {
              promptsList = PromptsManager.scanAllPrompts(activeCwd);
              const updated = getFilteredPrompts();
              selectedPromptIdx = Math.min(selectedPromptIdx, Math.max(0, updated.length - 1));
              rerender();
            }
          } else if (key === "p") {
            const sel = currentFiltered[selectedPromptIdx];
            if (sel) {
              PromptsManager.recordPromptUsage(sel.command);
              done({ kind: "prompt_invoke", command: sel.command, filePath: sel.filePath });
            }
          } else if (isEnter || key === "i" || key === " ") {
            enterEditorState("input", inputTask);
          } else if (key === "+" || key === "a") {
            newPromptContent = "";
            newPromptName = "";
            newPromptDesc = "";
            enterEditorState("add_prompt_content", "");
          } else if (isEscape) {
            done(null);
          }
          return;
        }
        if (state === "deciding") {
          const currentSlot = safeSlots[currentSlotIndex];
          const options = currentSlot ? currentSlot.options : [];
          if (isEscape) {
            if (currentSlotIndex > 0) {
              currentSlotIndex--;
              selectedOptionIndex = getInitialOptionIndex(safeSlots[currentSlotIndex]);
              rerender();
            } else {
              done(null);
            }
          } else if (isTab || key === "p") {
            selectedPlan = selectedPlan === "A" ? "B" : "A";
            userDecisions.__plan = selectedPlan;
            rerender();
          } else if (key === "s") {
            const sparks = diagnosis?.architectSparks ?? [];
            if (sparks.length > 0) {
              const unaccepted = sparks.find((sp) => !acceptedSparks.has(sp.id));
              if (unaccepted) acceptedSparks.add(unaccepted.id);
              else acceptedSparks.clear();
              rerender();
            }
          } else if (key === "e") {
            enterEditorState("refining", customRequirementsText);
          } else if (data === "+" || data === "=") {
            newOptionTitle = "";
            enterEditorState("custom_option_input", "");
          } else if (key === "a") {
            for (const s of safeSlots) {
              const recOpt = s.options.find((o) => o.isRecommended) ?? s.options[0];
              if (recOpt) userDecisions[s.slotId] = recOpt.id || recOpt.label || "";
            }
            userDecisions.__plan = "A";
            selectedPlan = "A";
            state = "outline_confirm";
            rerender();
          } else if (key === "1" && options.length >= 1) {
            selectedOptionIndex = 0;
            rerender();
          } else if (key === "2" && options.length >= 2) {
            selectedOptionIndex = 1;
            rerender();
          } else if (key === "3" && options.length >= 3) {
            selectedOptionIndex = 2;
            rerender();
          } else if (isUp && selectedOptionIndex > 0) {
            selectedOptionIndex--;
            rerender();
          } else if (isDown && selectedOptionIndex < options.length - 1) {
            selectedOptionIndex++;
            rerender();
          } else if (isEnter) {
            const chosen = options[selectedOptionIndex];
            if (chosen && currentSlot) {
              userDecisions[currentSlot.slotId] = chosen.id || chosen.label || "";
            }
            if (currentSlotIndex < safeSlots.length - 1) {
              currentSlotIndex++;
              selectedOptionIndex = getInitialOptionIndex(safeSlots[currentSlotIndex]);
              rerender();
            } else {
              userDecisions.__plan = selectedPlan;
              state = "outline_confirm";
              rerender();
            }
          }
          return;
        }
        if (state === "outline_confirm") {
          if (isEscape) {
            state = "deciding";
            rerender();
          } else if (isEnter) {
            const allCustomReqs = [];
            if (customRequirementsText.trim()) allCustomReqs.push(customRequirementsText.trim());
            for (const sp of diagnosis?.architectSparks ?? []) {
              if (acceptedSparks.has(sp.id)) {
                allCustomReqs.push(`[Spark] ${sp.title}: ${sp.impact}`);
              }
            }
            done({
              kind: "decisions",
              decisions: userDecisions,
              task: inputTask,
              selectedPlan,
              customRequirements: allCustomReqs.length > 0 ? allCustomReqs : void 0,
              customEcosystem: {
                enabledExtensions: [],
                enabledSkills: [],
                enabledPrompts: []
              }
            });
          }
        }
      }
    };
  });
  if (!result && !factoryMounted) {
    return { kind: "custom_ui_unavailable" };
  }
  return result;
}

// src/extension/commands.ts
var TOOL_HOST_KEYS = ["setActiveTools", "getAllTools", "getActiveTools"];
function resolveToolHost(pi, ctx) {
  const candidate = ctx;
  if (TOOL_HOST_KEYS.some((key) => typeof candidate?.[key] === "function")) {
    return candidate;
  }
  return pi;
}
function asLlmHost(ctx) {
  return ctx;
}
function asCustomUiHost(ctx) {
  const ui = ctx.ui;
  return ui && typeof ui.custom === "function" ? ui : null;
}
function clampLabel(text, maxColumns = 30) {
  return truncateToWidth2(text, maxColumns, "\u2026");
}
function updateToolFlowStatusBar(ctx, state, cwd) {
  const ui = ctx?.ui;
  if (!ui || typeof ui.setStatus !== "function") return;
  const savings = getStatsManager(cwd).getCompactBadge();
  if (state.status === "in_progress" && state.currentBlueprint) {
    const idx = state.currentStageIndex + 1;
    const total = state.currentBlueprint.stages.length;
    const stage = state.currentBlueprint.stages[state.currentStageIndex];
    const label = clampLabel(stage ? stage.title : "Running");
    ui.setStatus("toolflow", `[${idx}/${total}] ${label} \xB7 ${savings}`);
    return;
  }
  if (state.status === "completed" && state.currentBlueprint) {
    ui.setStatus("toolflow", `\u2713 Completed \xB7 ${savings}`);
    return;
  }
  if (state.status === "healing_failed_circuit_break") {
    ui.setStatus("toolflow", `\u25B2 Paused \xB7 rollback \xB7 ${savings}`);
    return;
  }
  ui.setStatus("toolflow", savings);
}
function renderStatsLedger(cwd) {
  const manager = getStatsManager(cwd);
  const summary = manager.getSavingsSummary();
  return renderSavingsLedger({
    stats: summary.stats,
    estimatedRatioPercent: summary.estimatedRatioPercent,
    ledgerPath: manager.getLedgerPath()
  });
}
function registerToolFlowCommand(pi, getActiveCwd, setActiveCwd) {
  if (typeof pi.registerCommand !== "function") return;
  async function runTaskDecisionPipeline(rawTask, taxonomy, ctx, userExplicitMode) {
    const cwd = ctx.cwd || getActiveCwd();
    setActiveCwd(cwd);
    const store = getWorkspaceStore(cwd);
    const toolHost = resolveToolHost(pi, ctx);
    ctx.ui?.notify?.(t.analyzingTask(rawTask), "info");
    const routeDecision = diagnoseTaskExecutionMode(
      rawTask,
      taxonomy.projectFingerprint,
      userExplicitMode
    );
    if (routeDecision.mode === "fast") {
      const llmPlan2 = await synthesizeBlueprintPlanWithLLM(rawTask, taxonomy, asLlmHost(ctx), cwd);
      const fastDiagnosis = await diagnoseTaskRequirements(rawTask, taxonomy, asLlmHost(ctx), void 0, cwd);
      const blueprint2 = synthesizeBlueprint(
        rawTask,
        fastDiagnosis,
        { route: "fast" },
        taxonomy,
        "A",
        void 0,
        llmPlan2,
        cwd
      );
      store.startBlueprintExecution(blueprint2);
      const firstStage2 = blueprint2.stages[0];
      if (!firstStage2) return;
      store.applyToolScoping(firstStage2.allowedTools, toolHost);
      updateToolFlowStatusBar(ctx, store.getState(), cwd);
      ctx.ui?.notify?.(t.fastStart(firstStage2.title), "info");
      pi.sendUserMessage(generateStageActionPrompt(firstStage2, blueprint2, 0));
      return;
    }
    const diagnosis = await diagnoseTaskRequirements(rawTask, taxonomy, asLlmHost(ctx), void 0, cwd);
    let userDecisions = null;
    let selectedPlan = diagnosis.tradeOff?.recommendedPlan ?? "B";
    let customRequirements;
    let usedCustomUi = false;
    const customUi = asCustomUiHost(ctx);
    if (customUi) {
      const navResult = await openArchitectNavigator(
        customUi,
        taxonomy,
        rawTask,
        diagnosis.requirementSlots,
        diagnosis,
        asLlmHost(ctx)
      );
      if (navResult?.kind === "decisions") {
        usedCustomUi = true;
        userDecisions = navResult.decisions;
        selectedPlan = navResult.selectedPlan ?? selectedPlan;
        customRequirements = navResult.customRequirements;
      } else if (navResult?.kind !== "custom_ui_unavailable") {
        ctx.ui?.notify?.(t.cancelled, "info");
        return;
      }
    }
    if (!usedCustomUi) {
      if (typeof ctx.ui?.select === "function") {
        const collected = {};
        for (const slot of diagnosis.requirementSlots) {
          const picked = await ctx.ui.select(
            slot.question,
            slot.options.map((option) => option.label)
          );
          if (!picked) {
            ctx.ui?.notify?.(t.cancelled, "info");
            return;
          }
          const matched = slot.options.find((option) => option.label === picked) ?? slot.options[0];
          if (matched) collected[slot.slotId] = matched.id;
        }
        userDecisions = collected;
      } else {
        const collected = {};
        for (const slot of diagnosis.requirementSlots) {
          const recommended = slot.options.find((option) => option.isRecommended) ?? slot.options[0];
          if (recommended) collected[slot.slotId] = recommended.id;
        }
        userDecisions = collected;
      }
    }
    if (!userDecisions) {
      ctx.ui?.notify?.(t.noDecision, "info");
      return;
    }
    const ecosystemDecision = userDecisions["slot_ecosystem_expansion"];
    if (ecosystemDecision && ecosystemDecision.startsWith("bundle_") && ecosystemDecision !== "bundle_vanilla") {
      const bundles = EcosystemRadar.scanCatalog(
        rawTask,
        taxonomy.extensions.map((ext) => ext.name)
      );
      const chosen = bundles.find((bundle) => bundle.id === ecosystemDecision);
      if (chosen && chosen.packages.length > 0) {
        ctx.ui?.notify?.(
          `[ToolFlow] Installing extension(s): ${chosen.packages.map((pkg) => pkg.name).join(", ")}`,
          "info"
        );
        await EcosystemRadar.installEcosystemPackages(chosen.packages);
      }
    }
    const llmPlan = await synthesizeBlueprintPlanWithLLM(rawTask, taxonomy, asLlmHost(ctx), cwd);
    const blueprint = synthesizeBlueprint(
      rawTask,
      diagnosis,
      userDecisions,
      taxonomy,
      selectedPlan,
      customRequirements,
      llmPlan,
      cwd
    );
    store.startBlueprintExecution(blueprint);
    const firstStage = blueprint.stages[0];
    if (!firstStage) return;
    store.applyToolScoping(firstStage.allowedTools, toolHost);
    updateToolFlowStatusBar(ctx, store.getState(), cwd);
    ctx.ui?.notify?.(t.blueprintStart(blueprint.stages.length, firstStage.title), "info");
    pi.sendUserMessage(
      `${renderBlueprintSummary(blueprint)}

---

${generateStageActionPrompt(firstStage, blueprint, 0)}`
    );
  }
  pi.registerCommand("toolflow", {
    description: "ToolFlow Context Optimizer & Staged Blueprint Workbench",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd || getActiveCwd();
      setActiveCwd(cwd);
      const store = getWorkspaceStore(cwd);
      const toolHost = resolveToolHost(pi, ctx);
      const trimmedArgs = (args || "").trim();
      if (trimmedArgs === "help" || trimmedArgs === "--help" || trimmedArgs === "-h") {
        ctx.ui?.notify?.(t.helpBanner, "info");
        return;
      }
      if (trimmedArgs === "reset") {
        store.reset();
        store.restoreInitialActiveTools(toolHost);
        clearAllReadCaches();
        getStatsManager(cwd).resetLedger();
        clearAllStatsManagers();
        ContextDehydrator.clearLatestLogPaths();
        updateToolFlowStatusBar(ctx, store.getState(), cwd);
        ctx.ui?.notify?.(t.resetSuccess, "info");
        return;
      }
      if (trimmedArgs === "stats") {
        ctx.ui?.notify?.(renderStatsLedger(cwd), "info");
        return;
      }
      const taxonomy = reflectEnvironmentContext(toolHost, cwd);
      if (trimmedArgs === "dashboard") {
        const current = store.getState();
        const stageView = current.currentBlueprint ? renderBlueprintSummary(current.currentBlueprint) : renderCompactEcosystemOverview(taxonomy);
        ctx.ui?.notify?.(`${stageView}

---

${renderStatsLedger(cwd)}`, "info");
        return;
      }
      if (trimmedArgs === "status") {
        const current = store.getState();
        const view = current.currentBlueprint ? renderBlueprintSummary(current.currentBlueprint) : renderCompactEcosystemOverview(taxonomy);
        ctx.ui?.notify?.(view, "info");
        return;
      }
      if (trimmedArgs === "export") {
        const current = store.getState();
        if (!current.currentBlueprint) {
          ctx.ui?.notify?.(t.exportNoBlueprint, "warning");
          return;
        }
        const outPath = path12.join(cwd, "TOOLFLOW_BLUEPRINT.md");
        fs11.writeFileSync(outPath, renderBlueprintSummary(current.currentBlueprint), "utf-8");
        ctx.ui?.notify?.(t.exportSuccess("TOOLFLOW_BLUEPRINT.md"), "info");
        return;
      }
      if (trimmedArgs === "rollback" || trimmedArgs.startsWith("rollback ")) {
        const targetArg = trimmedArgs.split(/\s+/)[1];
        const parsedTarget = targetArg ? Number.parseInt(targetArg, 10) : void 0;
        const targetIdx = parsedTarget !== void 0 && !Number.isNaN(parsedTarget) ? Math.max(0, parsedTarget - 1) : void 0;
        const rollback = store.rollbackStage(targetIdx);
        if (!rollback.success) {
          ctx.ui?.notify?.(t.rollbackNothing, "warning");
          return;
        }
        const updated = store.getState();
        const stage = updated.currentBlueprint?.stages[updated.currentStageIndex];
        if (stage) store.applyToolScoping(stage.allowedTools, toolHost);
        updateToolFlowStatusBar(ctx, updated, cwd);
        ctx.ui?.notify?.(
          t.rollbackSuccess(
            rollback.rolledBackToStage + 1,
            rollback.restoredFiles.length,
            rollback.deletedFiles.length
          ),
          "info"
        );
        return;
      }
      if (trimmedArgs.startsWith("fast ")) {
        const fastTask = trimmedArgs.slice(5).trim();
        if (fastTask) {
          await runTaskDecisionPipeline(fastTask, taxonomy, ctx, "fast");
          return;
        }
      }
      if (trimmedArgs.length > 0) {
        await runTaskDecisionPipeline(trimmedArgs, taxonomy, ctx);
        return;
      }
      const customUi = asCustomUiHost(ctx);
      if (customUi) {
        const navResult = await openArchitectNavigator(
          customUi,
          taxonomy,
          "",
          void 0,
          void 0,
          asLlmHost(ctx)
        );
        if (navResult?.kind === "prompt_invoke") {
          ctx.ui?.setEditorText?.(`${navResult.command} `);
          ctx.ui?.notify?.(t.promptInserted(navResult.command), "info");
          return;
        }
        if (navResult?.kind === "task_input" && navResult.task.trim()) {
          await runTaskDecisionPipeline(navResult.task.trim(), taxonomy, ctx);
          return;
        }
        if (navResult?.kind !== "custom_ui_unavailable") {
          return;
        }
      }
      if (typeof ctx.ui?.input === "function") {
        const taskInput = await ctx.ui.input("ToolFlow Task", "Describe the engineering task...");
        if (taskInput && taskInput.trim()) {
          await runTaskDecisionPipeline(taskInput.trim(), taxonomy, ctx);
        }
        return;
      }
      ctx.ui?.notify?.(t.noInteractiveUi, "warning");
    }
  });
}

// src/optimizer/blast-radius.ts
import * as path13 from "path";
var WRITE_TOOLS = {
  write: true,
  edit: true,
  create: true,
  delete: true,
  unlink: true,
  replace_file_content: true,
  multi_replace_file_content: true,
  write_to_file: true
};
var DELETE_TOOLS = {
  delete: true,
  unlink: true
};
var CRITICAL_CONFIG_PATTERNS = [
  /^\.env(\..+)?$/i,
  /^\.git([\\/].+)?$/i,
  /^\.npmrc$/i,
  /^package-lock\.json$/i,
  /^pnpm-lock\.yaml$/i,
  /^yarn\.lock$/i,
  /^Cargo\.lock$/i,
  /^bun\.lockb?$/i,
  /^pnpm-workspace\.yaml$/i,
  /^turbo\.json$/i,
  /^lerna\.json$/i,
  /^nx\.json$/i,
  /^(packag|pnpm-l|pnpm-w|yarn|cargo|turbo|lerna|nx|npmrc|bun)~\d+(\.(jso|yam|loc|txt|rc))?$/i,
  /^git~\d+(\..*)?$/i
];
var DESTRUCTIVE_BASH_PATTERNS = [
  {
    pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)*(\/|~|\*|\.\.|\.[\\/]?(\s|$)|\.git)/i,
    reason: "Blocked destructive `rm` targeting root, home, parent, or `.git` directory."
  },
  {
    pattern: /\b(del|erase)\s+\/[sqf]/i,
    reason: "Blocked recursive or forced Windows delete command."
  },
  {
    pattern: /\brmdir\s+\/s/i,
    reason: "Blocked recursive Windows directory deletion (`rmdir /s`)."
  },
  {
    pattern: /\bRemove-Item\b.*(-Recurse|-Force)/i,
    reason: "Blocked recursive or forced PowerShell `Remove-Item`."
  },
  {
    pattern: /\bgit\s+reset\s+--hard\b/i,
    reason: "Blocked `git reset --hard` to prevent accidental loss of uncommitted changes."
  },
  {
    pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/i,
    reason: "Blocked `git clean -f` to protect untracked files."
  },
  {
    pattern: /\bgit\s+push\s+.*(--force|-f)\b/i,
    reason: "Blocked force-push (`git push --force`) to protect remote history."
  },
  {
    pattern: /\bchmod\s+(-R\s+)?777\b/i,
    reason: "Blocked unsafe `chmod 777` permission change."
  },
  {
    pattern: /\b(mkfs|dd\s+if=|format\s+[a-z]:)\b/i,
    reason: "Blocked low-level disk formatting or raw block-device command."
  }
];
var MUTATING_SHELL_TOKENS = /* @__PURE__ */ new Set([
  "rm",
  "mv",
  "cp",
  "truncate",
  "chmod",
  "chown",
  "unlink",
  "del",
  "erase",
  "remove-item",
  "clear-content",
  "set-content",
  "out-file",
  "tee",
  ">",
  ">>"
]);
var BlastRadiusGuard = class {
  allowedScope = /* @__PURE__ */ new Set();
  isScopeEnforced = false;
  configureStageScope(stage, additionalTargets = []) {
    this.allowedScope.clear();
    if (!stage) {
      this.isScopeEnforced = false;
      return;
    }
    if (stage.expectedArtifact) this.allowedScope.add(this.normalizeRel(stage.expectedArtifact));
    for (const art of stage.expectedArtifacts ?? []) {
      if (art) this.allowedScope.add(this.normalizeRel(art));
    }
    for (const pattern of stage.targetPatterns ?? []) {
      if (pattern) this.allowedScope.add(this.normalizeRel(pattern));
    }
    for (const target of additionalTargets) {
      if (target) this.allowedScope.add(this.normalizeRel(target));
    }
    this.isScopeEnforced = this.allowedScope.size > 0;
  }
  grantDynamicScope(filePath) {
    this.allowedScope.add(this.normalizeRel(filePath));
  }
  clearScope() {
    this.allowedScope.clear();
    this.isScopeEnforced = false;
  }
  normalizeRel(p) {
    return p.replace(/\\/g, "/").replace(/^\.\//, "");
  }
  extractTargetPath(input) {
    if (!input) return null;
    for (const key of ["path", "filePath", "TargetFile", "file", "target"]) {
      const val = input[key];
      if (typeof val === "string" && val.length > 0) return val;
    }
    return null;
  }
  extractBashCommand(input) {
    if (!input) return null;
    for (const key of ["command", "cmd", "script"]) {
      const val = input[key];
      if (typeof val === "string" && val.length > 0) return val;
    }
    return null;
  }
  isCriticalFile(relPath) {
    const normalized = this.normalizeRel(relPath);
    const baseName = path13.basename(normalized);
    if (normalized.startsWith(".git/") || normalized === ".git") return true;
    return CRITICAL_CONFIG_PATTERNS.some(
      (pattern) => pattern.test(baseName) || pattern.test(normalized)
    );
  }
  matchesScope(relPath) {
    if (!this.isScopeEnforced) return true;
    const normalized = this.normalizeRel(relPath);
    if (this.allowedScope.has(normalized)) return true;
    for (const pattern of this.allowedScope) {
      if (pattern.endsWith("/*") || pattern.endsWith("/**")) {
        const prefix = pattern.replace(/\/\*+$/, "");
        if (normalized.startsWith(`${prefix}/`) || normalized === prefix) return true;
      } else if (pattern.includes("*")) {
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const regexStr = "^" + escaped.replace(/\*/g, ".*") + "$";
        try {
          if (new RegExp(regexStr).test(normalized)) return true;
        } catch {
        }
      }
    }
    return false;
  }
  verifyToolCall(event, cwd = process.cwd()) {
    const tool = (event.toolName || "").toLowerCase();
    const resolvedCwd = path13.resolve(cwd);
    if (WRITE_TOOLS[tool]) {
      const targetPath = this.extractTargetPath(event.input);
      if (!targetPath) {
        return {
          block: true,
          reason: `[ToolFlow Guard] Blocked "${tool}": no recognizable target path in tool arguments.`
        };
      }
      const absoluteTarget = path13.isAbsolute(targetPath) ? path13.resolve(targetPath) : path13.resolve(resolvedCwd, targetPath);
      const isInsideWorkspace = isPathInsideWorkspace(absoluteTarget, resolvedCwd);
      if (!isInsideWorkspace) {
        return {
          block: true,
          reason: `[ToolFlow Guard] Blocked "${tool}" outside workspace root (${absoluteTarget}).`
        };
      }
      const relPath = this.normalizeRel(path13.relative(resolvedCwd, absoluteTarget));
      if (this.isCriticalFile(relPath)) {
        return {
          block: true,
          reason: `[ToolFlow Guard] Blocked "${tool}" on protected file "${relPath}" (.env, .git, or lockfile).`
        };
      }
      if (DELETE_TOOLS[tool] && this.isScopeEnforced && !this.matchesScope(relPath)) {
        return {
          block: true,
          reason: `[ToolFlow Guard] Blocked "${tool}" on "${relPath}": outside active stage file scope.`
        };
      }
      if (this.isScopeEnforced && !this.matchesScope(relPath)) {
        return {
          block: true,
          reason: `[ToolFlow Guard] Scope violation: "${relPath}" is outside active stage targets (${Array.from(this.allowedScope).join(", ")}).`,
          escalationCandidate: {
            filePath: relPath,
            absolutePath: absoluteTarget
          }
        };
      }
      return { block: false };
    }
    if (tool === "bash" || tool === "run_command" || tool === "powershell") {
      const command = this.extractBashCommand(event.input);
      if (!command) return { block: false };
      for (const rule of DESTRUCTIVE_BASH_PATTERNS) {
        if (rule.pattern.test(command)) {
          return {
            block: true,
            reason: `[ToolFlow Guard] ${rule.reason}`
          };
        }
      }
      for (const match of command.matchAll(/>>?\s*([^\s;&|]+)/g)) {
        const target = match[1].replace(/^['"`]+|['"`]+$/g, "");
        if (!target || target === "&1" || target === "&2" || target.startsWith("&")) continue;
        if (this.isCriticalFile(this.normalizeRel(target))) {
          return {
            block: true,
            reason: `[ToolFlow Guard] Blocked shell redirection into protected file "${target}".`
          };
        }
      }
      const tokens = command.replace(/&&|\|\||;/g, " ; ").split(/\s+/).filter(Boolean);
      let inMutatingCommand = false;
      for (let i = 0; i < tokens.length; i++) {
        const rawTok = tokens[i];
        if (rawTok === ";" || rawTok === "|") {
          inMutatingCommand = false;
          continue;
        }
        const cleaned = rawTok.replace(/^['"`]+|['"`]+$/g, "");
        const lowerTok = cleaned.toLowerCase();
        if (MUTATING_SHELL_TOKENS.has(lowerTok) || lowerTok === "sed" && tokens[i + 1]?.includes("-i")) {
          inMutatingCommand = true;
          continue;
        }
        if (!inMutatingCommand || cleaned.startsWith("-")) continue;
        const baseName = path13.basename(cleaned);
        if (this.isCriticalFile(baseName) || cleaned.includes(".git/") || cleaned.includes(".git\\")) {
          return {
            block: true,
            reason: `[ToolFlow Guard] Blocked shell command mutating protected file "${baseName}".`
          };
        }
      }
    }
    return { block: false };
  }
};

// src/optimizer/context-slimmer.ts
var HEAVY_TOOL_NAMES = {
  browser_probe_interaction: true,
  browser_target_lease: true,
  browser_reload_extension: true,
  subagent: true,
  subagent_supervisor: true,
  bg_wait: true,
  web_search: true,
  source_check: true,
  fetch_content: true,
  image_describe: true
};
var RECENT_MESSAGE_WINDOW = 8;
function isHeavyTool(name) {
  if (!name) return false;
  return Boolean(HEAVY_TOOL_NAMES[name]) || name.startsWith("mcp_") || name.startsWith("browser_");
}
function pruneHeavyProviderTools(event, cwd) {
  if (!event || !Array.isArray(event.tools) || event.tools.length === 0) return;
  const store = getWorkspaceStore(cwd);
  const state = store.getState();
  const isInActiveBlueprint = state.status === "in_progress" && state.currentBlueprint !== null;
  let stageAllowedSet = null;
  if (isInActiveBlueprint && state.currentBlueprint) {
    const activeStage = state.currentBlueprint.stages[state.currentStageIndex];
    if (activeStage) {
      stageAllowedSet = new Set(store.computeStageTools(activeStage.allowedTools || []));
    }
  }
  const originalLength = event.tools.length;
  const prunedTools = event.tools.filter((tool) => {
    const name = typeof tool?.name === "string" ? tool.name : "";
    if (!name) return true;
    if (stageAllowedSet) {
      return stageAllowedSet.has(name) || !isHeavyTool(name);
    }
    return !isHeavyTool(name);
  });
  if (prunedTools.length < originalLength && prunedTools.length > 0) {
    event.tools = prunedTools;
  }
}
function compactBlock(text, toolName) {
  const lineCount = text.split("\n").length;
  const firstLine = text.split("\n")[0]?.slice(0, 80) || "";
  return `[ToolFlow Slimmed History | ${toolName}] (${lineCount} lines, ${text.length} chars). Head: "${firstLine}..." -> Inspect the archived log or re-read the file if needed.`;
}
function slimHistoricalContextMessages(event, cwd) {
  if (!event || !Array.isArray(event.messages) || event.messages.length === 0) return 0;
  const messages = event.messages;
  if (messages.length <= RECENT_MESSAGE_WINDOW) return 0;
  const anchorFiles = loadActiveAnchorFiles(cwd);
  const protectIndex = messages.length - RECENT_MESSAGE_WINDOW;
  let tokensReclaimed = 0;
  for (let i = 0; i < protectIndex; i++) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === "toolResult") {
      const toolName = message.toolName || "tool";
      if (Array.isArray(message.content)) {
        for (const item of message.content) {
          if (!item || typeof item !== "object" || !("type" in item) || !("text" in item)) continue;
          const block = item;
          if (block.type !== "text" || typeof block.text !== "string") continue;
          if (block.text.length <= 600) continue;
          if (isProtectedAnchorText(block.text, anchorFiles)) continue;
          const compact = compactBlock(block.text, toolName);
          tokensReclaimed += Math.max(0, Math.round((block.text.length - compact.length) / 4));
          block.text = compact;
        }
      } else if (typeof message.content === "string" && message.content.length > 600) {
        if (!isProtectedAnchorText(message.content, anchorFiles)) {
          const compact = compactBlock(message.content, toolName);
          tokensReclaimed += Math.max(0, Math.round((message.content.length - compact.length) / 4));
          message.content = compact;
        }
      }
      continue;
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const item of message.content) {
        if (!item || typeof item !== "object" || !("type" in item)) continue;
        const part = item;
        if (part.type !== "toolCall" || !part.arguments) continue;
        if (part.name !== "write" && part.name !== "edit") continue;
        const targetPath = typeof part.arguments.path === "string" ? part.arguments.path : "file";
        for (const key of ["content", "newText"]) {
          const value = part.arguments[key];
          if (typeof value !== "string" || value.length <= 400) continue;
          const summary = `[ToolFlow Slimmed ToolArg] ${part.name} -> ${targetPath} (${value.length} chars)`;
          tokensReclaimed += Math.max(0, Math.round((value.length - summary.length) / 4));
          part.arguments[key] = summary;
        }
      }
    }
  }
  if (tokensReclaimed > 0) {
    getStatsManager(cwd).recordSavings({ tokensSaved: tokensReclaimed });
  }
  return tokensReclaimed;
}

// src/planner/memory.ts
import * as fs12 from "fs";
import * as path14 from "path";
var MAX_LESSONS = 15;
var CodebaseMemoryManager = class {
  memoryFilePath;
  workspaceRoot;
  constructor(cwd = process.cwd()) {
    this.workspaceRoot = path14.resolve(cwd);
    const memoryDir = path14.join(this.workspaceRoot, ".pi", "toolflow", "memory");
    this.memoryFilePath = path14.join(memoryDir, "codebase_lessons.json");
  }
  loadMemory() {
    const defaultStore = {
      version: "1.0.0",
      codebaseId: path14.basename(this.workspaceRoot) || "workspace",
      updatedAt: Date.now(),
      conventions: [],
      lessons: []
    };
    try {
      if (!fs12.existsSync(this.memoryFilePath)) return defaultStore;
      const parsed = JSON.parse(fs12.readFileSync(this.memoryFilePath, "utf-8"));
      if (parsed && typeof parsed === "object" && "lessons" in parsed && Array.isArray(parsed.lessons)) {
        return parsed;
      }
      return defaultStore;
    } catch {
      return defaultStore;
    }
  }
  saveMemory(store) {
    store.updatedAt = Date.now();
    return atomicWriteFileSync(this.memoryFilePath, JSON.stringify(store, null, 2));
  }
  recordLesson(topic, rule, rationale, tags = []) {
    const store = this.loadMemory();
    const existingIdx = store.lessons.findIndex(
      (l) => l.topic.toLowerCase() === topic.toLowerCase() || l.rule === rule
    );
    const newLesson = {
      id: `lesson_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      topic: topic.trim(),
      rule: rule.trim(),
      rationale: rationale.trim(),
      tags: tags.map((t2) => t2.toLowerCase().trim()).filter(Boolean),
      timestamp: Date.now()
    };
    if (existingIdx >= 0) {
      store.lessons[existingIdx] = newLesson;
    } else {
      store.lessons.unshift(newLesson);
    }
    if (store.lessons.length > MAX_LESSONS) {
      store.lessons = store.lessons.slice(0, MAX_LESSONS);
    }
    return this.saveMemory(store);
  }
  recordConvention(convention) {
    const store = this.loadMemory();
    const clean = convention.trim();
    if (!clean || store.conventions.includes(clean)) return true;
    store.conventions.push(clean);
    if (store.conventions.length > 10) {
      store.conventions = store.conventions.slice(-10);
    }
    return this.saveMemory(store);
  }
  getRelevantLessonsPrompt(taskKeywords = []) {
    const store = this.loadMemory();
    if (store.lessons.length === 0 && store.conventions.length === 0) return "";
    const lines = ["--- [Workspace Memory & Conventions] ---"];
    if (store.conventions.length > 0) {
      lines.push("Conventions: " + store.conventions.join(" | "));
    }
    let selectedLessons = store.lessons;
    if (taskKeywords.length > 0) {
      const lowerKw = taskKeywords.map((k) => k.toLowerCase());
      const scored = store.lessons.map((l) => {
        let score = 0;
        const text = `${l.topic} ${l.rule} ${l.tags.join(" ")}`.toLowerCase();
        for (const kw of lowerKw) {
          if (kw.length > 1 && text.includes(kw)) score++;
        }
        return { lesson: l, score };
      });
      scored.sort((a, b) => b.score - a.score || b.lesson.timestamp - a.lesson.timestamp);
      selectedLessons = scored.slice(0, 6).map((s) => s.lesson);
    } else {
      selectedLessons = store.lessons.slice(0, 6);
    }
    for (const l of selectedLessons) {
      const truncated = l.rationale && l.rationale.length > 100 ? `${l.rationale.slice(0, 97)}...` : l.rationale;
      lines.push(`- ${l.topic}: ${l.rule} (${truncated})`);
    }
    lines.push("----------------------------------------");
    return lines.join("\n");
  }
};
var memoryPool = /* @__PURE__ */ new Map();
function getCodebaseMemory(cwd = process.cwd()) {
  const key = normalizeWorkspaceKey(cwd);
  let mgr = memoryPool.get(key);
  if (!mgr) {
    mgr = new CodebaseMemoryManager(cwd);
    memoryPool.set(key, mgr);
  }
  return mgr;
}
function clearAllCodebaseMemories() {
  memoryPool.clear();
}

// src/planner/verifier.ts
import * as fs13 from "fs";
import * as path15 from "path";
import { execSync as execSync3 } from "child_process";
function captureReviewSnapshot(cwd = process.cwd()) {
  try {
    execSync3("git rev-parse --is-inside-work-tree", {
      cwd,
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 2e3
    });
    const headSha = execSync3("git rev-parse --short HEAD", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 2e3
    }).trim();
    const diffStat = execSync3("git diff --stat HEAD", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 3e3
    }).trim();
    let detailedDiff = execSync3("git diff HEAD", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 5e3,
      maxBuffer: 1024 * 1024
    }).trim();
    if (detailedDiff.length > 8e3) {
      detailedDiff = detailedDiff.slice(0, 8e3) + "\n\n... [Diff truncated after 8000 chars; inspect targeted files via `read`] ...";
    }
    const nameStatus = execSync3("git status --porcelain", {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 2e3
    }).trim();
    const changedFiles = nameStatus.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim());
    return {
      headSha,
      diffSummary: diffStat || "(No tracked git diff; inspect untracked/modified files directly)",
      detailedDiff: detailedDiff || "(Clean tracked diff; inspect untracked files if newly created)",
      changedFiles,
      hasChanges: changedFiles.length > 0 || detailedDiff.length > 0
    };
  } catch {
    return {
      diffSummary: "(Non-git workspace; inspect expected artifact paths directly)",
      detailedDiff: "",
      changedFiles: [],
      hasChanges: false
    };
  }
}
function buildReviewIsolationPrompt(stage, taskDescription, cwd = process.cwd(), hasSubagentTool = false) {
  const snapshot = captureReviewSnapshot(cwd);
  const isolatedSystemPrompt = [
    "You are an independent read-only verification auditor.",
    "Review the implementation objectively against the acceptance contract and diff.",
    "Do not edit files during a review stage; report exact file paths, line numbers, and failed assertions."
  ].join("\n");
  const isolatedUserPrompt = [
    `# Isolated Review: ${stage.title}`,
    `Task: ${taskDescription}`,
    `Acceptance Contract: ${stage.artifactContract}`,
    `Changed Files: ${snapshot.changedFiles.length > 0 ? snapshot.changedFiles.join(", ") : "(none detected via git)"}`,
    "## Git Diff Summary",
    snapshot.diffSummary,
    snapshot.detailedDiff ? `## Detailed Diff
\`\`\`diff
${snapshot.detailedDiff}
\`\`\`` : "",
    "Verify tests, build invariants, and edge cases cleanly."
  ].filter(Boolean).join("\n\n");
  return {
    isIsolated: true,
    isolationMode: hasSubagentTool ? "fresh_subagent" : "context_stripped_turn",
    snapshot,
    isolatedSystemPrompt,
    isolatedUserPrompt
  };
}
var REVIEW_FORBIDDEN_TOOLS = {
  write: true,
  edit: true,
  create: true,
  delete: true,
  unlink: true,
  replace_file_content: true,
  multi_replace_file_content: true,
  write_to_file: true
};
var ReviewIsolationGuard = class {
  active = false;
  activate() {
    this.active = true;
  }
  deactivate() {
    this.active = false;
  }
  isActive() {
    return this.active;
  }
  isToolAllowedInReview(toolName) {
    if (!this.active) return true;
    return !REVIEW_FORBIDDEN_TOOLS[(toolName || "").toLowerCase()];
  }
};
function getArtifactPaths(stage) {
  const paths = [];
  if (stage.expectedArtifact) paths.push(stage.expectedArtifact);
  for (const extra of stage.expectedArtifacts ?? []) {
    if (extra && !paths.includes(extra)) paths.push(extra);
  }
  return paths;
}
function verifyStageArtifacts(stage, cwd = process.cwd(), rawStageOutput = "") {
  const store = getWorkspaceStore(cwd);
  const currentState = store.getState();
  const artifactPaths = getArtifactPaths(stage);
  const primaryRelPath = artifactPaths[0] || "";
  const resolvedCwd = path15.resolve(cwd);
  const missingArtifacts = [];
  const verifiedRecords = [];
  const gitInfo = getGitChangedFiles(cwd);
  for (const relPath of artifactPaths) {
    const fullPath = path15.resolve(resolvedCwd, relPath);
    if (!isPathInsideWorkspace(fullPath, resolvedCwd)) {
      missingArtifacts.push(relPath);
      continue;
    }
    if (!fs13.existsSync(fullPath)) {
      missingArtifacts.push(relPath);
      continue;
    }
    try {
      const stat = fs13.statSync(fullPath);
      const sha256 = stat.isFile() ? computeFileSha256(fullPath) : "dir";
      const gitStatus = gitInfo.untrackedFiles.includes(relPath) ? "untracked" : gitInfo.changedFiles.includes(relPath) ? "modified" : "unmodified";
      const record = {
        path: relPath,
        sha256,
        sizeBytes: stat.size,
        verifiedAt: Date.now(),
        gitStatus
      };
      verifiedRecords.push(record);
    } catch {
      missingArtifacts.push(relPath);
    }
  }
  if (missingArtifacts.length > 0) {
    const nextRetry = store.incrementRetry();
    const isCircuitBroken = nextRetry >= 3;
    const missingStr = missingArtifacts.join(", ");
    return {
      valid: false,
      artifactPath: primaryRelPath,
      isPrimaryMissing: missingArtifacts.includes(primaryRelPath),
      missingExpected: missingStr,
      retryCount: nextRetry,
      healingAttempt: nextRetry,
      isCircuitBroken,
      reason: `Expected artifact(s) missing on disk: ${missingStr}`,
      remediationGuidance: `[ToolFlow Stage Gate Failed (${nextRetry}/3)] Missing expected artifact(s): ${missingStr}. Create or update the required files before completing "${stage.title}".`
    };
  }
  const currentSnapshot = currentState.snapshots?.[currentState.currentStageIndex];
  const anyFileModifiedSinceSnapshot = verifiedRecords.some((rec) => {
    const prevHash = currentSnapshot?.fileHashes?.[rec.path];
    return prevHash === void 0 || prevHash !== rec.sha256;
  });
  if (stage.verificationCommands && stage.verificationCommands.length > 0) {
    for (const cmd of stage.verificationCommands) {
      try {
        execSync3(cmd, {
          cwd,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 6e4
        });
      } catch (err) {
        const nextRetry = store.incrementRetry();
        const isCircuitBroken = nextRetry >= 3;
        const stderr = err && typeof err === "object" && "stderr" in err && typeof err.stderr === "string" ? err.stderr : err instanceof Error ? err.message : String(err);
        const stdout = err && typeof err === "object" && "stdout" in err && typeof err.stdout === "string" ? err.stdout : "";
        const combinedErr = `${stdout}
${stderr}`.trim().slice(-1200);
        const exitCode = err && typeof err === "object" && "status" in err && typeof err.status === "number" ? err.status : 1;
        return {
          valid: false,
          artifactPath: primaryRelPath,
          record: verifiedRecords[0],
          verificationCommands: stage.verificationCommands,
          exitCode,
          stderrOutput: combinedErr,
          retryCount: nextRetry,
          healingAttempt: nextRetry,
          isCircuitBroken,
          reason: `Verification command failed (${cmd}) with exit code ${exitCode}`,
          remediationGuidance: `[ToolFlow Verification Failed (${nextRetry}/3)] Command \`${cmd}\` exited with ${exitCode}.
Output excerpt:
${combinedErr}
Fix the failing check and re-verify.`
        };
      }
    }
  } else if (!anyFileModifiedSinceSnapshot && gitInfo.isGit && gitInfo.changedFiles.length === 0 && gitInfo.untrackedFiles.length === 0 && !stage.isReviewStage && rawStageOutput.length > 0) {
    return {
      valid: false,
      artifactPath: primaryRelPath,
      isExploring: true,
      reason: "Turn ended with exploration only and no file updates yet.",
      remediationGuidance: `Continue implementing "${stage.title}" until ${primaryRelPath} reflects the required changes.`
    };
  }
  for (const record of verifiedRecords) {
    store.recordArtifact(record.path, record);
  }
  store.resetRetry();
  if (rawStageOutput) {
    getDehydrator(cwd).dehydrateStageLog({
      stageId: stage.stageId,
      stageTitle: stage.title,
      rawStageOutput,
      verifiedArtifacts: verifiedRecords,
      contractSummary: stage.artifactContract
    });
  }
  return {
    valid: true,
    artifactPath: primaryRelPath,
    record: verifiedRecords[0],
    changedFiles: [...gitInfo.changedFiles, ...gitInfo.untrackedFiles]
  };
}

// src/extension/hooks.ts
var TOOL_HOST_KEYS2 = ["setActiveTools", "getAllTools", "getActiveTools"];
function resolveToolHost2(pi, ctx) {
  const candidate = ctx;
  if (TOOL_HOST_KEYS2.some((key) => typeof candidate?.[key] === "function")) {
    return candidate;
  }
  return pi;
}
function extractToolText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const item of content) {
    if (item && typeof item === "object" && "type" in item && "text" in item) {
      const block = item;
      if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    }
  }
  return parts.join("\n");
}
function registerToolFlowHooks(pi, getActiveCwd, setActiveCwd) {
  const blastGuard = new BlastRadiusGuard();
  const reviewGuard = new ReviewIsolationGuard();
  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd || getActiveCwd();
    setActiveCwd(cwd);
    const toolHost = resolveToolHost2(pi, ctx);
    const store = getWorkspaceStore(cwd);
    store.load();
    store.recordInitialActiveTools(toolHost);
    const state = store.getState();
    const activeStage = state.status === "in_progress" && state.currentBlueprint ? state.currentBlueprint.stages[state.currentStageIndex] : void 0;
    if (activeStage) {
      store.applyToolScoping(activeStage.allowedTools, toolHost);
      blastGuard.configureStageScope(activeStage, state.dynamicTargetFiles ?? []);
      if (activeStage.isReviewStage) reviewGuard.activate();
      else reviewGuard.deactivate();
    } else {
      blastGuard.clearScope();
      reviewGuard.deactivate();
    }
    updateToolFlowStatusBar(ctx, state, cwd);
  });
  pi.on("context", async (event, ctx) => {
    const cwd = ctx.cwd || getActiveCwd();
    setActiveCwd(cwd);
    const tokensReclaimed = slimHistoricalContextMessages(
      event,
      cwd
    );
    if (tokensReclaimed > 0) {
      updateToolFlowStatusBar(ctx, getWorkspaceStore(cwd).getState(), cwd);
      ctx.ui?.notify?.(t.compactNotice(tokensReclaimed), "info");
    }
    return { messages: event.messages };
  });
  pi.on("before_agent_start", async (event, ctx) => {
    const cwd = ctx.cwd || getActiveCwd();
    setActiveCwd(cwd);
    const store = getWorkspaceStore(cwd);
    const state = store.getState();
    const keywords = state.currentBlueprint && state.currentBlueprint.task ? state.currentBlueprint.task.split(/\s+/).slice(0, 6) : [];
    const memoryPrompt = getCodebaseMemory(cwd).getRelevantLessonsPrompt(keywords);
    const activeStage = state.status === "in_progress" && state.currentBlueprint ? state.currentBlueprint.stages[state.currentStageIndex] : void 0;
    if (!activeStage || !state.currentBlueprint) {
      return memoryPrompt ? { systemPrompt: `${event.systemPrompt}

${memoryPrompt}` } : void 0;
    }
    store.applyToolScoping(activeStage.allowedTools, resolveToolHost2(pi, ctx));
    blastGuard.configureStageScope(activeStage, state.dynamicTargetFiles ?? []);
    if (activeStage.isReviewStage) {
      reviewGuard.activate();
      const isolation = buildReviewIsolationPrompt(
        activeStage,
        state.currentBlueprint.task,
        cwd,
        false
      );
      return {
        systemPrompt: [event.systemPrompt, isolation.isolatedSystemPrompt, memoryPrompt].filter(Boolean).join("\n\n")
      };
    }
    reviewGuard.deactivate();
    const pipelineCard = renderExecutionPipelineCard({
      blueprintId: state.currentBlueprint.blueprintId,
      task: state.currentBlueprint.task,
      currentStageIndex: state.currentStageIndex,
      stages: state.currentBlueprint.stages,
      verifiedArtifactCount: Object.keys(state.artifactLedger).length
    });
    return {
      systemPrompt: [event.systemPrompt, pipelineCard, memoryPrompt].filter(Boolean).join("\n\n")
    };
  });
  pi.on("tool_call", async (event, ctx) => {
    const cwd = ctx.cwd || getActiveCwd();
    setActiveCwd(cwd);
    const store = getWorkspaceStore(cwd);
    const state = store.getState();
    const input = event.input;
    if (state.status === "in_progress" && state.currentBlueprint) {
      if (reviewGuard.isActive() && !reviewGuard.isToolAllowedInReview(event.toolName)) {
        return {
          block: true,
          reason: `[ToolFlow Review Isolation] Blocked "${event.toolName}" during read-only review stage.`
        };
      }
    }
    const securityResult = blastGuard.verifyToolCall({ toolName: event.toolName, input }, cwd);
    if (securityResult.block) {
      const escalation = securityResult.escalationCandidate;
      if (escalation && state.status === "in_progress" && ctx.ui?.confirm) {
        const allow = await ctx.ui.confirm(
          "ToolFlow Scope Check",
          `Allow "${event.toolName}" to write "${escalation.filePath}" outside current stage scope?`
        );
        if (allow) {
          blastGuard.grantDynamicScope(escalation.filePath);
          return void 0;
        }
      }
      getStatsManager(cwd).recordSavings({ blastRadiusBlocks: 1 });
      return { block: true, reason: securityResult.reason };
    }
    if (event.toolName === "read" && typeof input.path === "string") {
      const check = getReadCache(cwd).checkRead(
        {
          path: input.path,
          offset: typeof input.offset === "number" ? input.offset : void 0,
          limit: typeof input.limit === "number" ? input.limit : void 0
        },
        false
      );
      if (check.isDuplicate && check.notice) {
        updateToolFlowStatusBar(ctx, state, cwd);
        return { block: true, reason: check.notice };
      }
    }
    return void 0;
  });
  pi.on("tool_result", async (event, ctx) => {
    const cwd = ctx.cwd || getActiveCwd();
    const input = event.input;
    const targetPath = typeof input.path === "string" ? input.path : void 0;
    const readCache = getReadCache(cwd);
    if (targetPath) {
      if (event.toolName === "read" && !event.isError) {
        readCache.recordRead({
          path: targetPath,
          offset: typeof input.offset === "number" ? input.offset : void 0,
          limit: typeof input.limit === "number" ? input.limit : void 0
        });
      } else if (event.toolName === "write" || event.toolName === "edit") {
        if (event.isError) readCache.markEditFailure(targetPath);
        else readCache.markFileDirty(targetPath);
      }
    }
    if (event.toolName === "bash" || event.toolName === "powershell") {
      readCache.markWorkspaceDirtyByCommand();
    }
    if (event.toolName === "bash" || event.toolName === "powershell" || event.toolName === "grep" || event.toolName === "find" || event.toolName === "ls") {
      const store = getWorkspaceStore(cwd);
      const state = store.getState();
      const stageId = state.currentBlueprint?.stages[state.currentStageIndex]?.stageId ?? "default";
      const dehydrated = getDehydrator(cwd).dehydrateToolOutput(
        event.toolName,
        extractToolText(event.content),
        event.isError,
        stageId
      );
      if (dehydrated.dehydrated) {
        updateToolFlowStatusBar(ctx, state, cwd);
        if (ctx.ui?.notify && dehydrated.tokensSaved > 0) {
          ctx.ui.notify(
            t.toolOutputDehydrated(event.toolName, dehydrated.originalLines, dehydrated.tokensSaved),
            "info"
          );
        }
        return { content: [{ type: "text", text: dehydrated.text }] };
      }
    }
    return void 0;
  });
  pi.on("turn_end", async (event, ctx) => {
    const cwd = ctx.cwd || getActiveCwd();
    const store = getWorkspaceStore(cwd);
    store.load();
    const state = store.getState();
    if (state.status !== "in_progress" || !state.currentBlueprint) {
      updateToolFlowStatusBar(ctx, state, cwd);
      return;
    }
    if (Array.isArray(event.toolResults) && event.toolResults.length > 0) {
      updateToolFlowStatusBar(ctx, state, cwd);
      return;
    }
    const activeStage = state.currentBlueprint.stages[state.currentStageIndex];
    if (!activeStage) return;
    const message = event.message;
    const rawOutput = message && "content" in message ? extractToolText(message.content) : "";
    const verification = verifyStageArtifacts(activeStage, cwd, rawOutput);
    if (verification.valid) {
      if (ctx.ui?.notify && verification.record) {
        ctx.ui.notify(
          t.stageVerified(
            state.currentStageIndex + 1,
            verification.artifactPath,
            verification.record.sha256.slice(0, 8)
          ),
          "info"
        );
      }
      const hasMoreStages = store.advanceStage();
      const nextState = store.getState();
      if (hasMoreStages && nextState.currentBlueprint) {
        const nextStage = nextState.currentBlueprint.stages[nextState.currentStageIndex];
        if (nextStage) {
          store.applyToolScoping(nextStage.allowedTools, resolveToolHost2(pi, ctx));
          blastGuard.configureStageScope(nextStage, nextState.dynamicTargetFiles ?? []);
          if (nextStage.isReviewStage) reviewGuard.activate();
          else reviewGuard.deactivate();
          updateToolFlowStatusBar(ctx, nextState, cwd);
          pi.sendUserMessage(
            generateStageActionPrompt(nextStage, nextState.currentBlueprint, nextState.currentStageIndex),
            { deliverAs: "followUp" }
          );
        }
        return;
      }
      if (nextState.currentBlueprint) {
        store.restoreInitialActiveTools(resolveToolHost2(pi, ctx));
        blastGuard.clearScope();
        reviewGuard.deactivate();
        updateToolFlowStatusBar(ctx, nextState, cwd);
        const summary = getStatsManager(cwd).getSavingsSummary();
        const durationSec = Math.max(
          1,
          Math.round((Date.now() - nextState.currentBlueprint.createdAt) / 1e3)
        );
        const receipt = renderValueReceipt({
          task: nextState.currentBlueprint.task,
          blueprintId: nextState.currentBlueprint.blueprintId,
          stageCount: nextState.currentBlueprint.stages.length,
          verifiedFiles: Object.keys(nextState.artifactLedger),
          totalDurationSec: durationSec,
          tokenSavingsRatio: `${summary.estimatedRatioPercent}%`
        });
        getCodebaseMemory(cwd).recordLesson(
          nextState.currentBlueprint.task.slice(0, 60),
          `Completed ${nextState.currentBlueprint.stages.length}-stage workflow cleanly.`,
          `Verified artifacts: ${Object.keys(nextState.artifactLedger).slice(0, 3).join(", ")}`,
          ["workflow", nextState.currentBlueprint.projectFingerprint?.projectType ?? "general"]
        );
        ctx.ui?.notify?.(
          `${t.allCompleted(nextState.currentBlueprint.task)}

${receipt.join("\n")}`,
          "info"
        );
      }
      return;
    }
    if (verification.isExploring) {
      pi.sendUserMessage(verification.remediationGuidance || "Continue executing the current stage.", {
        deliverAs: "followUp"
      });
      return;
    }
    if (verification.isCircuitBroken) {
      blastGuard.clearScope();
      reviewGuard.deactivate();
      updateToolFlowStatusBar(ctx, store.getState(), cwd);
      ctx.ui?.notify?.(
        t.circuitBroken(state.currentStageIndex + 1, verification.artifactPath),
        "error"
      );
      return;
    }
    if (verification.remediationGuidance) {
      pi.sendUserMessage(verification.remediationGuidance, { deliverAs: "followUp" });
    }
  });
}

// src/extension/inspect-tool.ts
import * as fs14 from "fs";
import * as path16 from "path";
import { Type } from "@sinclair/typebox";
function isSafeRunLog(candidate, workDir) {
  if (!candidate || typeof candidate !== "string") return false;
  try {
    const resolvedWorkDir = path16.resolve(workDir);
    const runsRoot = path16.join(resolvedWorkDir, ".pi", "toolflow", "runs");
    if (!fs14.existsSync(runsRoot)) return false;
    const realRunsRoot = fs14.realpathSync(runsRoot);
    const targetPath = path16.isAbsolute(candidate) ? candidate : path16.resolve(resolvedWorkDir, candidate);
    if (!fs14.existsSync(targetPath)) return false;
    const realTarget = fs14.realpathSync(targetPath);
    const prefix = realRunsRoot.endsWith(path16.sep) ? realRunsRoot : realRunsRoot + path16.sep;
    if (process.platform === "win32") {
      return realTarget.toLowerCase().startsWith(prefix.toLowerCase());
    }
    return realTarget.startsWith(prefix);
  } catch {
    return false;
  }
}
function registerToolFlowInspectTool(pi, getActiveCwd) {
  if (typeof pi.registerTool !== "function") return;
  pi.registerTool({
    name: "toolflow_inspect",
    label: "ToolFlow Log Inspector",
    description: "Inspect dehydrated full command/tool logs under `.pi/toolflow/runs/` without polluting main context.",
    parameters: Type.Object({
      file: Type.Optional(
        Type.String({
          description: "Log file path inside `.pi/toolflow/runs/` (defaults to the latest dehydrated log)."
        })
      ),
      mode: Type.Optional(
        Type.Union([Type.Literal("head"), Type.Literal("tail"), Type.Literal("grep"), Type.Literal("range")], {
          description: "Inspection mode: tail (default), head, grep, or range."
        })
      ),
      pattern: Type.Optional(
        Type.String({ description: "Regex or plain-text pattern when mode='grep'." })
      ),
      startLine: Type.Optional(
        Type.Number({ description: "1-based start line when mode='range' (default 1)." })
      ),
      lineCount: Type.Optional(
        Type.Number({ description: "Number of lines to return (default 60, max 200)." })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const workDir = ctx?.cwd || getActiveCwd();
      const candidate = params.file || ContextDehydrator.getLatestLogPath(workDir);
      if (!isSafeRunLog(candidate, workDir)) {
        return {
          content: [
            {
              type: "text",
              text: `[ToolFlow Inspector] Log file unavailable or outside \`.pi/toolflow/runs/\`: ${candidate || "(none)"}`
            }
          ],
          details: {}
        };
      }
      const fullPath = path16.isAbsolute(candidate) ? candidate : path16.resolve(workDir, candidate);
      const raw = fs14.readFileSync(fullPath, "utf-8");
      const lines = raw.split(/\r?\n/);
      const mode = params.mode || "tail";
      const limit = Math.min(200, Math.max(1, params.lineCount ?? 60));
      let selected = [];
      let headerInfo = "";
      if (mode === "head") {
        selected = lines.slice(0, limit);
        headerInfo = `head 1..${selected.length} / ${lines.length}`;
      } else if (mode === "tail") {
        const start = Math.max(0, lines.length - limit);
        selected = lines.slice(start);
        headerInfo = `tail ${start + 1}..${lines.length} / ${lines.length}`;
      } else if (mode === "range") {
        const start = Math.max(1, params.startLine ?? 1);
        selected = lines.slice(start - 1, start - 1 + limit).map((l, idx) => `${start + idx}: ${l}`);
        headerInfo = `range ${start}..${Math.min(lines.length, start - 1 + limit)} / ${lines.length}`;
      } else {
        const query = params.pattern || "";
        if (!query) {
          return {
            content: [{ type: "text", text: "[ToolFlow Inspector] Missing `pattern` for grep mode." }],
            details: {}
          };
        }
        let regex = null;
        try {
          regex = new RegExp(query, "i");
        } catch {
          regex = null;
        }
        const matched = [];
        for (let i = 0; i < lines.length; i++) {
          const hit = regex ? regex.test(lines[i]) : lines[i].includes(query);
          if (hit) {
            matched.push(`${i + 1}: ${lines[i]}`);
            if (matched.length >= limit) break;
          }
        }
        selected = matched.length > 0 ? matched : [`(No matches for "${query}")`];
        headerInfo = `grep "${query}" (${matched.length} matches in ${lines.length} lines)`;
      }
      const rel = path16.relative(workDir, fullPath).replace(/\\/g, "/");
      return {
        content: [
          {
            type: "text",
            text: `[ToolFlow Inspector | ${rel} | ${headerInfo}]

${selected.join("\n")}`
          }
        ],
        details: { file: rel, totalLines: lines.length }
      };
    }
  });
}

// src/index.ts
function toolflow(pi) {
  let activeWorkspaceCwd = process.cwd();
  const getActiveCwd = () => activeWorkspaceCwd;
  const setActiveCwd = (cwd) => {
    if (cwd) activeWorkspaceCwd = cwd;
  };
  registerToolFlowInspectTool(pi, getActiveCwd);
  registerToolFlowCommand(pi, getActiveCwd, setActiveCwd);
  registerToolFlowHooks(pi, getActiveCwd, setActiveCwd);
}
export {
  BASELINE_TOOLS,
  BlastRadiusGuard,
  CodebaseMemoryManager,
  ContextDehydrator,
  DeepSkillsDistiller,
  EcosystemRadar,
  GracefulDegradationMatrix,
  McpMethodRegistry,
  PromptsManager,
  ReadCacheManager,
  ReviewIsolationGuard,
  STATS_COMPACT_BYTES,
  StatsManager,
  WorkspaceStateStore,
  atomicWriteFileSync,
  bindDeepEcosystemToStage,
  buildReviewIsolationPrompt,
  callExtensionLlm,
  captureReviewSnapshot,
  cleanName,
  cleanupStaleTempFiles,
  clearAllCodebaseMemories,
  clearAllDehydrators,
  clearAllReadCaches,
  clearAllStatsManagers,
  clearAllWorkspaceStores,
  computeFileSha256,
  createEmptySessionState,
  deepAnalyzeTaxonomyWithLLM,
  toolflow as default,
  diagnoseTaskExecutionMode,
  diagnoseTaskRequirements,
  discoverEcosystemTaxonomy,
  emptyStats,
  extractSymbolOutline,
  extractValidJsonObject,
  formatActiveAnchorHint,
  generateABTradeOffMatrix,
  generateCapabilityCompactDigest,
  generateStageActionPrompt,
  generateUniversalMetaSlots,
  getCodebaseMemory,
  getDehydrator,
  getGitChangedFiles,
  getReadCache,
  getStatsManager,
  getWorkspaceStore,
  inferArtifactProfile,
  isHeavyTool,
  isPathInsideWorkspace,
  isProtectedAnchorText,
  loadActiveAnchorFiles,
  loadOrRefreshTaxonomy,
  normalizeWorkspaceKey,
  openArchitectNavigator,
  padToVisibleWidth,
  planDAGWaves,
  pruneHeavyProviderTools,
  reflectEnvironmentContext,
  renderBlueprintSummary,
  renderCJKSafeInputBox,
  renderCompactEcosystemOverview,
  renderExecutionPipelineCard,
  renderSavingsLedger,
  renderUnicodeDAG,
  renderValueReceipt,
  sleepSync,
  slimHistoricalContextMessages,
  sniffProjectFingerprint,
  synthesizeBlueprint,
  synthesizeBlueprintPlanWithLLM,
  t,
  verifyStageArtifacts
};
