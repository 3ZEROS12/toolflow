import * as fs from "node:fs";
import * as path from "node:path";

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

/**
 * Normalizes a workspace root path into a stable map key.
 * On Windows, lowercases the resolved path to avoid drive-letter case fragmentation.
 */
export function normalizeWorkspaceKey(cwd: string = process.cwd()): string {
  const resolved = path.resolve(cwd || process.cwd());
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Checks whether `targetPath` resolves inside `workspaceRoot` (case-insensitive on Windows).
 */
export function isPathInsideWorkspace(targetPath: string, workspaceRoot: string = process.cwd()): boolean {
  const normRoot = normalizeWorkspaceKey(workspaceRoot);
  const normTarget = normalizeWorkspaceKey(
    path.isAbsolute(targetPath) ? targetPath : path.resolve(workspaceRoot, targetPath)
  );
  return normTarget === normRoot || normTarget.startsWith(normRoot + path.sep);
}
/**
 * Non-spinning synchronous sleep using Atomics.wait.
 */
export function sleepSync(ms: number): void {
  if (ms <= 0) return;
  try {
    Atomics.wait(sleepBuffer, 0, 0, Math.floor(ms));
  } catch {
    // Fallback only if SharedArrayBuffer Atomics.wait is restricted in an environment
    const end = Date.now() + ms;
    while (Date.now() < end) {}
  }
}

/**
 * Atomically writes UTF-8 content to `filePath` via temp-file + rename with Windows lock backoff.
 */
export function atomicWriteFileSync(
  filePath: string,
  content: string,
  options: { backup?: boolean } = {}
): boolean {
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
      } catch (err: unknown) {
        const code =
          err && typeof err === "object" && "code" in err && typeof err.code === "string"
            ? err.code
            : undefined;
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
          // Best-effort backup
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
      // Best-effort temp cleanup
    }
  }

  return success;
}

/**
 * Removes leftover atomic temp files matching any of the given filename prefixes.
 */
export function cleanupStaleTempFiles(dirPath: string, prefixes: string[]): void {
  try {
    if (!fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath);
    for (const entry of entries) {
      if (prefixes.some(prefix => entry.startsWith(prefix))) {
        try {
          fs.unlinkSync(path.join(dirPath, entry));
        } catch {
          // Ignore locked temp files
        }
      }
    }
  } catch {
    // Ignore unreadable directories
  }
}
