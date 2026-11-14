import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFileSync, normalizeWorkspaceKey } from "../core/atomic-fs.js";

export interface ArchitecturalLesson {
  id: string;
  topic: string;
  rule: string;
  rationale: string;
  tags: string[];
  timestamp: number;
}

export interface CodebaseMemoryStore {
  version: "1.0.0";
  codebaseId: string;
  updatedAt: number;
  conventions: string[];
  lessons: ArchitecturalLesson[];
}

const MAX_LESSONS = 15;

export class CodebaseMemoryManager {
  private readonly memoryFilePath: string;
  private readonly workspaceRoot: string;

  constructor(cwd: string = process.cwd()) {
    this.workspaceRoot = path.resolve(cwd);
    const memoryDir = path.join(this.workspaceRoot, ".pi", "toolflow", "memory");
    this.memoryFilePath = path.join(memoryDir, "codebase_lessons.json");
  }

  public loadMemory(): CodebaseMemoryStore {
    const defaultStore: CodebaseMemoryStore = {
      version: "1.0.0",
      codebaseId: path.basename(this.workspaceRoot) || "workspace",
      updatedAt: Date.now(),
      conventions: [],
      lessons: [],
    };
    try {
      if (!fs.existsSync(this.memoryFilePath)) return defaultStore;
      const parsed: unknown = JSON.parse(fs.readFileSync(this.memoryFilePath, "utf-8"));
      if (parsed && typeof parsed === "object" && "lessons" in parsed && Array.isArray(parsed.lessons)) {
        return parsed as CodebaseMemoryStore;
      }
      return defaultStore;
    } catch {
      return defaultStore;
    }
  }

  private saveMemory(store: CodebaseMemoryStore): boolean {
    store.updatedAt = Date.now();
    return atomicWriteFileSync(this.memoryFilePath, JSON.stringify(store, null, 2));
  }

  public recordLesson(topic: string, rule: string, rationale: string, tags: string[] = []): boolean {
    const store = this.loadMemory();
    const existingIdx = store.lessons.findIndex(
      l => l.topic.toLowerCase() === topic.toLowerCase() || l.rule === rule
    );

    const newLesson: ArchitecturalLesson = {
      id: `lesson_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      topic: topic.trim(),
      rule: rule.trim(),
      rationale: rationale.trim(),
      tags: tags.map(t => t.toLowerCase().trim()).filter(Boolean),
      timestamp: Date.now(),
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

  public recordConvention(convention: string): boolean {
    const store = this.loadMemory();
    const clean = convention.trim();
    if (!clean || store.conventions.includes(clean)) return true;
    store.conventions.push(clean);
    if (store.conventions.length > 10) {
      store.conventions = store.conventions.slice(-10);
    }
    return this.saveMemory(store);
  }

  public getRelevantLessonsPrompt(taskKeywords: string[] = []): string {
    const store = this.loadMemory();
    if (store.lessons.length === 0 && store.conventions.length === 0) return "";

    const lines: string[] = ["--- [Workspace Memory & Conventions] ---"];
    if (store.conventions.length > 0) {
      lines.push("Conventions: " + store.conventions.join(" | "));
    }

    let selectedLessons = store.lessons;
    if (taskKeywords.length > 0) {
      const lowerKw = taskKeywords.map(k => k.toLowerCase());
      const scored = store.lessons.map(l => {
        let score = 0;
        const text = `${l.topic} ${l.rule} ${l.tags.join(" ")}`.toLowerCase();
        for (const kw of lowerKw) {
          if (kw.length > 1 && text.includes(kw)) score++;
        }
        return { lesson: l, score };
      });
      scored.sort((a, b) => b.score - a.score || b.lesson.timestamp - a.lesson.timestamp);
      selectedLessons = scored.slice(0, 6).map(s => s.lesson);
    } else {
      selectedLessons = store.lessons.slice(0, 6);
    }

    for (const l of selectedLessons) {
      const truncated =
        l.rationale && l.rationale.length > 100
          ? `${l.rationale.slice(0, 97)}...`
          : l.rationale;
      lines.push(`- ${l.topic}: ${l.rule} (${truncated})`);
    }
    lines.push("----------------------------------------");
    return lines.join("\n");
  }
}

const memoryPool = new Map<string, CodebaseMemoryManager>();

export function getCodebaseMemory(cwd: string = process.cwd()): CodebaseMemoryManager {
  const key = normalizeWorkspaceKey(cwd);
  let mgr = memoryPool.get(key);
  if (!mgr) {
    mgr = new CodebaseMemoryManager(cwd);
    memoryPool.set(key, mgr);
  }
  return mgr;
}

export function clearAllCodebaseMemories(): void {
  memoryPool.clear();
}
