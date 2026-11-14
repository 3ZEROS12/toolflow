import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { normalizeWorkspaceKey } from "../core/atomic-fs.js";

export interface AnchorStateEntry {
  id?: string | number;
  title?: string;
  cwd?: string;
  project?: string;
  status?: string;
  files?: unknown;
}

interface AnchorStateFile {
  anchors?: AnchorStateEntry[];
}

function anchorStatePath(): string {
  const dir = process.env.ANCHOR_DIR || path.join(os.homedir(), ".anchor");
  return path.join(dir, "state.json");
}

function isTestEnvironment(): boolean {
  return Boolean(
    process.env.NODE_TEST_CONTEXT ||
      process.env.NODE_ENV === "test" ||
      process.env.VITEST ||
      (process.argv && process.argv.some(arg => /test/i.test(arg)))
  );
}

function readAnchorState(): AnchorStateFile | null {
  try {
    const file = anchorStatePath();
    if (!fs.existsSync(file)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as AnchorStateFile;
  } catch {
    return null;
  }
}

function matchesWorkspace(anchor: AnchorStateEntry, cwd: string): boolean {
  const target = normalizeWorkspaceKey(cwd);
  const targetBase = path.basename(path.resolve(cwd)).toLowerCase();
  const anchorCwd = typeof anchor.cwd === "string" && anchor.cwd ? normalizeWorkspaceKey(anchor.cwd) : "";
  const project = typeof anchor.project === "string" ? anchor.project.toLowerCase() : "";

  const matchesCwd = Boolean(
    anchorCwd &&
      (anchorCwd === target || anchorCwd.startsWith(`${target}/`) || target.startsWith(`${anchorCwd}/`))
  );
  const matchesProject = Boolean(
    project && (project === "global" || project === targetBase || project === target)
  );

  if (!anchorCwd && !project) return true;
  return matchesCwd || matchesProject;
}

/**
 * Returns the file paths and titles of active anchors bound to the workspace.
 * Follows the Playbook 7 handshake (anchor -> toolflow): tolerant of missing or partial state.
 */
export function loadActiveAnchorFiles(cwd: string = process.cwd()): string[] {
  if (isTestEnvironment() && !process.env.ANCHOR_DIR) return [];

  const state = readAnchorState();
  if (!state || !Array.isArray(state.anchors)) return [];

  const collected = new Set<string>();
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

/**
 * Builds the compact "Active Anchors" line injected into planning prompts.
 * Returns an empty string when no anchor matches the workspace.
 */
export function formatActiveAnchorHint(cwd: string = process.cwd()): string {
  if (isTestEnvironment() && !process.env.ANCHOR_DIR) return "";

  const state = readAnchorState();
  if (!state || !Array.isArray(state.anchors)) return "";

  const active = state.anchors.filter(
    anchor => anchor && anchor.status === "active" && matchesWorkspace(anchor, cwd)
  );
  if (active.length === 0) return "";

  const rows = active.map(anchor => {
    const id = anchor.id ?? "?";
    const title = typeof anchor.title === "string" && anchor.title.trim() ? anchor.title.trim() : "untitled";
    const files =
      Array.isArray(anchor.files) && anchor.files.length > 0
        ? anchor.files.filter((file): file is string => typeof file === "string").join(", ")
        : "all workspace files";
    return `[#${id}] "${title}" (Files: ${files})`;
  });

  return `\nActive Anchors: ${rows.join("; ")}`;
}

const PROTECTED_MARKERS: readonly string[] = [
  "[ARCH_CONTRACT]",
  "[BLUEPRINT_ESTABLISHED]",
  "[FATAL_ERROR]",
  "[Active Anchor Focus]",
  "<sticky-notes",
  "ToolFlow Blueprint",
  "ToolFlow Slimmed History",
  "ToolFlow Dehydrated Output",
];

/**
 * True when a message must never be folded: machine contracts, anchor focus, or anchored files.
 */
export function isProtectedAnchorText(text: string, anchorFiles: string[] = []): boolean {
  if (!text || typeof text !== "string") return false;
  if (PROTECTED_MARKERS.some(marker => text.includes(marker))) return true;
  return anchorFiles.some(file => Boolean(file) && text.includes(file));
}
