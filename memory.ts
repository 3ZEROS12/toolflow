import * as fs from "node:fs";
import * as path from "node:path";

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
  private memoryFilePath: string;
  private workspaceRoot: string;

  constructor(workspaceRoot: string = process.cwd()) {
    this.workspaceRoot = workspaceRoot;
    const memoryDir = path.join(workspaceRoot, ".pi", "toolflow", "memory");
    try {
      fs.mkdirSync(memoryDir, { recursive: true });
    } catch (_) {}
    this.memoryFilePath = path.join(memoryDir, "architecture_memory.json");
  }

  public loadMemory(): CodebaseMemoryStore {
    if (fs.existsSync(this.memoryFilePath)) {
      try {
        const raw = fs.readFileSync(this.memoryFilePath, "utf-8");
        const parsed = JSON.parse(raw) as CodebaseMemoryStore;
        if (parsed && Array.isArray(parsed.lessons)) {
          return parsed;
        }
      } catch (_) {}
    }
    return {
      version: "1.0.0",
      codebaseId: path.basename(this.workspaceRoot),
      updatedAt: Date.now(),
      conventions: [],
      lessons: []
    };
  }

  private safeWriteStore(store: CodebaseMemoryStore): void {
    const tempPath = `${this.memoryFilePath}.tmp.${process.pid}.${Date.now()}`;
    try {
      const parentDir = path.dirname(this.memoryFilePath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }
      fs.writeFileSync(tempPath, JSON.stringify(store, null, 2), "utf-8");

      let renamed = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.renameSync(tempPath, this.memoryFilePath);
          renamed = true;
          break;
        } catch (_) {
          const start = Date.now();
          while (Date.now() - start < 10) {}
        }
      }

      if (!renamed) {
        try {
          fs.copyFileSync(tempPath, this.memoryFilePath);
          renamed = true;
        } catch (_) {}
      }
    } catch (_) {
      try {
        fs.writeFileSync(this.memoryFilePath, JSON.stringify(store, null, 2), "utf-8");
      } catch (_) {}
    } finally {
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch (_) {}
    }
  }

  public recordLesson(topic: string, rule: string, rationale: string, tags: string[] = []): void {
    const store = this.loadMemory();
    const existingIndex = store.lessons.findIndex(l => l.topic === topic || l.rule === rule);
    const newLesson: ArchitecturalLesson = {
      id: "lesson_" + Date.now().toString(36),
      topic,
      rule,
      rationale,
      tags,
      timestamp: Date.now()
    };

    if (existingIndex >= 0) {
      store.lessons[existingIndex] = newLesson;
    } else {
      store.lessons.push(newLesson);
    }

    // 滑动窗口控制：严控在最新 MAX_LESSONS (15) 条以内，杜绝 Token 爆炸
    if (store.lessons.length > MAX_LESSONS) {
      store.lessons = store.lessons.slice(-MAX_LESSONS);
    }

    store.updatedAt = Date.now();
    this.safeWriteStore(store);
  }

  public recordConvention(convention: string): void {
    const store = this.loadMemory();
    if (!store.conventions.includes(convention)) {
      store.conventions.push(convention);
      if (store.conventions.length > 10) {
        store.conventions = store.conventions.slice(-10);
      }
      store.updatedAt = Date.now();
      this.safeWriteStore(store);
    }
  }

  public getPromptContextInjection(): string {
    const store = this.loadMemory();
    if (store.lessons.length === 0 && store.conventions.length === 0) {
      return "";
    }
    const lines = ["\n[Codebase 历史架构与避坑记忆 (Memory Directives)]:"];
    store.conventions.forEach(c => lines.push("- 仓库规范: " + c));
    store.lessons.slice(-MAX_LESSONS).forEach(l => {
      const truncatedRationale = l.rationale && l.rationale.length > 100 ? `${l.rationale.slice(0, 97)}...` : l.rationale;
      lines.push("- " + l.topic + ": " + l.rule + " (" + truncatedRationale + ")");
    });
    let result = lines.join("\n");
    if (result.length > 1500) {
      result = result.slice(0, 1490) + "\n...";
    }
    return result;
  }
}
